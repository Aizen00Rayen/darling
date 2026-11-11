import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// Environment configuration. One error lists every bad key (never the values: they may be secrets).
// Production guard rails (spec section 3): https APP_ORIGIN, COOKIE_SECURE=true, writable DATA_DIR outside the
// app directory, 32-byte ENCRYPTION_KEY.

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  /** Bare origin, e.g. https://darling7.store (no path, no trailing slash). */
  appOrigin: string;
  cookieSecure: boolean;
  /** Absolute directory holding darling.sqlite. */
  dataDir: string;
  allowDataInAppDir: boolean;
  /** 32 raw bytes (AES-256-GCM key for TOTP secrets). */
  encryptionKey: Buffer;
  /** Number of trusted reverse proxies in front of the app (see server/net/client-ip.ts). */
  trustedProxyHops: number;
  smtpUrl: string | undefined;
  mailFrom: string | undefined;
  /** One-time setup token (>= 32 characters). Unset = the first-run setup page is disabled. */
  setupToken: string | undefined;
  /** Bearer token of the machine-called cron routes (>= 32 characters). Unset = those routes answer 404. */
  cronToken: string | undefined;
  /** How many dated backup files to keep (BACKUP_KEEP, default 14). */
  backupKeep: number;
  /** Development/test only: the mailer also writes each mail as a JSON file in this directory. Never set in production. */
  mailOutboxDir: string | undefined;
}

export interface ConfigIssue {
  key: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((i) => `${i.key} (${i.message})`).join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
  get keys(): string[] {
    return [...new Set(this.issues.map((i) => i.key))];
  }
}

type Env = Record<string, string | undefined>;

export const SETUP_TOKEN_MIN = 32;
export const SETUP_TOKEN_MAX = 200;
export const CRON_TOKEN_MIN = 32;
export const CRON_TOKEN_MAX = 200;
export const DEFAULT_BACKUP_KEEP = 14;
const DEFAULT_ORIGIN = 'http://localhost:3000';
const DEV_DATA_DIR = '.data';
// Deterministic, public, throwaway key used only when NODE_ENV=test and no key is given.
const TEST_KEY = Buffer.alloc(32, 1);

/** Data directory from the environment: absolute, default `<cwd>/.data`. Shared with server/db/index.ts. */
export function resolveDataDir(env: Env, cwd: string = process.cwd()): string {
  const raw = env.DATA_DIR?.trim();
  return path.resolve(cwd, raw ? raw : DEV_DATA_DIR);
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const empty = (v: string | undefined) => v === undefined || v.trim() === '';

const schema = z.object({
  NODE_ENV: z.string().optional(),
  APP_ORIGIN: z.string().optional(),
  COOKIE_SECURE: z.string().optional(),
  DATA_DIR: z.string().optional(),
  ALLOW_DATA_IN_APP_DIR: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  TRUSTED_PROXY_HOPS: z.string().optional(),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  SETUP_TOKEN: z.string().optional(),
  CRON_TOKEN: z.string().optional(),
  BACKUP_KEEP: z.string().optional(),
  MAIL_OUTBOX_DIR: z.string().optional(),
});

function parseOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  return url.origin;
}

function parseKey(value: string): Buffer | null {
  // Canonical base64 of exactly 32 bytes: 43 characters + one "=".
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  return buf.length === 32 && buf.toString('base64') === value ? buf : null;
}

function parseBool(value: string | undefined): boolean | null | undefined {
  if (empty(value)) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function checkWritable(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    if (!fs.statSync(dir).isDirectory()) return 'is not a directory';
    return null;
  } catch {
    return 'must be a directory the app can create and write to';
  }
}

function plaintextAllowedRemote(value: string): boolean {
  const u = new URL(value);
  if (u.protocol !== 'smtp:' || u.searchParams.get('starttls') !== 'optional') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return !(host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));
}

