import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerContext, setServerContextForTests, buildMailer } from './context';
import { createTestApp } from './test/app';

afterEach(() => {
  setServerContextForTests(null);
  vi.unstubAllEnvs();
});

describe('getServerContext', () => {
  it('returns the injected context in tests, and the real one again after null', () => {
    const app = createTestApp();
    expect(getServerContext()).toMatchObject({ db: app.db, clock: app.clock, config: app.config, mailer: app.mailer });
    app.close();
  });

  it('builds a singleton from the environment, with a lazy database', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('APP_ORIGIN', 'http://localhost:3999');
    const a = getServerContext();
    const b = getServerContext();
    expect(a).toBe(b);
    expect(a.config.appOrigin).toBe('http://localhost:3999');
    expect(typeof a.clock.now()).toBe('number');
    expect(a.limiter.limit('x', 'y', { max: 1, windowMs: 1000 }).ok).toBe(true);
  });
});

describe('buildMailer', () => {
  const base = { nodeEnv: 'development' as const, smtpUrl: undefined, mailFrom: undefined };
  it('uses the console mailer without SMTP_URL in development and logs the link', async () => {
    const lines: string[] = [];
    const m = buildMailer(base, (_l, e, f) => lines.push(JSON.stringify({ e, ...f })));
    await m.send({ to: 'a@b.co', subject: 's', text: 'go http://localhost:3000/invitation?token=zzz', html: '' });
    expect(lines.join('')).toContain('token=zzz');
    expect(lines.join('')).not.toContain('a@b.co');
  });

  it('never logs a link in production without SMTP_URL: sending fails loudly instead', async () => {
    const lines: string[] = [];
    const m = buildMailer({ ...base, nodeEnv: 'production' }, (_l, e, f) => lines.push(JSON.stringify({ e, ...f })));
    await expect(m.send({ to: 'a@b.co', subject: 's', text: 'go http://x/?token=zzz', html: '' })).rejects.toThrow(/SMTP_URL/);
    expect(lines.join('')).not.toContain('token=zzz');
  });

  it('uses SMTP when configured', () => {
    const m = buildMailer({ ...base, smtpUrl: 'smtp://localhost:1025', mailFrom: 'X <x@y.z>' });
    expect(typeof m.send).toBe('function');
  });
});
