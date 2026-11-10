import type { Config } from './config';
import type { Db } from './db/client';
import type { Mailer } from './mail/mailer';
import type { AppDeps } from './app';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    port: 4000,
    appOrigin: 'http://localhost:3000',
    databaseUrl: 'postgres://darling_app:darling_app@localhost:5433/darling',
    databaseOwnerUrl: 'postgres://darling_owner:darling_owner@localhost:5433/darling',
    cookieSecure: false,
    trustProxy: false,
    encryptionKey: Buffer.alloc(32, 1),
    tokenPepper: Buffer.alloc(32, 2),
    smtpUrl: 'smtp://localhost:1025',
    mailFrom: 'DARLING* <no-reply@darling7.store>',
    ...overrides,
  };
}

export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const db: Db = { execute: async () => [] };
  const mailer: Mailer = { send: async () => {} };
  return {
    config: testConfig(),
    db,
    mailer,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}
