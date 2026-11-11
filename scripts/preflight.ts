import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { ConfigError, CRON_TOKEN_MIN, isInside, loadConfig, resolveDataDir, SETUP_TOKEN_MAX, SETUP_TOKEN_MIN } from '../server/config';
import { openDatabase } from '../server/db/sqlite';
import { describeSmtp } from '../server/diagnostics/diagnostics';

// Pre-launch checklist:  npm run preflight [-- --json]
// Reads the environment exactly like the app does (server/config.ts rules) and prints OK / WARN / FAIL per item.
// Exit code 1 when anything FAILS. It never prints a secret: only whether a value is present and valid.

export type Status = 'ok' | 'warn' | 'fail';
export interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
}
export interface PreflightResult {
  ok: boolean;
  checks: Check[];
}
export interface PreflightOptions {
  cwd?: string;
  nodeVersion?: string;
  /** Number of rows in `users`; null = unknown; undefined = read it from <DATA_DIR>/darling.sqlite. */
  usersCount?: number | null;
  /** Free bytes on the data volume; null = unknown; undefined = measure. */
  freeBytes?: number | null;
}

type Env = Record<string, string | undefined>;

const MB = 1024 * 1024;
const FAIL_FREE_BYTES = 50 * MB;
const WARN_FREE_BYTES = 500 * MB;

const blank = (v: string | undefined) => v === undefined || v.trim() === '';

