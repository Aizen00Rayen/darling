import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock';
import type { Config } from '../config';
import { recordAudit } from '../audit';
import type { Db } from '../db/sqlite';
import { openDatabase } from '../db/sqlite';

// Backups of the SQLite database (spec section 6). `VACUUM INTO` writes a consistent, stand-alone copy of the
// live database (no -wal/-shm needed) while the app keeps running. The copy is verified before it counts, the
// newest BACKUP_KEEP files are kept. Everything here is synchronous SQLite work; createBackup is additionally
// queued so two requests never interleave (they are queued, not rejected).

export const BACKUP_DIR_NAME = 'backups';
/** darling-YYYYMMDD-HHMMSS[-N].sqlite, Algiers time; N only to tell two backups of the same second apart. */
export const BACKUP_NAME_RE = /^darling-(\d{8})-(\d{6})(?:-(\d{1,3}))?\.sqlite$/;

const ALGIERS_OFFSET_MS = 3_600_000;
const MAX_SAME_SECOND = 999;

export interface BackupResult {
  path: string;
  bytes: number;
  /** Epoch milliseconds, from the injected clock. */
  at: number;
}

export interface BackupInfo {
  name: string;
  path: string;
  bytes: number;
  /** File modification time, epoch ms. */
  modifiedAt: number;
}

export interface BackupContext {
  db: Db;
  clock: Clock;
  config: Pick<Config, 'dataDir' | 'backupKeep'>;
}

export interface BackupOptions {
  /** The user who asked for it; null when the system does (cron). */
  actorUserId: string | null;
  ip?: string;
  requestId?: string;
  /** Test seam: runs on the fresh copy before it is verified. */
  hooks?: { afterCopy?(file: string): void };
}

export function backupDir(dataDir: string): string {
  return path.join(dataDir, BACKUP_DIR_NAME);
}

/** `darling-YYYYMMDD-HHMMSS.sqlite` in Algiers time (a fixed UTC+1, no daylight saving). */
export function backupFileName(at: number, sequence = 1): string {
  const d = new Date(at + ALGIERS_OFFSET_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `darling-${stamp}${sequence > 1 ? `-${sequence}` : ''}.sqlite`;
}

function orderKey(name: string): [string, string, number] | null {
  const m = BACKUP_NAME_RE.exec(name);
  return m ? [m[1]!, m[2]!, m[3] ? Number(m[3]) : 1] : null;
}

function compareNewestFirst(a: string, b: string): number {
  const ka = orderKey(a)!;
  const kb = orderKey(b)!;
  return kb[0].localeCompare(ka[0]) || kb[1].localeCompare(ka[1]) || kb[2] - ka[2];
}

/** Backups present in <dataDir>/backups, newest first. Files that do not match the naming pattern are ignored. */
export function listBackups(dataDir: string): BackupInfo[] {
  const dir = backupDir(dataDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => BACKUP_NAME_RE.test(n));
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names.sort(compareNewestFirst)) {
    try {
      const st = fs.lstatSync(path.join(dir, name)); // lstat: a symlink planted in the directory is not a backup
      if (st.isFile()) out.push({ name, path: path.join(dir, name), bytes: st.size, modifiedAt: st.mtimeMs });
    } catch {
      /* vanished meanwhile */
    }
  }
  return out;
}

export function latestBackup(dataDir: string): BackupInfo | null {
  return listBackups(dataDir)[0] ?? null;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Opens the file READ-ONLY (it is never modified), runs `PRAGMA integrity_check` and checks it is a Darling
 * database (the migrations table lists at least the first migration).
 */
export function verifyBackupFile(file: string): Verdict {
  let db: Db | undefined;
  try {
    db = openDatabase(file, { readOnly: true });
    const rows = db.all<{ integrity_check: string }>('PRAGMA integrity_check');
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') return { ok: false, reason: 'integrity_check failed' };
    const applied = db.get<{ n: number }>('SELECT count(*) AS n FROM _migrations')?.n ?? 0;
    if (applied < 1) return { ok: false, reason: 'not a Darling database (no migrations recorded)' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.name : 'unreadable' };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function safeUnlink(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing more to do */
  }
}

function backupNow(ctx: BackupContext, options: BackupOptions): BackupResult {
  const dir = backupDir(ctx.config.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const at = ctx.clock.now();

  // Pick a name that is free (same-second collisions get -2, -3, ...).
  let sequence = 1;
  let name = backupFileName(at, sequence);
  while (fs.existsSync(path.join(dir, name))) {
    sequence += 1;
    if (sequence > MAX_SAME_SECOND) throw new Error('Too many backups in the same second');
    name = backupFileName(at, sequence);
  }
  const final = path.join(dir, name);
  // Written under a name that is not a backup name; renamed only once it is verified.
  const partial = `${final}.partial`;
  safeUnlink(partial);
  try {
    ctx.db.exec(`VACUUM INTO ${sqlString(partial)}`);
    options.hooks?.afterCopy?.(partial);
    const verdict = verifyBackupFile(partial);
    if (!verdict.ok) throw new Error(`Backup verification failed: ${verdict.reason}`);
    fs.renameSync(partial, final);
  } catch (err) {
    safeUnlink(partial);
    throw err;
  }
  const bytes = fs.statSync(final).size;

  recordAudit(ctx.db, {
    actorUserId: options.actorUserId,
    action: 'backup.created',
    entityType: 'backup',
    entityId: name,
    after: { bytes },
    ip: options.ip,
    requestId: options.requestId,
    at,
  });

  // Retention last, so a failed backup never deletes an older good one.
  for (const old of listBackups(ctx.config.dataDir).slice(ctx.config.backupKeep)) safeUnlink(old.path);
  return { path: final, bytes, at };
}

let queue: Promise<unknown> = Promise.resolve();

/** Creates, verifies and records a backup; concurrent calls run one after the other. */
export function createBackup(ctx: BackupContext, options: BackupOptions): Promise<BackupResult> {
  const run = queue.then(() => backupNow(ctx, options));
  queue = run.catch(() => undefined);
  return run;
}
