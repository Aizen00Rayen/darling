import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './migrate';
import { openDatabase } from './sqlite';

const dirs: string[] = [];
function migrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-migrations-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('applyMigrations', () => {
  it('applies files in order and records them with checksum and time', () => {
    const db = openDatabase(':memory:');
    const dir = migrationsDir({
      '0002_b.sql': 'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));',
      '0001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
      'README.md': 'ignored',
      'notes.txt': 'ignored',
    });
    expect(applyMigrations(db, dir)).toEqual(['0001_a.sql', '0002_b.sql']);
    const rows = db.all<{ name: string; applied_at: number; checksum: string }>('SELECT * FROM _migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(rows[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.applied_at).toBeGreaterThan(1_600_000_000_000);
    expect(db.get('SELECT name FROM sqlite_master WHERE name = ?', 'b')).toBeTruthy();
  });

  it('is idempotent: a second run applies nothing', () => {
    const db = openDatabase(':memory:');
    const dir = migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);' });
    expect(applyMigrations(db, dir)).toEqual(['0001_a.sql']);
    expect(applyMigrations(db, dir)).toEqual([]);
    expect(db.get<{ c: number }>('SELECT count(*) AS c FROM _migrations')?.c).toBe(1);
  });

  it('applies only the new files on a later run', () => {
    const db = openDatabase(':memory:');
    const dir = migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);' });
    applyMigrations(db, dir);
    fs.writeFileSync(path.join(dir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    expect(applyMigrations(db, dir)).toEqual(['0002_b.sql']);
  });

  it('throws when an already applied migration was changed', () => {
    const db = openDatabase(':memory:');
    const dir = migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);' });
    applyMigrations(db, dir);
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);');
    expect(() => applyMigrations(db, dir)).toThrow(/0001_a\.sql.*(changed|checksum)/i);
  });

  it('rolls a failing migration back completely and leaves it unrecorded', () => {
    const db = openDatabase(':memory:');
    const dir = migrationsDir({
      '0001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
      '0002_bad.sql': 'CREATE TABLE ok_table (id INTEGER); INSERT INTO missing_table VALUES (1);',
    });
    expect(() => applyMigrations(db, dir)).toThrow(/0002_bad\.sql/);
    expect(db.get('SELECT name FROM sqlite_master WHERE name = ?', 'ok_table')).toBeUndefined();
    expect(db.all<{ name: string }>('SELECT name FROM _migrations')).toEqual([{ name: '0001_a.sql' }]);
  });

  it('rejects badly named .sql files instead of silently skipping them', () => {
    const db = openDatabase(':memory:');
    const dir = migrationsDir({ 'init.sql': 'SELECT 1;' });
    expect(() => applyMigrations(db, dir)).toThrow(/init\.sql/);
  });

  it('rejects duplicate migration numbers', () => {
    const db = openDatabase(':memory:');
    const dir = migrationsDir({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' });
    expect(() => applyMigrations(db, dir)).toThrow(/duplicate/i);
  });

  it('applies the shipped migrations by default (repo ./migrations)', () => {
    const db = openDatabase(':memory:');
    expect(applyMigrations(db)).toContain('0001_identity.sql');
  });
});