function nearestExisting(p: string): string | null {
  let current = p;
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function freeSpace(dataDir: string): number | null {
  const at = nearestExisting(dataDir);
  if (!at) return null;
  try {
    const s = fs.statfsSync(at);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function readUsersCount(dataDir: string): number | null {
  const file = path.join(dataDir, 'darling.sqlite');
  if (!fs.existsSync(file)) return 0;
  try {
    const db = openDatabase(file, { readOnly: true });
    try {
      return db.get<{ n: number }>('SELECT count(*) AS n FROM users')?.n ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} Go` : `${Math.round(bytes / MB)} Mo`;
}

export function runPreflight(env: Env, options: PreflightOptions = {}): PreflightResult {
  const cwd = options.cwd ?? process.cwd();
  const checks: Check[] = [];
  const add = (id: string, label: string, status: Status, detail: string) => checks.push({ id, label, status, detail });

  // Node.js
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const major = Number(nodeVersion.split('.')[0]);
  add('node', 'Node.js >= 22', major >= 22 ? 'ok' : 'fail', major >= 22 ? `version ${nodeVersion}` : `version ${nodeVersion}: choose Node.js 22 (or 24) in hPanel`);

  // NODE_ENV
  add('node_env', 'NODE_ENV=production', env.NODE_ENV === 'production' ? 'ok' : 'fail', env.NODE_ENV === 'production' ? 'production' : 'must be exactly "production"');

  // APP_ORIGIN
  let originProblem: string | null = null;
  if (blank(env.APP_ORIGIN)) originProblem = 'is not set (example: https://darling7.store)';
  else {
    try {
      const u = new URL(env.APP_ORIGIN!.trim());
      if (u.protocol !== 'https:') originProblem = 'must start with https://';
      else if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) originProblem = 'must be a bare origin: no path, query or credentials';
    } catch {
      originProblem = 'is not a valid URL (example: https://darling7.store)';
    }
  }
  add('app_origin', 'APP_ORIGIN uses https', originProblem ? 'fail' : 'ok', originProblem ?? 'https origin');

  // COOKIE_SECURE
  add('cookie_secure', 'COOKIE_SECURE=true', env.COOKIE_SECURE === 'true' ? 'ok' : 'fail', env.COOKIE_SECURE === 'true' ? 'true' : 'must be exactly "true"');

  // ENCRYPTION_KEY
  const key = env.ENCRYPTION_KEY?.trim();
  const keyOk = key !== undefined && /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').length === 32 && Buffer.from(key, 'base64').toString('base64') === key;
  add(
    'encryption_key',
    'ENCRYPTION_KEY is 32 bytes (base64)',
    keyOk ? 'ok' : 'fail',
    keyOk ? 'valid (value not shown)' : blank(key) ? 'is not set (generate: openssl rand -base64 32)' : 'is not base64 of exactly 32 bytes (generate: openssl rand -base64 32)',
  );

  // DATA_DIR
  const dataDirSet = !blank(env.DATA_DIR);
  add('data_dir_set', 'DATA_DIR is set', dataDirSet ? 'ok' : 'fail', dataDirSet ? 'set' : 'is not set: the database would live inside the app folder and could be wiped by a redeploy');
  const dataDir = resolveDataDir(env, cwd);
  const outside = !isInside(dataDir, cwd);
  add('data_dir_outside_app', 'DATA_DIR is outside the app folder', outside ? 'ok' : 'fail', outside ? dataDir : `${dataDir} is inside ${cwd}: a redeploy can erase it`);

  let writableProblem: string | null = null;
  try {
    if (fs.existsSync(dataDir)) {
      if (!fs.statSync(dataDir).isDirectory()) writableProblem = 'exists but is not a folder';
      else fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
    } else {
      const parent = nearestExisting(dataDir);
      if (!parent || !fs.statSync(parent).isDirectory()) writableProblem = 'cannot be created here';
      else fs.accessSync(parent, fs.constants.W_OK);
    }
  } catch {
    writableProblem = 'is not writable by the app (check the path and permissions)';
  }
  const existed = fs.existsSync(dataDir);
  add('data_dir_writable', 'DATA_DIR is writable', writableProblem ? 'fail' : 'ok', writableProblem ?? (existed ? 'exists and is writable' : 'does not exist yet; it will be created at first start'));

  const free = options.freeBytes !== undefined ? options.freeBytes : freeSpace(dataDir);
  if (free === null) add('data_dir_space', 'Free disk space', 'warn', 'could not be measured');
  else if (free < FAIL_FREE_BYTES) add('data_dir_space', 'Free disk space', 'fail', `${formatSize(free)} free: too little for the database and backups`);
  else if (free < WARN_FREE_BYTES) add('data_dir_space', 'Free disk space', 'warn', `${formatSize(free)} free: getting low`);
  else add('data_dir_space', 'Free disk space', 'ok', `${formatSize(free)} free`);

  // TRUSTED_PROXY_HOPS
  let hops = 1;
  let hopsProblem: string | null = null;
  if (env.TRUSTED_PROXY_HOPS !== undefined) {
    const v = env.TRUSTED_PROXY_HOPS.trim();
    if (/^\d{1,2}$/.test(v)) hops = Number(v);
    else hopsProblem = 'must be a whole number from 1 to 99';
  }
  if (!hopsProblem && hops < 1) hopsProblem = 'must be at least 1 in production (0 puts every visitor in one rate-limit bucket)';
  add('trusted_proxy_hops', 'TRUSTED_PROXY_HOPS >= 1', hopsProblem ? 'fail' : 'ok', hopsProblem ?? `${hops} (confirm on /admin/diagnostics after deploying)`);

  // SETUP_TOKEN
  const usersCount = options.usersCount !== undefined ? options.usersCount : readUsersCount(dataDir);
  const setup = env.SETUP_TOKEN?.trim();
  const setupValid = setup !== undefined && setup !== '' && setup.length >= SETUP_TOKEN_MIN && setup.length <= SETUP_TOKEN_MAX && /^[\x21-\x7e]+$/.test(setup);
  if (usersCount === 0) {
    if (setupValid) add('setup_token', 'SETUP_TOKEN (first owner)', 'ok', 'set (value not shown): remove it after the first owner exists');
    else if (blank(setup)) add('setup_token', 'SETUP_TOKEN (first owner)', 'fail', `no user exists yet and SETUP_TOKEN is not set: set ${SETUP_TOKEN_MIN}+ characters (openssl rand -hex 32), open /configuration, then remove it`);
    else add('setup_token', 'SETUP_TOKEN (first owner)', 'fail', `must be ${SETUP_TOKEN_MIN} to ${SETUP_TOKEN_MAX} printable characters without spaces`);
  } else if (usersCount === null) {
    add('setup_token', 'SETUP_TOKEN (first owner)', blank(setup) ? 'warn' : 'ok', blank(setup) ? 'not set; could not read the database to know whether an owner exists' : 'set; could not read the database: remove it after the first owner exists');
  } else if (blank(setup)) {
    add('setup_token', 'SETUP_TOKEN (first owner)', 'ok', 'not set (good: an owner exists)');
  } else {
    add('setup_token', 'SETUP_TOKEN (first owner)', 'warn', 'an owner already exists: remove SETUP_TOKEN from the environment');
  }

  // CRON_TOKEN
  const cron = env.CRON_TOKEN?.trim();
  const cronOk = cron !== undefined && cron.length >= CRON_TOKEN_MIN && cron.length <= 200 && /^[\x21-\x7e]+$/.test(cron);
  add('cron_token', 'CRON_TOKEN (automatic backups)', cronOk ? 'ok' : 'fail', cronOk ? 'set (value not shown)' : blank(cron) ? `is not set: the backup cron endpoint stays disabled (openssl rand -hex 32)` : `must be at least ${CRON_TOKEN_MIN} printable characters without spaces`);

  // SMTP_URL
  if (blank(env.SMTP_URL)) {
    add('smtp_url', 'SMTP_URL (e-mails)', 'fail', 'is not set: invitations and password resets cannot be sent');
  } else {
    const info = describeSmtp(env.SMTP_URL!.trim());
    let plaintextRemote = false;
    try {
      const u = new URL(env.SMTP_URL!.trim());
      const host = u.hostname.toLowerCase();
      const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
      plaintextRemote = u.protocol === 'smtp:' && u.searchParams.get('starttls') === 'optional' && !loopback;
    } catch {
      /* describeSmtp already says "not configured" */
    }
    if (!info.configured) add('smtp_url', 'SMTP_URL (e-mails)', 'fail', 'is not a valid smtp:// or smtps:// URL (example: smtps://user:password@smtp.hostinger.com:465)');
    else if (plaintextRemote) add('smtp_url', 'SMTP_URL (e-mails)', 'fail', `${info.host}:${info.port} would send in clear text: remove starttls=optional`);
    else {
      const tls = info.tls === 'implicit' ? 'TLS implicite' : info.tls === 'starttls' ? 'STARTTLS obligatoire' : 'STARTTLS facultatif';
      add('smtp_url', 'SMTP_URL (e-mails)', info.tls === 'opportunistic' ? 'warn' : 'ok', `${info.host}:${info.port}, ${tls}`);
    }
  }

  // MAIL_FROM
  const from = env.MAIL_FROM?.trim();
  const fromOk = from !== undefined && /^(?:[^<>@\r\n]*<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(from);
  add('mail_from', 'MAIL_FROM', fromOk ? 'ok' : 'fail', fromOk ? 'set' : blank(from) ? 'is not set: use the address of your Hostinger mailbox, e.g. DARLING* <no-reply@darling7.store>' : 'is not an e-mail address');

  // The app's own validation (what runs at start-up), keys only. Like the app at start-up, this creates DATA_DIR if it is missing.
  try {
    loadConfig(env, { cwd });
    add('app_config', 'The app accepts this configuration', 'ok', 'all start-up checks pass');
  } catch (err) {
    if (err instanceof ConfigError) add('app_config', 'The app accepts this configuration', 'fail', `the app would refuse to start: ${err.keys.join(', ')}`);
    else add('app_config', 'The app accepts this configuration', 'fail', 'configuration could not be read');
  }

  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

export interface MainIo {
  stdout: (text: string) => void;
  options?: PreflightOptions;
}
const processIo: MainIo = { stdout: (t) => void process.stdout.write(t) };

const TAG: Record<Status, string> = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };

export function main(argv: string[], env: Env, io: MainIo = processIo): number {
  const flags = argv.filter((a) => a !== '--');
  const unknown = flags.filter((a) => a !== '--json');
  if (unknown.length > 0) {
    io.stdout(`Unknown option: ${unknown.join(' ')}\nUsage: npm run preflight [-- --json]\n`);
    return 2;
  }
  const result = runPreflight(env, io.options);
  if (flags.includes('--json')) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  const lines = result.checks.map((c) => `${TAG[c.status]} ${c.label}: ${c.detail}`);
  const failures = result.checks.filter((c) => c.status === 'fail').length;
  const warnings = result.checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(
    failures > 0
      ? `${failures} problem${failures > 1 ? 's' : ''} to fix before going live${warnings ? `, ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}.`
      : `Ready to deploy${warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''} to read)` : ''}.`,
  );
  io.stdout(`${lines.join('\n')}\n`);
  return failures > 0 ? 1 : 0;
}

function isRunDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return /[\\/]scripts[\\/]preflight\.[cm]?[jt]s$/.test(realpathSync(entry));
  } catch {
    return false;
  }
}

if (isRunDirectly()) process.exitCode = main(process.argv.slice(2), process.env);
