import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const key32 = Buffer.alloc(32, 7).toString('base64');
const pepper32 = Buffer.alloc(32, 9).toString('base64');

function validEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'development',
    API_PORT: '4000',
    APP_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: 'postgres://darling_app:darling_app@localhost:5433/darling',
    DATABASE_OWNER_URL: 'postgres://darling_owner:darling_owner@localhost:5433/darling',
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 'false',
    ENCRYPTION_KEY: key32,
    TOKEN_PEPPER: pepper32,
    SMTP_URL: 'smtp://localhost:1025',
    MAIL_FROM: 'DARLING* <no-reply@darling7.store>',
  };
}

function errorOf(env: Record<string, string | undefined>): Error {
  try {
    loadConfig(env);
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(validEnv());
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 4000,
      appOrigin: 'http://localhost:3000',
      cookieSecure: false,
      trustProxy: false,
      smtpUrl: 'smtp://localhost:1025',
      mailFrom: 'DARLING* <no-reply@darling7.store>',
    });
    expect(Buffer.isBuffer(config.encryptionKey)).toBe(true);
    expect(config.encryptionKey.length).toBe(32);
    expect(config.tokenPepper.equals(Buffer.alloc(32, 9))).toBe(true);
  });

  it('parses COOKIE_SECURE=false as false and true as true', () => {
    expect(loadConfig({ ...validEnv(), COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(loadConfig({ ...validEnv(), COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
    expect(loadConfig({ ...validEnv(), TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });

  it('only accepts the literal strings true and false for booleans', () => {
    for (const bad of ['1', 'yes', 'TRUE', '', ' true']) {
      expect(errorOf({ ...validEnv(), COOKIE_SECURE: bad }).message).toContain('COOKIE_SECURE');
    }
  });

  it('throws naming ENCRYPTION_KEY when it is missing', () => {
    const env = validEnv();
    delete env.ENCRYPTION_KEY;
    expect(errorOf(env).message).toContain('ENCRYPTION_KEY');
  });

  it('throws naming ENCRYPTION_KEY when it is empty, not base64 or not 32 bytes', () => {
    const short = Buffer.alloc(16, 1).toString('base64');
    const long = Buffer.alloc(33, 1).toString('base64');
    for (const bad of ['', 'not base64 !!!', short, long]) {
      expect(errorOf({ ...validEnv(), ENCRYPTION_KEY: bad }).message).toContain('ENCRYPTION_KEY');
    }
  });

  it('applies the same 32-byte rule to TOKEN_PEPPER', () => {
    const short = Buffer.alloc(31, 1).toString('base64');
    const message = errorOf({ ...validEnv(), TOKEN_PEPPER: short }).message;
    expect(message).toContain('TOKEN_PEPPER');
    expect(message).not.toContain('ENCRYPTION_KEY');
  });

  it('rejects invalid ports, origins and URLs', () => {
    expect(errorOf({ ...validEnv(), API_PORT: 'abc' }).message).toContain('API_PORT');
    expect(errorOf({ ...validEnv(), API_PORT: '0' }).message).toContain('API_PORT');
    expect(errorOf({ ...validEnv(), API_PORT: '70000' }).message).toContain('API_PORT');
    expect(errorOf({ ...validEnv(), API_PORT: '40.5' }).message).toContain('API_PORT');
    expect(errorOf({ ...validEnv(), APP_ORIGIN: 'localhost:3000' }).message).toContain('APP_ORIGIN');
    expect(errorOf({ ...validEnv(), DATABASE_URL: 'mysql://x/y' }).message).toContain('DATABASE_URL');
    expect(errorOf({ ...validEnv(), DATABASE_OWNER_URL: 'nope' }).message).toContain(
      'DATABASE_OWNER_URL',
    );
    expect(errorOf({ ...validEnv(), SMTP_URL: 'http://x' }).message).toContain('SMTP_URL');
    expect(errorOf({ ...validEnv(), MAIL_FROM: '' }).message).toContain('MAIL_FROM');
    expect(errorOf({ ...validEnv(), NODE_ENV: 'staging' }).message).toContain('NODE_ENV');
  });

  it('normalises APP_ORIGIN to a bare origin', () => {
    expect(loadConfig({ ...validEnv(), APP_ORIGIN: 'https://darling7.store/' }).appOrigin).toBe(
      'https://darling7.store',
    );
  });

  it('reports every bad key in one error and never echoes values', () => {
    const message = errorOf({
      NODE_ENV: 'nope',
      API_PORT: 'x',
      DATABASE_URL: 'mysql://user:SuperSecretPw@host/db',
      ENCRYPTION_KEY: 'AAAA',
      TOKEN_PEPPER: 'ZZZZ',
    }).message;
    for (const key of [
      'NODE_ENV',
      'API_PORT',
      'APP_ORIGIN',
      'DATABASE_URL',
      'DATABASE_OWNER_URL',
      'COOKIE_SECURE',
      'TRUST_PROXY',
      'ENCRYPTION_KEY',
      'TOKEN_PEPPER',
      'SMTP_URL',
      'MAIL_FROM',
    ]) {
      expect(message).toContain(key);
    }
    expect(message).not.toContain('SuperSecretPw');
    expect(message).not.toContain('AAAA');
    expect(message).not.toContain('ZZZZ');
  });
});
