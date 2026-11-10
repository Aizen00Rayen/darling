import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { v7 } from 'uuid';
import pg from 'pg';
import type { Permission, Role, UserStatus } from '@darling/shared';
import { buildApp, type Clock } from '../src/app';
import { createDb, type Db } from '../src/db/client';
import { userPermissions, users } from '../src/db/schema';
import type { Mail, Mailer } from '../src/mail/mailer';
import { testConfig } from '../src/test-helpers';
import { ownerAdminUrl, requireEnv, TEMPLATE_DB, withDatabase } from './env';

export type MemoryMailer = Mailer & { sent: Mail[] };

export type TestClock = Clock & {
  /** The instant the clock currently reports; assignable. */
  now: Date;
  advance(ms: number): void;
};

export type TestContext = {
  app: FastifyInstance;
  /** Connected as darling_app, the same role the running API uses. */
  db: Db;
  mailer: MemoryMailer;
  clock: TestClock;
  /** Name of this context's private database. */
  databaseName: string;
  close(): Promise<void>;
};

export function createMemoryMailer(): MemoryMailer {
  const sent: Mail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

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

/** Clones the migrated template into a private database and boots the app against it. */
export async function createTestContext(): Promise<TestContext> {
  const databaseName = `darling_test_${randomUUID().replaceAll('-', '')}`;
  await adminQuery(`create database ${databaseName} template ${TEMPLATE_DB}`);

  const appUrl = withDatabase(requireEnv('DATABASE_URL'), databaseName);
  const ownerUrl = withDatabase(ownerAdminUrl(), databaseName);
  const { db, close: closeDb } = createDb(appUrl);
  const mailer = createMemoryMailer();
  const clock = createTestClock();

  const app = await buildApp({
    config: testConfig({ databaseUrl: appUrl, databaseOwnerUrl: ownerUrl }),
    db,
    mailer,
    clock,
  });

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

  return { app, db, mailer, clock, databaseName, close };
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

export type SeededUser = { id: string; email: string; password: string; totpSecret?: string };

const DEFAULT_PASSWORD = 'correct-horse-battery-staple-42';

/** Inserts a user (and permissions) straight into the database. */
export async function seedUser(ctx: TestContext, input: SeedUserInput): Promise<SeededUser> {
  if (input.totp) throw new Error('seedUser({ totp: true }) is available from Task 7');
  const id = v7();
  const email = input.email ?? `user-${id.slice(-12)}@example.test`;
  const password = input.password ?? DEFAULT_PASSWORD;
  await ctx.db.insert(users).values({
    id,
    email,
    // Task 6 replaces the placeholder with an argon2id hash of `password`.
    passwordHash: 'placeholder-hash-until-task-6',
    fullName: 'Test User',
    role: input.role,
    status: input.status ?? 'active',
    isOwner: input.isOwner ?? false,
  });
  if (input.permissions?.length) {
    await ctx.db
      .insert(userPermissions)
      .values(input.permissions.map((permission) => ({ userId: id, permission })));
  }
  return { id, email, password };
}

/** Logs in through the API and returns the Cookie header to send on later requests. */
export async function login(
  _ctx: TestContext,
  _email: string,
  _password: string,
  _totpCode?: string,
): Promise<string> {
  throw new Error('login() is available from Task 7');
}
