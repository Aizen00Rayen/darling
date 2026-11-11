import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as OTPAuth from 'otpauth';
import type { Permission, Role, UserStatus } from '@/shared';
import type { Config } from '../config';
import { fixedClock, type FixedClock } from '../clock';
import { setServerContextForTests, type ServerContext } from '../context';
import { applyMigrations } from '../db/migrate';
import { openDatabase, type Db } from '../db/sqlite';
import { newId } from '../ids';
import { memoryMailer, type MemoryMailer } from '../mail/mailer';
import { dispatchApi } from '../api-registry';
import { encryptSecret, hashPassword } from '../security/crypto';
import { createRateLimiter, type RateLimiter } from '../security/rate-limit';
import { newTotpSecret } from '../security/totp';

export const DEFAULT_PASSWORD = 'Rose-gloss-2026';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    isProduction: false,
    appOrigin: 'http://localhost:3000',
    cookieSecure: false,
    dataDir: '/nonexistent-test-dir',
    allowDataInAppDir: false,
    encryptionKey: Buffer.alloc(32, 1),
    trustedProxyHops: 1,
    smtpUrl: undefined,
    mailFrom: undefined,
    ...overrides,
  };
}

/** Round-robins top-level statements over several connections to one file (each transaction stays on one). */
function pooled(dbs: Db[]): Db {
  let i = 0;
  const next = () => dbs[i++ % dbs.length] as Db;
  return {
    exec: (sql) => next().exec(sql),
    get: (sql, ...p) => next().get(sql, ...p),
    all: (sql, ...p) => next().all(sql, ...p),
    run: (sql, ...p) => next().run(sql, ...p),
    transaction: (fn, mode) => next().transaction(fn, mode),
    close: () => dbs.forEach((d) => d.close()),
  };
}

export interface TestApp extends ServerContext {
  db: Db;
  clock: FixedClock;
  mailer: MemoryMailer;
  limiter: RateLimiter;
  call(pathname: string, init?: CallInit): Promise<Response>;
  close(): void;
}

export interface CallInit {
  method?: string;
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  /** Client address as the proxy would report it (X-Forwarded-For). Default: a fresh address per call. */
  ip?: string;
  /** Extra headers; a value of null removes a default header. */
  headers?: Record<string, string | null>;
}

let ipSeq = 0;
/** A distinct client address per call, so tests do not share the per-IP rate limits. */
export function freshIp(): string {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
}

