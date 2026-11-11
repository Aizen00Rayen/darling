// Server-only: never import this (or anything under server/) from a client component. The repo does not depend
// on the `server-only` package, so this is a convention enforced by review.
//
// Thin synchronous SQLite adapter. Primary driver: the built-in `node:sqlite` (Node >= 22.5, no native build).
// Fallback: `better-sqlite3` (optionalDependency), loaded lazily so a missing package never breaks the
// node:sqlite path. Both drivers are wrapped so they behave identically:
//   - positional (`?`) and named (`:a`, `@a`, `$a`, or bare) parameters; `undefined` is rejected
//   - booleans are stored as 0/1, bigint results come back as numbers, rows are plain objects
//   - statements are cached per connection
//
// Note: node:sqlite prints "ExperimentalWarning: SQLite is an experimental feature" the first time it is loaded
// (Node 22.x). It is filtered below, only for that single warning and only while the module is being required.
// If you prefer, `NODE_NO_WARNINGS=1` or `--disable-warning=ExperimentalWarning` does the same from outside.
import { createRequire } from 'node:module';
import path from 'node:path';

export type Scalar = string | number | bigint | boolean | null | Uint8Array;
export type Param = Scalar | Record<string, Scalar>;
export type DriverName = 'node:sqlite' | 'better-sqlite3';

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Db {
  exec(sql: string): void;
  get<T>(sql: string, ...params: Param[]): T | undefined;
  all<T>(sql: string, ...params: Param[]): T[];
  run(sql: string, ...params: Param[]): RunResult;
  /**
   * Runs `fn` atomically (synchronously: an async callback is refused). Outside a transaction this is
   * BEGIN IMMEDIATE (default) or BEGIN DEFERRED ... COMMIT/ROLLBACK; inside one it is a SAVEPOINT, so nested
   * calls never throw. An error rolls back to the start of this call and is rethrown.
   */
  transaction<T>(fn: (tx: Db) => T, mode?: 'immediate' | 'deferred'): T;
  close(): void;
}

export interface OpenOptions {
  driver?: DriverName;
  /** Open an existing file read-only; no pragma is run (so a backup copy is never modified, not even its journal mode). */
  readOnly?: boolean;
}

interface RawStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}
type RawFactory = (file: string, readOnly: boolean) => RawDatabase;

const PRAGMAS = ['PRAGMA journal_mode = WAL', 'PRAGMA foreign_keys = ON', 'PRAGMA busy_timeout = 5000', 'PRAGMA synchronous = NORMAL'];
const STATEMENT_CACHE_LIMIT = 200;

// --- drivers -------------------------------------------------------------------------------------------------

function loadNodeSqlite(): { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => RawDatabase } | undefined {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    const type = typeof rest[0] === 'string' ? rest[0] : typeof warning === 'string' ? '' : warning.name;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return (process.getBuiltinModule?.('node:sqlite') as never) ?? undefined;
  } catch {
    return undefined;
  } finally {
    process.emitWarning = original;
  }
}

function nodeSqliteFactory(): RawFactory | undefined {
  const mod = loadNodeSqlite();
  if (!mod?.DatabaseSync) return undefined;
  return (file, readOnly) => (readOnly ? new mod.DatabaseSync(file, { readOnly: true }) : new mod.DatabaseSync(file));
}

function betterSqliteFactory(): RawFactory | undefined {
  try {
    const req = createRequire(path.join(process.cwd(), 'noop.js'));
    const BetterSqlite = req('better-sqlite3') as new (file: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => RawDatabase;
    return (file, readOnly) => (readOnly ? new BetterSqlite(file, { readonly: true, fileMustExist: true }) : new BetterSqlite(file));
  } catch {
    return undefined;
  }
}

function pickFactory(driver?: DriverName): RawFactory {
  if (driver !== undefined && driver !== 'node:sqlite' && driver !== 'better-sqlite3') {
    throw new Error(`Unknown SQLite driver "${String(driver)}" (expected node:sqlite or better-sqlite3)`);
  }
  if (driver === 'node:sqlite') {
    const f = nodeSqliteFactory();
    if (!f) throw new Error('The node:sqlite driver is not available in this Node.js version (need >= 22.5)');
    return f;
  }
  if (driver === 'better-sqlite3') {
    const f = betterSqliteFactory();
    if (!f) throw new Error('The better-sqlite3 driver is not installed');
    return f;
  }
  const f = nodeSqliteFactory() ?? betterSqliteFactory();
  if (!f) throw new Error('No SQLite driver available: need Node >= 22.5 (node:sqlite) or the better-sqlite3 package');
  return f;
}

// --- value handling ------------------------------------------------------------------------------------------

function bindValue(value: unknown, where: string): Scalar {
  if (value === undefined) throw new TypeError(`SQLite parameter ${where} is undefined (use null for NULL)`);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) {
    return value;
  }
  throw new TypeError(`SQLite parameter ${where} has an unsupported type (${typeof value})`);
}