export function loadConfig(env: Env, options: { cwd?: string } = {}): Config {
  const cwd = options.cwd ?? process.cwd();
  const raw = schema.parse(env);
  const issues: ConfigIssue[] = [];
  const bad = (key: string, message: string) => issues.push({ key, message });

  // NODE_ENV
  let nodeEnv: Config['nodeEnv'] = 'development';
  if (!empty(raw.NODE_ENV)) {
    if (raw.NODE_ENV === 'development' || raw.NODE_ENV === 'test' || raw.NODE_ENV === 'production') nodeEnv = raw.NODE_ENV;
    else bad('NODE_ENV', 'must be development, test or production');
  }
  const isProduction = nodeEnv === 'production';

  // APP_ORIGIN
  let appOrigin = DEFAULT_ORIGIN;
  if (!empty(raw.APP_ORIGIN)) {
    const origin = parseOrigin(raw.APP_ORIGIN!);
    if (origin) appOrigin = origin;
    else bad('APP_ORIGIN', 'must be a bare http(s) origin such as https://example.com (no path, credentials, query or fragment)');
  } else if (isProduction) {
    bad('APP_ORIGIN', 'is required in production');
  }
  if (isProduction && !appOrigin.startsWith('https://') && !issues.some((i) => i.key === 'APP_ORIGIN')) {
    bad('APP_ORIGIN', 'must use https in production');
  }

  // COOKIE_SECURE
  const secureFlag = parseBool(raw.COOKIE_SECURE);
  let cookieSecure = appOrigin.startsWith('https://');
  if (secureFlag === null) bad('COOKIE_SECURE', 'must be true or false');
  else if (secureFlag !== undefined) cookieSecure = secureFlag;
  if (isProduction && secureFlag === false) bad('COOKIE_SECURE', 'must be true in production');

  // DATA_DIR
  const dataDir = resolveDataDir(env, cwd);
  const allowFlag = parseBool(raw.ALLOW_DATA_IN_APP_DIR);
  if (allowFlag === null) bad('ALLOW_DATA_IN_APP_DIR', 'must be true or false');
  const allowDataInAppDir = allowFlag === true;
  if (isProduction) {
    if (!allowDataInAppDir && isInside(dataDir, cwd)) {
      bad('DATA_DIR', 'must be outside the application directory in production (or set ALLOW_DATA_IN_APP_DIR=true)');
    } else {
      const problem = checkWritable(dataDir);
      if (problem) bad('DATA_DIR', problem);
    }
  }

  // ENCRYPTION_KEY
  let encryptionKey: Buffer = TEST_KEY;
  if (!empty(raw.ENCRYPTION_KEY)) {
    const key = parseKey(raw.ENCRYPTION_KEY!.trim());
    if (key) encryptionKey = key;
    else bad('ENCRYPTION_KEY', 'must be base64 of exactly 32 bytes (generate one with: openssl rand -base64 32)');
  } else if (nodeEnv !== 'test') {
    bad('ENCRYPTION_KEY', 'is required (generate one with: openssl rand -base64 32)');
  }

  // TRUSTED_PROXY_HOPS
  let trustedProxyHops = 1;
  if (raw.TRUSTED_PROXY_HOPS !== undefined) {
    const v = raw.TRUSTED_PROXY_HOPS.trim();
    if (/^\d{1,2}$/.test(v)) trustedProxyHops = Number(v);
    else bad('TRUSTED_PROXY_HOPS', 'must be an integer from 0 to 99');
  }
  if (isProduction && trustedProxyHops === 0 && !issues.some((i) => i.key === 'TRUSTED_PROXY_HOPS')) {
    bad('TRUSTED_PROXY_HOPS', 'must be at least 1 in production (0 would put every visitor in one rate-limit bucket)');
  }

  // SMTP_URL / MAIL_FROM
  let smtpUrl: string | undefined;
  if (!empty(raw.SMTP_URL)) {
    const v = raw.SMTP_URL!.trim();
    let ok = false;
    try {
      const u = new URL(v);
      ok = (u.protocol === 'smtp:' || u.protocol === 'smtps:') && u.hostname !== '';
    } catch {
      ok = false;
    }
    if (ok && isProduction && plaintextAllowedRemote(v)) bad('SMTP_URL', 'must not allow plaintext SMTP to a non-loopback host in production (remove starttls=optional)');
    else if (ok) smtpUrl = v;
    else bad('SMTP_URL', 'must be an smtp:// or smtps:// URL');
  }
  const mailFrom = empty(raw.MAIL_FROM) ? undefined : raw.MAIL_FROM!.trim();

  // SETUP_TOKEN: enables the one-time first-owner page while the users table is empty. A short token is a
  // misconfiguration worth stopping on (it would be guessable), not something to silently ignore.
  let setupToken: string | undefined;
  if (!empty(raw.SETUP_TOKEN)) {
    const v = raw.SETUP_TOKEN!.trim();
    if (v.length >= SETUP_TOKEN_MIN && v.length <= SETUP_TOKEN_MAX && /^[\x21-\x7e]+$/.test(v)) setupToken = v;
    else bad('SETUP_TOKEN', `must be ${SETUP_TOKEN_MIN} to ${SETUP_TOKEN_MAX} printable characters without spaces (generate one with: openssl rand -hex 32)`);
  }

  // CRON_TOKEN: bearer token for POST /api/cron/backup (hPanel cron + curl). Unset = the route does not exist (404).
  let cronToken: string | undefined;
  if (!empty(raw.CRON_TOKEN)) {
    const v = raw.CRON_TOKEN!.trim();
    if (v.length >= CRON_TOKEN_MIN && v.length <= CRON_TOKEN_MAX && /^[\x21-\x7e]+$/.test(v)) cronToken = v;
    else bad('CRON_TOKEN', `must be ${CRON_TOKEN_MIN} to ${CRON_TOKEN_MAX} printable characters without spaces (generate one with: openssl rand -hex 32)`);
  }

  // BACKUP_KEEP
  let backupKeep = DEFAULT_BACKUP_KEEP;
  if (!empty(raw.BACKUP_KEEP)) {
    const v = raw.BACKUP_KEEP!.trim();
    if (/^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 365) backupKeep = Number(v);
    else bad('BACKUP_KEEP', 'must be an integer from 1 to 365');
  }

  // MAIL_OUTBOX_DIR: a plain-text copy of every mail (with its one-time links) is a credential store. Tests only.
  let mailOutboxDir: string | undefined;
  if (!empty(raw.MAIL_OUTBOX_DIR)) {
    if (isProduction) bad('MAIL_OUTBOX_DIR', 'must not be set in production (it would store invitation and reset links in clear text)');
    else mailOutboxDir = path.resolve(cwd, raw.MAIL_OUTBOX_DIR!.trim());
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return {
    nodeEnv,
    isProduction,
    appOrigin,
    cookieSecure,
    dataDir,
    allowDataInAppDir,
    encryptionKey,
    trustedProxyHops,
    smtpUrl,
    mailFrom,
    setupToken,
    cronToken,
    backupKeep,
    mailOutboxDir,
  };
}
