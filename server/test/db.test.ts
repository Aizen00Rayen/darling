import { describe, expect, it } from 'vitest';
import { createTestDb } from './db';

describe('createTestDb', () => {
  it('returns a migrated in-memory database and a fixed clock', () => {
    const { db, clock } = createTestDb();
    expect(db.get('SELECT name FROM sqlite_master WHERE name = ?', 'users')).toBeTruthy();
    expect(clock.now()).toBe(clock.now());
    clock.advance(10);
  });

  it('gives each call an isolated database', () => {
    const a = createTestDb().db;
    const b = createTestDb().db;
    a.run("INSERT INTO settings (key, value, updated_at) VALUES ('k', '1', 1)");
    expect(b.get('SELECT * FROM settings')).toBeUndefined();
  });
});
