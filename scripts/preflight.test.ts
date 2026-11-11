import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, runPreflight, type Check, type PreflightOptions } from './preflight';

const KEY = Buffer.alloc(32, 9).toString('base64');
const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-preflight-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function goodEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://darling7.store',
    COOKIE_SECURE: 'true',
    DATA_DIR: tmp(),
    ENCRYPTION_KEY: KEY,
    TRUSTED_PROXY_HOPS: '1',
    SETUP_TOKEN: 's'.repeat(40),
    CRON_TOKEN: 'c'.repeat(40),
    SMTP_URL: 'smtps://no-reply%40darling7.store:Sup3r-Secret-Pass@smtp.hostinger.com:465',
    MAIL_FROM: 'DARLING* <no-reply@darling7.store>',
    ...extra,
  };
}
const opts = (o: Partial<PreflightOptions> = {}): PreflightOptions => ({ cwd: '/srv/app', nodeVersion: '22.23.4', usersCount: 0, ...o });
const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id)!;

describe('runPreflight: a good production setup', () => {
  it('passes every check', () => {
    const r = runPreflight(goodEnv(), opts());
    expect(r.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual([
      'node',
      'node_env',
      'app_origin',
      'cookie_secure',
      'encryption_key',
      'data_dir_set',
      'data_dir_outside_app',
      'data_dir_writable',
      'data_dir_space',
      'trusted_proxy_hops',
      'setup_token',
      'cron_token',
      'smtp_url',
      'mail_from',
      'app_config',
    ]);
  });

  it('never prints a secret value', () => {
    const env = goodEnv();
    const text = JSON.stringify(runPreflight(env, opts()));
    for (const secret of [KEY, env.SETUP_TOKEN!, env.CRON_TOKEN!, 'Sup3r-Secret-Pass', 'no-reply%40']) expect(text).not.toContain(secret);
    expect(byId(runPreflight(env, opts()).checks, 'smtp_url').detail).toBe('smtp.hostinger.com:465, TLS implicite');
  });
});

describe('each check fails on its own problem', () => {
  const failing = (env: NodeJS.ProcessEnv, o?: Partial<PreflightOptions>) => runPreflight(env, opts(o)).checks.filter((c) => c.status === 'fail').map((c) => c.id);

  it('node < 22', () => {
    expect(failing(goodEnv(), { nodeVersion: '20.11.0' })).toEqual(['node']);
    expect(failing(goodEnv(), { nodeVersion: '24.1.0' })).toEqual([]);
  });
  it('NODE_ENV is not production', () => {
    expect(failing(goodEnv({ NODE_ENV: 'development' }))).toContain('node_env');
    expect(failing(goodEnv({ NODE_ENV: undefined }))).toContain('node_env');
  });
  it('APP_ORIGIN missing, http or invalid', () => {
    for (const v of [undefined, 'http://darling7.store', 'darling7.store', 'https://darling7.store/path']) {
      expect(failing(goodEnv({ APP_ORIGIN: v }))).toContain('app_origin');
    }
  });
  it('COOKIE_SECURE is not exactly true', () => {
    for (const v of [undefined, 'false', '1', 'TRUE']) expect(failing(goodEnv({ COOKIE_SECURE: v }))).toContain('cookie_secure');
  });
  it('ENCRYPTION_KEY missing or not 32 bytes', () => {
    for (const v of [undefined, 'short', Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64')]) {
      expect(failing(goodEnv({ ENCRYPTION_KEY: v }))).toContain('encryption_key');
    }
  });
  it('DATA_DIR unset', () => {
    const f = failing(goodEnv({ DATA_DIR: undefined }));
    expect(f).toContain('data_dir_set');
  });
  it('DATA_DIR inside the app directory', () => {
    const f = failing(goodEnv({ DATA_DIR: '/srv/app/.data' }));
    expect(f).toContain('data_dir_outside_app');
    expect(failing(goodEnv({ DATA_DIR: '/srv/app' }))).toContain('data_dir_outside_app');
    expect(failing(goodEnv({ DATA_DIR: '/srv/app-data' }))).not.toContain('data_dir_outside_app');
  });
  it('DATA_DIR not writable', () => {
    const file = path.join(tmp(), 'a-file');
    fs.writeFileSync(file, 'x');
    expect(failing(goodEnv({ DATA_DIR: file }))).toContain('data_dir_writable');
    expect(failing(goodEnv({ DATA_DIR: path.join(file, 'below-a-file') }))).toContain('data_dir_writable');
  });
  it('a DATA_DIR that does not exist yet but can be created is fine', () => {
    const env = goodEnv({ DATA_DIR: path.join(tmp(), 'new-dir') });
    expect(byId(runPreflight(env, opts()).checks, 'data_dir_writable')).toMatchObject({ status: 'ok' });
  });
  it('free space: fail under 50 MB, warn under 500 MB', () => {
    expect(byId(runPreflight(goodEnv(), opts({ freeBytes: 10 * 1024 * 1024 })).checks, 'data_dir_space').status).toBe('fail');
    expect(byId(runPreflight(goodEnv(), opts({ freeBytes: 200 * 1024 * 1024 })).checks, 'data_dir_space').status).toBe('warn');
    expect(byId(runPreflight(goodEnv(), opts({ freeBytes: 5 * 1024 ** 3 })).checks, 'data_dir_space').status).toBe('ok');
    expect(byId(runPreflight(goodEnv(), opts({ freeBytes: null })).checks, 'data_dir_space').status).toBe('warn');
  });
  it('TRUSTED_PROXY_HOPS below 1 or invalid', () => {
    for (const v of ['0', 'x', '-1', '100']) expect(failing(goodEnv({ TRUSTED_PROXY_HOPS: v }))).toContain('trusted_proxy_hops');
    expect(failing(goodEnv({ TRUSTED_PROXY_HOPS: undefined }))).not.toContain('trusted_proxy_hops'); // default 1
    expect(failing(goodEnv({ TRUSTED_PROXY_HOPS: '2' }))).not.toContain('trusted_proxy_hops');
  });
  it('CRON_TOKEN missing or shorter than 32', () => {
    for (const v of [undefined, 'c'.repeat(31)]) expect(failing(goodEnv({ CRON_TOKEN: v }))).toContain('cron_token');
  });
  it('SMTP_URL missing, invalid or plaintext to a remote host', () => {
    for (const v of [undefined, 'nonsense', 'http://smtp.example.test', 'smtp://u:p@smtp.example.test:25?starttls=optional']) {
      expect(failing(goodEnv({ SMTP_URL: v }))).toContain('smtp_url');
    }
    expect(failing(goodEnv({ SMTP_URL: 'smtp://u:p@smtp.hostinger.com:587' }))).not.toContain('smtp_url');
  });
  it('MAIL_FROM missing or not an address', () => {
    for (const v of [undefined, 'not an address']) expect(failing(goodEnv({ MAIL_FROM: v }))).toContain('mail_from');
    expect(failing(goodEnv({ MAIL_FROM: 'no-reply@darling7.store' }))).not.toContain('mail_from');
  });
  it('the app own configuration check reports bad keys, never values', () => {
    const r = runPreflight(goodEnv({ MAIL_OUTBOX_DIR: '/tmp/secret-outbox-path' }), opts());
    const c = byId(r.checks, 'app_config');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('MAIL_OUTBOX_DIR');
    expect(JSON.stringify(r)).not.toContain('secret-outbox-path');
  });
});

describe('SETUP_TOKEN depends on whether an owner exists', () => {
  const setup = (env: NodeJS.ProcessEnv, usersCount: number | null) => byId(runPreflight(env, opts({ usersCount })).checks, 'setup_token');

  it('no user yet: required and at least 32 characters', () => {
    expect(setup(goodEnv(), 0).status).toBe('ok');
    expect(setup(goodEnv(), 0).detail).toMatch(/remove it after the first owner exists/i);
    expect(setup(goodEnv({ SETUP_TOKEN: undefined }), 0).status).toBe('fail');
    expect(setup(goodEnv({ SETUP_TOKEN: 'short' }), 0).status).toBe('fail');
  });
  it('an owner exists: the token should be removed (warning), absence is fine', () => {
    expect(setup(goodEnv(), 1).status).toBe('warn');
    expect(setup(goodEnv(), 1).detail).toMatch(/remove/i);
    expect(setup(goodEnv({ SETUP_TOKEN: undefined }), 3).status).toBe('ok');
  });
  it('database state unknown: the token is still required, with a note', () => {
    expect(setup(goodEnv({ SETUP_TOKEN: undefined }), null).status).toBe('warn');
  });
});

describe('usersCount is read from the database file when not injected', () => {
  it('0 when no database exists yet', () => {
    const env = goodEnv();
    const r = runPreflight(env, { cwd: '/srv/app', nodeVersion: '22.23.4' });
    expect(byId(r.checks, 'setup_token').status).toBe('ok');
  });
});

describe('main', () => {
  const run = (argv: string[], env: NodeJS.ProcessEnv, o: Partial<PreflightOptions> = {}) => {
    const out: string[] = [];
    const code = main(argv, env, { stdout: (t) => out.push(t), options: opts(o) });
    return { code, out: out.join('') };
  };

  it('prints a checklist and exits 0 when everything passes', () => {
    const r = run([], goodEnv());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[ OK \] Node\.js/);
    expect(r.out).not.toMatch(/\[FAIL\]/);
    expect(r.out).toMatch(/Ready/i);
  });

  it('exits 1 on any failure and says which', () => {
    const r = run([], goodEnv({ COOKIE_SECURE: 'false', CRON_TOKEN: undefined }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] COOKIE_SECURE/);
    expect(r.out).toMatch(/\[FAIL\] CRON_TOKEN/);
    expect(r.out).toMatch(/3 problems/);
  });

  it('warnings alone do not fail', () => {
    const r = run([], goodEnv(), { usersCount: 1 });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[WARN\] SETUP_TOKEN/);
  });

  it('--json prints machine-readable output with the same exit code', () => {
    const ok = run(['--json'], goodEnv());
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ ok: true, checks: expect.any(Array) });
    const bad = run(['--json'], goodEnv({ APP_ORIGIN: 'http://x.test' }));
    expect(bad.code).toBe(1);
    const parsed = JSON.parse(bad.out) as { ok: boolean; checks: Check[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.find((c) => c.id === 'app_origin')?.status).toBe('fail');
  });

  it('an unknown flag is a usage error (exit 2)', () => {
    expect(run(['--nope'], goodEnv()).code).toBe(2);
  });
});
