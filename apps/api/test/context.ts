import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { v7 } from 'uuid';
import pg from 'pg';
import type { Permission, Role, UserStatus } from '@darling/shared';
import { buildApp, type BuildAppOptions, type Clock, type Config } from '../src/app';
import { createDb, type Db } from '../src/db/client';
import { userPermissions, users } from '../src/db/schema';
import { encryptSecret, hashPassword } from '../src/lib/crypto';
import { newTotpSecret } from '../src/lib/totp';
import { memoryMailer, type MemoryMailer } from '../src/mail/mailer';
import { testConfig } from '../src/test-helpers';
import { ownerAdminUrl, requireEnv, TEMPLATE_DB, withDatabase } from './env';

export type TestClock = Clock & {
  /** The instant the clock currently reports; assignable. */
  now: Date;
  advance(ms: number): void;
};

export type TestContext = {
  app: FastifyInstance;
  config: Config;
  /** Connected as darling_app, the same role the running API uses. */
  db: Db;
  mailer: MemoryMailer;
  clock: TestClock;
  /** Name of this context's private database. */
  databaseName: string;
  close(): Promise<void>;
};

export function createTestClock(start: Date = new Date('2026-01-01T00:00:00.000Z')): TestClock {
  let current = new Date(start);
  const clock = (() => new Date(current)) as TestClock;
  Object.defineProperty(clock, 'now', {
    enumerable: true,
    get: () => new Date(current),
    set: (value: Date) => {
      current = new Date(value);
    },
  });
  clock.advance = (ms: number) => {
    current = new Date(current.getTime() + ms);
  };
  return clock;
}

/** A client connected as darling_owner to one database (for DDL or owner-level assertions). */
export async function connectAsOwner(databaseName: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: withDatabase(ownerAdminUrl(), databaseName) });
  await client.connect();
  return client;
}

async function adminQuery(sql: string, params: unknown[] = []): Promise<void> {
  const admin = new pg.Client({ connectionString: ownerAdminUrl() });
  await admin.connect();
  try {
    await admin.query(sql, params);
  } finally {
    await admin.end();
  }
}

export type TestContextOptions = {
  /** Overrides applied on top of the test configuration (for example `cookieSecure: true`). */
  config?: Partial<Config>;
  /** Passed to `buildApp`; `extend` adds probe routes that sit behind the real plugins. */
  build?: Pick<BuildAppOptions, 'extend'>;
};

/** Clones the migrated template into a private database and boots the app against it. */
export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const databaseName = `darling_test_${randomUUID().replaceAll('-', '')}`;
  await adminQuery(`create database ${databaseName} template ${TEMPLATE_DB}`);

  const appUrl = withDatabase(requireEnv('DATABASE_URL'), databaseName);
  const ownerUrl = withDatabase(ownerAdminUrl(), databaseName);
  const { db, close: closeDb } = createDb(appUrl);
  const mailer = memoryMailer();
  const clock = createTestClock();

  const config = testConfig({ databaseUrl: appUrl, databaseOwnerUrl: ownerUrl, ...options.config });
  const app = await buildApp(
    {
      config,
      db,
      mailer,
      clock,
    },
    options.build,
  );

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await app.close().catch(() => {});
    await closeDb().catch(() => {});
    try {
      await adminQuery('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [
        databaseName,
      ]);
      await adminQuery(`drop database if exists ${databaseName}`);
    } catch {
      // The database is already gone or the server is shutting down; nothing left to clean.
    }
  }

  return { app, config, db, mailer, clock, databaseName, close };
}

export type SeedUserInput = {
  role: Role;
  email?: string;
  password?: string;
  isOwner?: boolean;
  permissions?: Permission[];
  status?: UserStatus;
  totp?: boolean;
};

export type SeededUser = {
  id: string;
  email: string;
  password: string;
  /** Base32 secret of the enrolled authenticator; present when seeded with `totp: true`. */
  totpSecret?: string;
};

const DEFAULT_PASSWORD = 'Rose-gloss-2026';

/** Inserts a user (and permissions) straight into the database. */
export async function seedUser(ctx: TestContext, input: SeedUserInput): Promise<SeededUser> {
  const id = v7();
  const email = input.email ?? `user-${id.slice(-12)}@example.test`;
  const password = input.password ?? DEFAULT_PASSWORD;
  const totpSecret = input.totp ? newTotpSecret() : undefined;
  await ctx.db.insert(users).values({
    id,
    email,
    passwordHash: await hashPassword(password),
    fullName: 'Test User',
    role: input.role,
    status: input.status ?? 'active',
    isOwner: input.isOwner ?? false,
    ...(totpSecret
      ? { totpSecretEnc: encryptSecret(totpSecret, ctx.config.encryptionKey), totpEnabled: true }
      : {}),
  });
  if (input.permissions?.length) {
    await ctx.db
      .insert(userPermissions)
      .values(input.permissions.map((permission) => ({ userId: id, permission })));
  }
  return { id, email, password, ...(totpSecret ? { totpSecret } : {}) };
}

/** The 6-digit code an authenticator shows for `secret` at `at` (offset a whole step with `stepOffset`). */
export function totpCodeAt(secret: string, at: Date, stepOffset = 0): string {
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.generate({ timestamp: at.getTime() + stepOffset * 30_000 });
}

/** Headers every state-changing request from the web app carries (CSRF plugin). */
export function csrfHeaders(ctx: TestContext): Record<string, string> {
  return { 'x-requested-with': 'fetch', origin: ctx.config.appOrigin };
}

let nextAddress = 0;
/** A distinct client address per call, so tests do not share the per-IP login rate limit. */
export function freshAddress(): string {
  nextAddress += 1;
  return `10.${(nextAddress >> 16) & 255}.${(nextAddress >> 8) & 255}.${nextAddress & 255}`;
}

/** `name=value` of the session cookie in a response, or undefined when none was set. */
export function sessionCookieOf(res: { headers: Record<string, unknown> }): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  const found = list.find((c) => /^(__Host-)?dl_session=/.test(c));
  return found?.split(';')[0];
}

/**
 * Logs in through the API and returns the Cookie header to send on later requests. Each call comes
 * from its own client address unless `remoteAddress` is given.
 */
export async function login(
  ctx: TestContext,
  email: string,
  password: string,
  totpCode?: string,
  options: { remember?: boolean; remoteAddress?: string } = {},
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: csrfHeaders(ctx),
    remoteAddress: options.remoteAddress ?? freshAddress(),
    payload: {
      email,
      password,
      ...(totpCode === undefined ? {} : { totpCode }),
      ...(options.remember === undefined ? {} : { remember: options.remember }),
    },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login() failed with ${res.statusCode}: ${res.body}`);
  }
  const cookie = sessionCookieOf(res);
  if (!cookie) throw new Error('login() succeeded without a session cookie');
  return cookie;
}
