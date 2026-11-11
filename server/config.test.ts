import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const KEY = Buffer.alloc(32, 7).toString('base64');
const tmp: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-config-'));
  tmp.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function prod(extra: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://darling7.store',
    COOKIE_SECURE: 'true',
    DATA_DIR: tmpDir(),
    ENCRYPTION_KEY: KEY,
    ...extra,
  };
}

function errorOf(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig (development)', () => {
  it('applies defaults', () => {
    const c = loadConfig({ ENCRYPTION_KEY: KEY }, { cwd: '/srv/app' });
    expect(c).toMatchObject({
      nodeEnv: 'development',
      isProduction: false,
      appOrigin: 'http://localhost:3000',
      cookieSecure: false,
      dataDir: '/srv/app/.data',
      trustedProxyHops: 1,
      smtpUrl: undefined,
      mailFrom: undefined,
    });
    expect(c.encryptionKey.equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it('normalises APP_ORIGIN to a bare origin', () => {
    expect(loadConfig({ ENCRYPTION_KEY: KEY, APP_ORIGIN: 'https://Darling7.store/' }).appOrigin).toBe('https://darling7.store');
    expect(loadConfig({ ENCRYPTION_KEY: KEY, APP_ORIGIN: 'http://localhost:3000' }).appOrigin).toBe('http://localhost:3000');
  });

  it('defaults COOKIE_SECURE from the origin scheme and parses true/false', () => {
    expect(loadConfig({ ENCRYPTION_KEY: KEY, APP_ORIGIN: 'https://x.example' }).cookieSecure).toBe(true);
    expect(loadConfig({ ENCRYPTION_KEY: KEY, COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
    expect(loadConfig({ ENCRYPTION_KEY: KEY, COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });

  it('parses TRUSTED_PROXY_HOPS', () => {
    expect(loadConfig({ ENCRYPTION_KEY: KEY, TRUSTED_PROXY_HOPS: '0' }).trustedProxyHops).toBe(0);
    expect(loadConfig({ ENCRYPTION_KEY: KEY, TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops).toBe(2);
  });

  it('resolves a relative DATA_DIR against cwd', () => {
    expect(loadConfig({ ENCRYPTION_KEY: KEY, DATA_DIR: 'var/db' }, { cwd: '/srv/app' }).dataDir).toBe('/srv/app/var/db');
    expect(loadConfig({ ENCRYPTION_KEY: KEY, DATA_DIR: '/srv/data' }, { cwd: '/srv/app' }).dataDir).toBe('/srv/data');
  });

  it('accepts smtp URLs and a mail sender', () => {
    const c = loadConfig({ ENCRYPTION_KEY: KEY, SMTP_URL: 'smtp://localhost:1025', MAIL_FROM: 'DARLING* <no-reply@darling7.store>' });
    expect(c.smtpUrl).toBe('smtp://localhost:1025');
    expect(c.mailFrom).toBe('DARLING* <no-reply@darling7.store>');
  });

  it('requires ENCRYPTION_KEY outside tests', () => {
    expect(errorOf({}).keys).toEqual(['ENCRYPTION_KEY']);
  });

  it('uses a fixed throwaway key in NODE_ENV=test when none is given', () => {
    const c = loadConfig({ NODE_ENV: 'test' });
    expect(c.encryptionKey).toHaveLength(32);
  });
});

describe('loadConfig validation', () => {
  it('lists every bad key in one error', () => {
    const err = errorOf({
      NODE_ENV: 'staging',
      APP_ORIGIN: 'not a url',
      COOKIE_SECURE: 'maybe',
      ENCRYPTION_KEY: 'short',
      TRUSTED_PROXY_HOPS: '-1',
      SMTP_URL: 'http://wrong-scheme',
    });
    expect([...err.keys].sort()).toEqual(['APP_ORIGIN', 'COOKIE_SECURE', 'ENCRYPTION_KEY', 'NODE_ENV', 'SMTP_URL', 'TRUSTED_PROXY_HOPS']);
    for (const k of err.keys) expect(err.message).toContain(k);
  });

  it('never echoes secret values', () => {
    const secret = 'super-secret-key-material-that-is-wrong';
    const err = errorOf({ ENCRYPTION_KEY: secret, SMTP_URL: 'smtp://user:p%40ssw0rd@' });
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain('p%40ssw0rd');
    expect(err.message).not.toContain('ssw0rd');
    expect(JSON.stringify(err.issues)).not.toContain(secret);
  });

  it('requires ENCRYPTION_KEY to be base64 of exactly 32 bytes', () => {
    expect(errorOf({ ENCRYPTION_KEY: Buffer.alloc(31).toString('base64') }).keys).toEqual(['ENCRYPTION_KEY']);
    expect(errorOf({ ENCRYPTION_KEY: Buffer.alloc(33).toString('base64') }).keys).toEqual(['ENCRYPTION_KEY']);
    expect(errorOf({ ENCRYPTION_KEY: '!'.repeat(44) }).keys).toEqual(['ENCRYPTION_KEY']);
  });

  it('rejects an APP_ORIGIN with a path, credentials, query or non-http scheme', () => {
    for (const bad of ['https://x.example/shop', 'https://u:p@x.example', 'https://x.example/?a=1', 'ftp://x.example', 'x.example']) {
      expect(errorOf({ ENCRYPTION_KEY: KEY, APP_ORIGIN: bad }).keys).toEqual(['APP_ORIGIN']);
    }
  });

  it('rejects non-integer TRUSTED_PROXY_HOPS', () => {
    for (const bad of ['1.5', 'one', '', '-1', '1e2']) {
      expect(errorOf({ ENCRYPTION_KEY: KEY, TRUSTED_PROXY_HOPS: bad }).keys).toEqual(['TRUSTED_PROXY_HOPS']);
    }
  });
});

describe('loadConfig production guard rails', () => {
  it('accepts a correct production environment', () => {
    const c = loadConfig(prod());
    expect(c).toMatchObject({ isProduction: true, cookieSecure: true, appOrigin: 'https://darling7.store' });
  });

  it('refuses TRUSTED_PROXY_HOPS=0 in production (every client would share one rate-limit bucket) but allows it elsewhere', () => {
    expect(errorOf(prod({ TRUSTED_PROXY_HOPS: '0' })).keys).toEqual(['TRUSTED_PROXY_HOPS']);
    expect(loadConfig(prod({ TRUSTED_PROXY_HOPS: '1' })).trustedProxyHops).toBe(1);
    expect(loadConfig({ ENCRYPTION_KEY: KEY, TRUSTED_PROXY_HOPS: '0' }).trustedProxyHops).toBe(0);
  });

  it('refuses plaintext-capable SMTP for non-loopback hosts in production, and nothing else', () => {
    for (const url of ['smtp://mail.example.test:25?starttls=optional', 'smtp://10.0.0.5?starttls=optional', 'smtp://user:pw@mail.example.test?starttls=optional']) {
      expect(errorOf(prod({ SMTP_URL: url })).keys, url).toEqual(['SMTP_URL']);
    }
    for (const url of [
      'smtp://mail.example.test:587', // STARTTLS is required by default
      'smtp://mail.example.test:587?starttls=required',
      'smtps://mail.example.test',
      'smtp://localhost:1025?starttls=optional', // loopback may stay opportunistic
      'smtp://127.0.0.1:1025',
    ]) {
      expect(loadConfig(prod({ SMTP_URL: url })).smtpUrl, url).toBe(url);
    }
    expect(loadConfig({ ENCRYPTION_KEY: KEY, SMTP_URL: 'smtp://mail.example.test?starttls=optional' }).smtpUrl).toBeDefined();
  });

  it('requires APP_ORIGIN', () => {
    expect(errorOf(prod({ APP_ORIGIN: undefined })).keys).toContain('APP_ORIGIN');
  });

  it('refuses a non-https APP_ORIGIN', () => {
    expect(errorOf(prod({ APP_ORIGIN: 'http://darling7.store' })).keys).toContain('APP_ORIGIN');
  });

  it('refuses COOKIE_SECURE=false', () => {
    expect(errorOf(prod({ COOKIE_SECURE: 'false' })).keys).toEqual(['COOKIE_SECURE']);
  });

  it('defaults COOKIE_SECURE to true over https', () => {
    expect(loadConfig(prod({ COOKIE_SECURE: undefined })).cookieSecure).toBe(true);
  });

  it('requires a writable DATA_DIR and creates it when missing', () => {
    const base = tmpDir();
    const dataDir = path.join(base, 'nested', 'data');
    loadConfig(prod({ DATA_DIR: dataDir }));
    expect(fs.statSync(dataDir).isDirectory()).toBe(true);

    const file = path.join(base, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(errorOf(prod({ DATA_DIR: path.join(file, 'sub') })).keys).toEqual(['DATA_DIR']);
  });

  it('refuses a DATA_DIR inside the app directory unless explicitly allowed', () => {
    const cwd = tmpDir();
    const inside = path.join(cwd, 'data');
    let err: ConfigError | undefined;
    try {
      loadConfig(prod({ DATA_DIR: inside }), { cwd });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.keys).toEqual(['DATA_DIR']);
    expect(fs.existsSync(inside)).toBe(false);
    expect(loadConfig(prod({ DATA_DIR: inside, ALLOW_DATA_IN_APP_DIR: 'true' }), { cwd }).dataDir).toBe(inside);
  });

  it('does not apply the app-directory rule outside production', () => {
    const cwd = tmpDir();
    expect(loadConfig({ ENCRYPTION_KEY: KEY, DATA_DIR: path.join(cwd, 'data') }, { cwd }).dataDir).toBe(path.join(cwd, 'data'));
  });
});
