import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './sqlite';

// Plain SQL migrations: migrations/NNNN_name.sql, applied in numeric order, each in ONE immediate transaction,
// recorded in _migrations with a sha256 checksum. A migration that was already applied must never change:
// the checksum is verified on every run and a mismatch throws (write a new migration instead).

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

// The app is always started from its root (npm start / next dev), so ./migrations is resolved once, at load time.
const APP_ROOT = process.cwd();

export function defaultMigrationsDir(): string {
  return path.join(APP_ROOT, 'migrations');
}

interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

function readMigrations(dir: string): Migration[] {
  const seen = new Map<string, string>();
  const out: Migration[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.sql')) continue;
    const m = FILE.exec(entry);
    if (!m) throw new Error(`Migration file "${entry}" must be named NNNN_name.sql (four digits, lower-case name)`);
    const prior = seen.get(m[1]!);
    if (prior) throw new Error(`Duplicate migration number ${m[1]}: "${prior}" and "${entry}"`);
    seen.set(m[1]!, entry);
    const sql = fs.readFileSync(path.join(dir, entry), 'utf8');
    out.push({ name: entry, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

/** Applies pending migrations and returns the names applied in this call. */
export function applyMigrations(db: Db, dir: string = defaultMigrationsDir()): string[] {
  const migrations = readMigrations(dir);
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)');

  const applied: string[] = [];
  for (const migration of migrations) {
    db.transaction((tx) => {
      // Re-checked inside the write lock: another process may have applied it a moment ago.
      const done = tx.get<{ checksum: string }>('SELECT checksum FROM _migrations WHERE name = ?', migration.name);
      if (done) {
        if (done.checksum !== migration.checksum) {
          throw new Error(`Migration ${migration.name} was changed after it was applied (checksum mismatch). Add a new migration instead.`);
        }
        return;
      }
      try {
        tx.exec(migration.sql);
      } catch (err) {
        throw new Error(`Migration ${migration.name} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      tx.run('INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, ?, ?)', migration.name, Date.now(), migration.checksum);
      applied.push(migration.name);
    }, 'immediate');
  }
  return applied;
}