export function createTestApp(options: { config?: Partial<Config>; file?: boolean; connections?: number } = {}): TestApp {
  let dir: string | undefined;
  let db: Db;
  if (options.file) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-test-'));
    const file = path.join(dir, 'test.sqlite');
    const first = openDatabase(file);
    applyMigrations(first);
    const others = Array.from({ length: (options.connections ?? 2) - 1 }, () => openDatabase(file));
    db = pooled([first, ...others]);
  } else {
    db = openDatabase(':memory:');
    applyMigrations(db);
  }
  const clock = fixedClock();
  const config = testConfig(options.config);
  const mailer = memoryMailer();
  const limiter = createRateLimiter(clock);
  const ctx: ServerContext = { db, clock, config, mailer, limiter };
  setServerContextForTests(ctx);

  const app: TestApp = {
    ...ctx,
    db,
    clock,
    mailer,
    limiter,
    async call(pathname, init = {}) {
      const headers = new Headers({ 'X-Requested-With': 'fetch', Origin: config.appOrigin, 'X-Forwarded-For': init.ip ?? freshIp() });
      const hasBody = init.body !== undefined || init.rawBody !== undefined;
      if (hasBody) headers.set('Content-Type', 'application/json');
      if (init.cookie) headers.set('Cookie', init.cookie);
      for (const [k, v] of Object.entries(init.headers ?? {})) {
        if (v === null) headers.delete(k);
        else headers.set(k, v);
      }
      const method = init.method ?? (hasBody ? 'POST' : 'GET');
      const request = new Request(new URL(pathname, config.appOrigin), {
        method,
        headers,
        body: init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      });
      return dispatchApi(request);
    },
    close() {
      setServerContextForTests(null);
      db.close();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return app;
}

export interface SeedUserInput {
  role: Role;
  email?: string;
  password?: string;
  fullName?: string;
  isOwner?: boolean;
  permissions?: Permission[];
  status?: UserStatus;
  totp?: boolean;
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  totpSecret?: string;
}

const hashCache = new Map<string, Promise<string>>();
/** scrypt is deliberately slow: tests reuse one hash per distinct password. */
export function cachedHash(password: string): Promise<string> {
  let h = hashCache.get(password);
  if (!h) {
    h = hashPassword(password);
    hashCache.set(password, h);
  }
  return h;
}

export async function seedUser(app: TestApp, input: SeedUserInput): Promise<SeededUser> {
  const id = newId(app.clock);
  const email = input.email ?? `user-${id.slice(-12)}@example.test`;
  const password = input.password ?? DEFAULT_PASSWORD;
  const totpSecret = input.totp ? newTotpSecret() : undefined;
  const now = app.clock.now();
  app.db.run(
    `INSERT INTO users (id, email, password_hash, full_name, role, status, is_owner, totp_secret_enc, totp_enabled, created_at, updated_at)
     VALUES (:id, :email, :hash, :name, :role, :status, :owner, :totp, :totpOn, :now, :now)`,
    {
      id,
      email,
      hash: input.status === 'invited' ? null : await cachedHash(password),
      name: input.fullName ?? 'Test User',
      role: input.role,
      status: input.status ?? 'active',
      owner: input.isOwner ?? false,
      totp: totpSecret ? encryptSecret(totpSecret, app.config.encryptionKey) : null,
      totpOn: totpSecret !== undefined,
      now,
    },
  );
  for (const permission of input.permissions ?? []) {
    app.db.run('INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)', id, permission);
  }
  return { id, email, password, ...(totpSecret ? { totpSecret } : {}) };
}

/** The 6-digit code an authenticator shows for `secret` at `atMs` (offset whole steps with `stepOffset`). */
export function totpCodeAt(secret: string, atMs: number, stepOffset = 0): string {
  return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate({
    timestamp: atMs + stepOffset * 30_000,
  });
}

/** A syntactically valid code that is wrong for every step the server accepts. */
export function wrongCode(secret: string, atMs: number): string {
  const taken = new Set([-1, 0, 1].map((o) => totpCodeAt(secret, atMs, o)));
  for (let n = 0; n < 1000; n += 1) {
    const candidate = String(n * 997 + 13).padStart(6, '0');
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('unreachable');
}

/** `name=value` of the session cookie set by a response, or undefined. */
export function sessionCookieOf(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => /^(__Host-)?dl_session=/.test(c))
    ?.split(';')[0];
}

/** The full Set-Cookie line of the session cookie. */
export function setCookieLine(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => /^(__Host-)?dl_session=/.test(c));
}

/** Logs in through the real route and returns the Cookie header for later requests. */
export async function login(
  app: TestApp,
  email: string,
  password: string,
  extra: { totpCode?: string; remember?: boolean; ip?: string } = {},
): Promise<string> {
  const res = await app.call('/api/auth/login', {
    ip: extra.ip,
    body: { email, password, ...(extra.totpCode ? { totpCode: extra.totpCode } : {}), ...(extra.remember ? { remember: true } : {}) },
  });
  if (res.status !== 200) throw new Error(`login() failed with ${res.status}: ${await res.text()}`);
  const cookie = sessionCookieOf(res);
  if (!cookie) throw new Error('login() succeeded without a session cookie');
  return cookie;
}

/** status + exact body text + a few headers, for byte-for-byte comparisons. */
export async function snap(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get('content-type'),
    setCookie: res.headers.getSetCookie(),
    retryAfter: res.headers.get('retry-after'),
    cacheControl: res.headers.get('cache-control'),
  };
}