function isNamedBag(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && !Array.isArray(value);
}

function bindParams(params: Param[]): unknown[] {
  return params.map((p, i) => {
    if (isNamedBag(p)) {
      const bag: Record<string, Scalar> = {};
      // Both drivers accept bare names; strip an optional :, @ or $ prefix so callers may use either spelling.
      for (const [k, v] of Object.entries(p)) bag[k.replace(/^[:@$]/, '')] = bindValue(v, `"${k}"`);
      return bag;
    }
    return bindValue(p, `#${i + 1}`);
  });
}

function fromDb(value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

function plainRow<T>(row: unknown): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) out[k] = fromDb(v);
  return out as T;
}

// --- adapter -------------------------------------------------------------------------------------------------

let savepointSeq = 0;

function wrap(raw: RawDatabase): Db {
  const cache = new Map<string, RawStatement>();
  let depth = 0;
  let closed = false;

  const stmt = (sql: string): RawStatement => {
    if (closed) throw new Error('database is closed');
    let s = cache.get(sql);
    if (!s) {
      if (cache.size >= STATEMENT_CACHE_LIMIT) cache.clear();
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  const db: Db = {
    exec(sql) {
      if (closed) throw new Error('database is closed');
      raw.exec(sql);
    },
    get<T>(sql: string, ...params: Param[]) {
      const row = stmt(sql).get(...bindParams(params));
      return row === undefined || row === null ? undefined : plainRow<T>(row);
    },
    all<T>(sql: string, ...params: Param[]) {
      return stmt(sql)
        .all(...bindParams(params))
        .map((r) => plainRow<T>(r));
    },
    run(sql, ...params) {
      const r = stmt(sql).run(...bindParams(params));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    transaction<T>(fn: (tx: Db) => T, mode: 'immediate' | 'deferred' = 'immediate'): T {
      const outer = depth === 0;
      const name = `sp_${(savepointSeq += 1)}`;
      raw.exec(outer ? (mode === 'deferred' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE') : `SAVEPOINT ${name}`);
      depth += 1;
      let result: T;
      try {
        result = fn(db);
        if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
          throw new TypeError('transaction callbacks must be synchronous (got a Promise)');
        }
      } catch (err) {
        depth -= 1;
        rollback(outer, name);
        throw err;
      }
      depth -= 1;
      try {
        raw.exec(outer ? 'COMMIT' : `RELEASE ${name}`);
      } catch (err) {
        rollback(outer, name);
        throw err;
      }
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      raw.close();
    },
  };

  function rollback(outer: boolean, name: string): void {
    try {
      if (outer) raw.exec('ROLLBACK');
      else raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    } catch {
      /* the transaction was already ended by SQLite (e.g. after a fatal error); nothing left to undo */
    }
  }

  return db;
}

export function openDatabase(file: string, options: OpenOptions = {}): Db {
  const raw = pickFactory(options.driver)(file, options.readOnly === true);
  if (options.readOnly === true) return wrap(raw);
  try {
    for (const pragma of PRAGMAS) raw.exec(pragma);
  } catch (err) {
    raw.close();
    throw err;
  }
  return wrap(raw);
}

/** The driver `openDatabase` uses by default on this machine (node:sqlite first, then better-sqlite3). */
export function defaultDriverName(): DriverName | 'none' {
  if (nodeSqliteFactory()) return 'node:sqlite';
  return betterSqliteFactory() ? 'better-sqlite3' : 'none';
}
