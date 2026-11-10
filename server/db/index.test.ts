import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, setDbForTests } from './index';
import { openDatabase } from './sqlite';

const saved = { ...process.env };
const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-dbindex-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  closeDb();
});
afterEach(() => {
  closeDb();
  setDbForTests(null);
  process.env = { ...saved };
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('getDb', () => {
  it('creates DATA_DIR and <DATA_DIR>/darling.sqlite, applies migrations, and returns a singleton', () => {
    const dir = path.join(tmp(), 'nested', 'data');
    process.env.DATA_DIR = dir;
    const db = getDb();
    expect(fs.existsSync(path.join(dir, 'darling.sqlite'))).toBe(true);
    expect(db.get('SELECT name FROM _migrations WHERE name = ?', '0001_identity.sql')).toBeTruthy();
    expect(getDb()).toBe(db);
  });

  it('is keyed by DATA_DIR: another directory gives another database', () => {
    process.env.DATA_DIR = tmp();
    const a = getDb();
    process.env.DATA_DIR = tmp();
    const b = getDb();
    expect(b).not.toBe(a);
  });

  it('persists data across a close and reopen', () => {
    process.env.DATA_DIR = tmp();
    getDb().run("INSERT INTO settings (key, value, updated_at) VALUES ('k', '1', 1)");
    closeDb();
    expect(getDb().get('SELECT key FROM settings')).toEqual({ key: 'k' });
  });

  it('defaults DATA_DIR to ./.data under the working directory in development', () => {
    const cwd = tmp();
    const spy = process.cwd;
    process.cwd = () => cwd;
    try {
      delete process.env.DATA_DIR;
      Object.assign(process.env, { NODE_ENV: 'development' });
      getDb();
      expect(fs.existsSync(path.join(cwd, '.data', 'darling.sqlite'))).toBe(true);
    } finally {
      process.cwd = spy;
    }
  });

  it('in production refuses a DATA_DIR inside the app directory unless ALLOW_DATA_IN_APP_DIR=true', () => {
    const cwd = tmp();
    const spy = process.cwd;
    process.cwd = () => cwd;
    try {
      Object.assign(process.env, { NODE_ENV: 'production', DATA_DIR: path.join(cwd, 'data') });
      delete process.env.ALLOW_DATA_IN_APP_DIR;
      expect(() => getDb()).toThrow(/DATA_DIR/);
      expect(fs.existsSync(path.join(cwd, 'data'))).toBe(false);
      process.env.ALLOW_DATA_IN_APP_DIR = 'true';
      expect(() => getDb()).not.toThrow();
    } finally {
      process.cwd = spy;
    }
  });

  it('setDbForTests overrides and restores', () => {
    const fake = openDatabase(':memory:');
    setDbForTests(fake);
    expect(getDb()).toBe(fake);
    setDbForTests(null);
    process.env.DATA_DIR = tmp();
    expect(getDb()).not.toBe(fake);
  });
});
