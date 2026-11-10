import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db, type DriverName } from './sqlite';

function betterSqliteAvailable(): boolean {
  try {
    const db = openDatabase(':memory:', { driver: 'better-sqlite3' });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const drivers: DriverName[] = betterSqliteAvailable() ? ['node:sqlite', 'better-sqlite3'] : ['node:sqlite'];
const opened: Db[] = [];
const tmpDirs: string[] = [];

function open(driver: DriverName, file = ':memory:'): Db {
  const db = openDatabase(file, { driver });
  opened.push(db);
  return db;
}

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-sqlite-'));
  tmpDirs.push(dir);
  return path.join(dir, 'test.sqlite');
}

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.each(drivers)('sqlite adapter (%s)', (driver) => {
  it('creates, reads, updates and deletes rows', () => {
    const db = open(driver);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    const ins = db.run('INSERT INTO t (name) VALUES (?)', 'a');
    expect(ins).toEqual({ changes: 1, lastInsertRowid: 1 });
    db.run('INSERT INTO t (name) VALUES (?)', 'b');
    expect(db.get<{ id: number; name: string }>('SELECT * FROM t WHERE id = ?', 1)).toEqual({ id: 1, name: 'a' });
    expect(db.all<{ name: string }>('SELECT name FROM t ORDER BY id')).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(db.run('UPDATE t SET name = ? WHERE id = ?', 'z', 2).changes).toBe(1);
    expect(db.run('DELETE FROM t').changes).toBe(2);
    expect(db.get('SELECT * FROM t')).toBeUndefined();
  });

  it('returns plain objects and numbers, never bigint', () => {
    const db = open(driver);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)');
    const { lastInsertRowid } = db.run('INSERT INTO t (n) VALUES (?)', BigInt(5));
    expect(typeof lastInsertRowid).toBe('number');
    const row = db.get<{ id: number; n: number }>('SELECT * FROM t');
    expect(row).toEqual({ id: 1, n: 5 });
    expect(typeof row?.n).toBe('number');
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(db.get<{ c: number }>('SELECT count(*) AS c FROM t')?.c).toBe(1);
  });

  it('stores booleans as 0/1', () => {
    const db = open(driver);
    db.exec('CREATE TABLE t (b INTEGER)');
    db.run('INSERT INTO t (b) VALUES (?)', true);
    db.run('INSERT INTO t (b) VALUES (?)', false);
    expect(db.all<{ b: number }>('SELECT b FROM t ORDER BY rowid')).toEqual([{ b: 1 }, { b: 0 }]);
  });

  it('rejects undefined parameters (positional and named)', () => {
    const db = open(driver);
    db.exec('CREATE TABLE t (a TEXT, b TEXT)');
    expect(() => db.run('INSERT INTO t VALUES (?, ?)', 'x', undefined as never)).toThrow(/undefined/);
    expect(() => db.run('INSERT INTO t VALUES (:a, :b)', { a: 'x', b: undefined } as never)).toThrow(/undefined/);
    expect(db.get('SELECT count(*) AS c FROM t')).toEqual({ c: 0 });
  });

  it('supports named parameters (bare, colon, at, dollar prefixes)', () => {
    const db = open(driver);
    db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
    db.run('INSERT INTO t VALUES (:a, :b)', { a: 'x', b: true });
    db.run('INSERT INTO t VALUES (@a, @b)', { a: 'y', b: BigInt(7) });
    db.run('INSERT INTO t VALUES ($a, $b)', { ':a': 'z', $b: 3 });
    expect(db.all('SELECT * FROM t ORDER BY rowid')).toEqual([
      { a: 'x', b: 1 },
      { a: 'y', b: 7 },
      { a: 'z', b: 3 },
    ]);
  });

  it('handles NULL and blobs', () => {
    const db = open(driver);
    db.exec('CREATE TABLE t (a TEXT, b BLOB)');
    db.run('INSERT INTO t VALUES (?, ?)', null, new Uint8Array([1, 2, 3]));
    const row = db.get<{ a: null; b: Uint8Array }>('SELECT * FROM t');
    expect(row?.a).toBeNull();
    expect(Array.from(row?.b ?? [])).toEqual([1, 2, 3]);
  });

  it('applies the pragmas', () => {
    const db = open(driver, tmpFile());
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    expect(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(5000);
    expect(db.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous).toBe(1); // NORMAL
  });

  it('enforces foreign keys', () => {
    const db = open(driver);
    db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (p INTEGER REFERENCES p(id))');
    expect(() => db.run('INSERT INTO c VALUES (?)', 99)).toThrow(/FOREIGN KEY/);
  });

  describe('transactions', () => {
    function setup() {
      const db = open(driver);
      db.exec('CREATE TABLE t (n INTEGER)');
      return db;
    }
    const count = (db: Db) => db.get<{ c: number }>('SELECT count(*) AS c FROM t')?.c;

    it('commits and returns the callback result', () => {
      const db = setup();
      const out = db.transaction((tx) => {
        tx.run('INSERT INTO t VALUES (1)');
        return 'done';
      }, 'immediate');
      expect(out).toBe('done');
      expect(count(db)).toBe(1);
    });

    it('rolls back when the callback throws and rethrows the same error', () => {
      const db = setup();
      const boom = new Error('boom');
      expect(() =>
        db.transaction((tx) => {
          tx.run('INSERT INTO t VALUES (1)');
          throw boom;
        }),
      ).toThrow(boom);
      expect(count(db)).toBe(0);
      // the connection is usable and not stuck inside a transaction
      db.transaction((tx) => tx.run('INSERT INTO t VALUES (2)'));
      expect(count(db)).toBe(1);
    });

    it('is re-entrant: nested calls use savepoints and do not throw', () => {
      const db = setup();
      db.transaction((tx) => {
        tx.run('INSERT INTO t VALUES (1)');
        tx.transaction((inner) => {
          inner.run('INSERT INTO t VALUES (2)');
          inner.transaction((deep) => deep.run('INSERT INTO t VALUES (3)'), 'immediate');
        }, 'immediate');
      }, 'immediate');
      expect(count(db)).toBe(3);
    });

    it('rolls back only the inner savepoint when it throws and the outer catches', () => {
      const db = setup();
      db.transaction((tx) => {
        tx.run('INSERT INTO t VALUES (1)');
        expect(() =>
          tx.transaction((inner) => {
            inner.run('INSERT INTO t VALUES (2)');
            throw new Error('inner');
          }),
        ).toThrow('inner');
        tx.run('INSERT INTO t VALUES (3)');
      });
      expect(db.all<{ n: number }>('SELECT n FROM t ORDER BY n')).toEqual([{ n: 1 }, { n: 3 }]);
    });

    it('rolls everything back when an inner error propagates to the outer', () => {
      const db = setup();
      expect(() =>
        db.transaction((tx) => {
          tx.run('INSERT INTO t VALUES (1)');
          tx.transaction((inner) => {
            inner.run('INSERT INTO t VALUES (2)');
            throw new Error('inner');
          });
        }),
      ).toThrow('inner');
      expect(count(db)).toBe(0);
    });

    it('refuses an async callback instead of silently committing early', () => {
      const db = setup();
      expect(() => db.transaction((async () => 1) as never)).toThrow(/synchronous/);
      expect(count(db)).toBe(0);
      db.transaction((tx) => tx.run('INSERT INTO t VALUES (1)')); // still usable
      expect(count(db)).toBe(1);
    });

    it('BEGIN IMMEDIATE blocks a second writer connection until the first commits', () => {
      const file = tmpFile();
      const a = open(driver, file);
      a.exec('CREATE TABLE t (n INTEGER)');
      const b = open(driver, file);
      b.exec('PRAGMA busy_timeout = 0');

      a.transaction(() => {
        // a holds the write lock: b cannot start an immediate transaction
        expect(() => b.transaction((tx) => tx.run('INSERT INTO t VALUES (2)'), 'immediate')).toThrow(/locked|busy/i);
        // a deferred reader still works in WAL mode
        expect(b.get<{ c: number }>('SELECT count(*) AS c FROM t')?.c).toBe(0);
        a.run('INSERT INTO t VALUES (1)');
      }, 'immediate');

      b.transaction((tx) => tx.run('INSERT INTO t VALUES (2)'), 'immediate');
      expect(a.all<{ n: number }>('SELECT n FROM t ORDER BY n')).toEqual([{ n: 1 }, { n: 2 }]);
    });
  });

  it('close() makes later calls throw', () => {
    const db = open(driver);
    db.close();
    expect(() => db.get('SELECT 1')).toThrow();
  });
});

describe('driver selection', () => {
  it('defaults to a working driver', () => {
    const db = openDatabase(':memory:');
    opened.push(db);
    expect(db.get<{ one: number }>('SELECT 1 AS one')).toEqual({ one: 1 });
  });

  it('rejects an unknown driver name', () => {
    expect(() => openDatabase(':memory:', { driver: 'nope' as never })).toThrow(/driver/i);
  });
});
