import fs from 'node:fs';
import path from 'node:path';
import { isInside, resolveDataDir } from '../config';
import { applyMigrations } from './migrate';
import { openDatabase, type Db } from './sqlite';

// Server-only. `getDb()` opens <DATA_DIR>/darling.sqlite once per process (and per DATA_DIR), applies pending
// migrations on first use and returns the same connection afterwards. The connection is kept on globalThis so
// Next.js dev reloads and duplicated module instances share it.

const KEY = Symbol.for('darling.db');

interface Holder {
  dir?: string;
  db?: Db;
  override?: Db | null;
}

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder | undefined>;
  return (g[KEY] ??= {});
}

export function getDb(): Db {
  const h = holder();
  if (h.override) return h.override;

  const cwd = process.cwd();
  const dir = resolveDataDir(process.env, cwd);
  if (h.db && h.dir === dir) return h.db;

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DATA_IN_APP_DIR !== 'true' && isInside(dir, cwd)) {
    throw new Error(
      `DATA_DIR (${dir}) is inside the application directory; a redeploy could wipe the database. ` +
        'Point DATA_DIR outside the app (or set ALLOW_DATA_IN_APP_DIR=true to accept the risk).',
    );
  }

  if (h.db) closeDb(); // DATA_DIR changed: drop the old connection
  fs.mkdirSync(dir, { recursive: true });
  const db = openDatabase(path.join(dir, 'darling.sqlite'));
  try {
    applyMigrations(db);
  } catch (err) {
    db.close();
    throw err;
  }
  h.db = db;
  h.dir = dir;
  return db;
}

/** Closes the process-wide connection (it reopens on the next getDb()). */
export function closeDb(): void {
  const h = holder();
  h.db?.close();
  h.db = undefined;
  h.dir = undefined;
}

/** Tests: make getDb() return this database (pass null to go back to the real one). */
export function setDbForTests(db: Db | null): void {
  holder().override = db;
}
