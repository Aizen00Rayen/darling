import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scheduled: (() => unknown)[] = [];
const afterMock = vi.fn((cb: () => unknown) => void scheduled.push(cb));
vi.mock('next/server', () => ({ after: (cb: () => unknown) => afterMock(cb) }));

import { runInBackground, sendMailInBackground, settleBackgroundWork } from './outbox';

beforeEach(() => {
  scheduled.length = 0;
  afterMock.mockClear();
  afterMock.mockImplementation((cb) => void scheduled.push(cb));
});
afterEach(async () => {
  for (const cb of scheduled.splice(0)) await cb();
  await settleBackgroundWork();
  vi.restoreAllMocks();
});

describe('background work uses Next after()', () => {
  it('schedules with after() and runs nothing until Next invokes the callback', async () => {
    const work = vi.fn();
    runInBackground('x.failed', work);
    expect(afterMock).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    expect(work).not.toHaveBeenCalled();
    await scheduled[0]!();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('settleBackgroundWork waits for scheduled work, including work scheduled by work', async () => {
    const order: string[] = [];
    runInBackground('outer', async () => {
      order.push('outer');
      runInBackground('inner', () => void order.push('inner'));
    });
    const settled = settleBackgroundWork().then(() => order.push('settled'));
    await scheduled.shift()!();
    await scheduled.shift()!();
    await settled;
    expect(order).toEqual(['outer', 'inner', 'settled']);
  });

  it('sendMailInBackground sends through the mailer after the callback, and logs failures without the message', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => (lines.push(String(c)), true)) as never);
    const send = vi.fn(async () => {
      throw Object.assign(new Error('550 nobody@example.test rejected'), { code: 'EENVELOPE' });
    });
    sendMailInBackground({ send }, { to: 'nobody@example.test', subject: 's', text: 't', html: 'h' });
    expect(send).not.toHaveBeenCalled();
    await scheduled.shift()!();
    expect(send).toHaveBeenCalledTimes(1);
    const log = lines.join('');
    expect(log).toContain('mail.send_failed');
    expect(log).toContain('EENVELOPE');
    expect(log).not.toContain('nobody@example.test');
  });

  it('falls back to a later event-loop turn when there is no request scope for after()', async () => {
    afterMock.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope');
    });
    const work = vi.fn();
    runInBackground('x.failed', work);
    expect(work).not.toHaveBeenCalled();
    await settleBackgroundWork();
    expect(work).toHaveBeenCalledTimes(1);
  });
});
