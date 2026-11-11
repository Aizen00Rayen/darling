import fs from 'node:fs';
import path from 'node:path';
import type { ServerContext } from '../context';
import { isInside } from '../config';
import { listBackups } from '../backup/backup';
import { defaultDriverName } from '../db/sqlite';
import { isUnidentifiable } from '../net/client-ip';

// Everything the owner's diagnostics page shows. NEVER include a secret: no key, token, password or SMTP
// credential; only whether each one is set, plus the non-secret parts of the SMTP URL (host, port, TLS mode).
// The raw proxy headers are the owner's OWN request's, shown to check the real address reaches the app.

export type IpVerdict = 'real' | 'local_or_unknown';

export function ipVerdictFor(ip: string): IpVerdict {
  return isUnidentifiable(ip) ? 'local_or_unknown' : 'real';
}

export type SmtpInfo = { configured: false } | { configured: true; host: string; port: number; tls: 'implicit' | 'starttls' | 'opportunistic' };

export function describeSmtp(smtpUrl: string | undefined): SmtpInfo {
  if (!smtpUrl) return { configured: false };
  try {
    const u = new URL(smtpUrl);
    if ((u.protocol !== 'smtp:' && u.protocol !== 'smtps:') || !u.hostname) return { configured: false };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const secure = u.protocol === 'smtps:';
    const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
    const mode = u.searchParams.get('starttls');
    const tls = secure ? 'implicit' : mode === 'optional' || (mode === null && loopback) ? 'opportunistic' : 'starttls';
    return { configured: true, host, port: u.port ? Number(u.port) : secure ? 465 : 587, tls };
  } catch {
    return { configured: false };
  }
}

const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip'] as const;

export interface Diagnostics {
  request: {
    clientIp: string;
    trustedProxyHops: number;
    verdict: IpVerdict;
    headers: Record<(typeof PROXY_HEADERS)[number], string | null>;
  };
  runtime: { node: string; sqliteDriver: string; nodeEnv: string; uptimeSeconds: number; startedAt: number };
  dataDir: { path: string; exists: boolean; writable: boolean; freeBytes: number | null; insideAppDir: boolean };
  database: { fileBytes: number | null; migrationsApplied: number; latestMigration: string | null };
  backups: { count: number; latest: { name: string; bytes: number; at: number } | null; keep: number };
  config: {
    appOrigin: string;
    cookieSecure: boolean;
    smtp: SmtpInfo;
    mailFromSet: boolean;
    cronTokenSet: boolean;
    setupTokenSet: boolean;
  };
}

function freeSpace(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function collectDiagnostics(ctx: Pick<ServerContext, 'db' | 'clock' | 'config'>, headers: Headers, ip: string): Diagnostics {
  const { config } = ctx;
  const dir = config.dataDir;
  const exists = fs.existsSync(dir);

  let fileBytes: number | null = null;
  try {
    fileBytes = fs.statSync(path.join(dir, 'darling.sqlite')).size;
  } catch {
    fileBytes = null;
  }

  const migrations = ctx.db.all<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
  const backups = listBackups(dir);
  const latest = backups[0];

  const uptimeSeconds = Math.max(1, Math.round(process.uptime()));
  return {
    request: {
      clientIp: ip,
      trustedProxyHops: config.trustedProxyHops,
      verdict: ipVerdictFor(ip),
      headers: Object.fromEntries(PROXY_HEADERS.map((h) => [h, headers.get(h)])) as Diagnostics['request']['headers'],
    },
    runtime: {
      node: process.versions.node,
      sqliteDriver: defaultDriverName(),
      nodeEnv: config.nodeEnv,
      uptimeSeconds,
      startedAt: ctx.clock.now() - uptimeSeconds * 1000,
    },
    dataDir: { path: dir, exists, writable: exists && writable(dir), freeBytes: exists ? freeSpace(dir) : null, insideAppDir: isInside(dir, process.cwd()) },
    database: { fileBytes, migrationsApplied: migrations.length, latestMigration: migrations.at(-1)?.name ?? null },
    backups: { count: backups.length, latest: latest ? { name: latest.name, bytes: latest.bytes, at: latest.modifiedAt } : null, keep: config.backupKeep },
    config: {
      appOrigin: config.appOrigin,
      cookieSecure: config.cookieSecure,
      smtp: describeSmtp(config.smtpUrl),
      mailFromSet: config.mailFrom !== undefined,
      cronTokenSet: config.cronToken !== undefined,
      setupTokenSet: config.setupToken !== undefined,
    },
  };
}
