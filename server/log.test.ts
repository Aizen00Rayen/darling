import { describe, expect, it } from 'vitest';
import { createLogger, logError, redact, safeErrorMessage } from './log';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = createLogger({
    sink: (_level, line) => {
      raw.push(line);
      lines.push(JSON.parse(line));
    },
    now: () => 1_700_000_000_000,
  });
  return { logger, lines, raw };
}

describe('logger', () => {
  it('writes one JSON line with level, timestamp, event and fields', () => {
    const { logger, lines } = capture();
    logger.info('user.login', { userId: 'u1', attempts: 2 });
    logger.warn('slow', { ms: 900 });
    logger.error('failed', {});
    expect(lines).toEqual([
      { level: 'info', at: '2023-11-14T22:13:20.000Z', event: 'user.login', userId: 'u1', attempts: 2 },
      { level: 'warn', at: '2023-11-14T22:13:20.000Z', event: 'slow', ms: 900 },
      { level: 'error', at: '2023-11-14T22:13:20.000Z', event: 'failed' },
    ]);
  });

  it('fields cannot overwrite level, at or event', () => {
    const { logger, lines } = capture();
    logger.info('real', { level: 'x', at: 'y', event: 'z' });
    expect(lines[0]).toMatchObject({ level: 'info', event: 'real', at: '2023-11-14T22:13:20.000Z' });
  });

  it('redacts sensitive keys at any depth, case-insensitively', () => {
    const { logger, lines, raw } = capture();
    logger.info('req', {
      password: 'hunter2',
      newPassword: 'hunter3',
      sessionToken: 'tok',
      Cookie: 'a=b',
      'set-cookie': 'a=b',
      clientSecret: 's',
      password_hash: 'scrypt$...',
      Authorization: 'Bearer abc',
      nested: { deep: [{ resetToken: 'x', ok: 1 }] },
      safe: 'visible',
    });
    expect(lines[0]).toMatchObject({
      password: '[REDACTED]',
      newPassword: '[REDACTED]',
      sessionToken: '[REDACTED]',
      Cookie: '[REDACTED]',
      'set-cookie': '[REDACTED]',
      clientSecret: '[REDACTED]',
      password_hash: '[REDACTED]',
      Authorization: '[REDACTED]',
      nested: { deep: [{ resetToken: '[REDACTED]', ok: 1 }] },
      safe: 'visible',
    });
    for (const secret of ['hunter2', 'hunter3', 'Bearer abc', 'scrypt$']) {
      expect(raw[0]).not.toContain(secret);
    }
  });

  it('survives circular references, bigint and undefined', () => {
    const { logger, lines } = capture();
    const a: Record<string, unknown> = { n: BigInt(1), u: undefined };
    a.self = a;
    logger.info('odd', { a });
    expect(lines[0]).toMatchObject({ a: { n: '1', self: '[Circular]' } });
  });

  it('serialises Error values inside fields safely', () => {
    const { logger, lines, raw } = capture();
    logger.warn('w', { err: new Error('bad params: ["pw"]') });
    expect(raw[0]).not.toContain('"pw"');
    expect(lines[0]).toMatchObject({ err: { name: 'Error' } });
  });
});

describe('redact', () => {
  it('does not mutate its input', () => {
    const input = { password: 'p', list: [{ token: 't' }] };
    const out = redact(input) as typeof input;
    expect(input.password).toBe('p');
    expect(input.list[0]!.token).toBe('t');
    expect(out.password).toBe('[REDACTED]');
  });
});

describe('logError', () => {
  it('logs name, message and stack', () => {
    const { logger, lines } = capture();
    logError('db.failed', new TypeError('nope'), { route: '/x' }, logger);
    expect(lines[0]).toMatchObject({ level: 'error', event: 'db.failed', route: '/x' });
    const err = lines[0]!.err as { name: string; message: string; stack: string };
    expect(err.name).toBe('TypeError');
    expect(err.message).toBe('nope');
    expect(err.stack).toContain('TypeError: nope');
  });

  it('truncates the message at a "params:" marker and keeps bound parameters out of the stack too', () => {
    const { logger, lines, raw } = capture();
    const err = new Error('Failed query: INSERT INTO users (email) VALUES ($1)\nparams: alice@example.com,secret-hash');
    logError('db.failed', err, {}, logger);
    const out = lines[0]!.err as { message: string; stack: string };
    expect(out.message).toContain('Failed query: INSERT INTO users');
    expect(out.message).not.toContain('params:');
    expect(out.stack).not.toContain('alice@example.com');
    expect(raw[0]).not.toContain('alice@example.com');
    expect(raw[0]).not.toContain('secret-hash');
  });

  it('redacts secret-looking key=value pairs in messages', () => {
    expect(safeErrorMessage('login failed password=hunter2 for x')).not.toContain('hunter2');
    expect(safeErrorMessage('Authorization: Bearer abc.def')).not.toContain('abc.def');
  });

  it('follows the cause chain and tolerates non-Error values', () => {
    const { logger, lines, raw } = capture();
    const err = new Error('outer', { cause: new Error('inner params: [secret]') });
    logError('chain', err, {}, logger);
    expect(raw[0]).not.toContain('[secret]');
    expect((lines[0]!.err as { cause: { message: string } }).cause.message).toContain('inner');
    logError('str', 'just a string', {}, logger);
    expect(lines[1]!.err).toMatchObject({ name: 'NonError', message: 'just a string' });
  });
});
