import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@/shared/permissions';
import { ROLES, USER_STATUSES } from '@/shared/roles';
import { createTestDb } from '../test/db';
import type { Db } from './sqlite';

let db: Db;
beforeEach(() => {
  ({ db } = createTestDb());
});

const NOW = 1_700_000_000_000;

function user(over: Record<string, unknown> = {}) {
  const row = {
    id: 'u1',
    email: 'owner@example.com',
    full_name: 'Owner',
    role: 'super_manager',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  const cols = Object.keys(row);
  db.run(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...(Object.values(row) as never[]));
  return row;
}

describe('0001_identity schema', () => {
  it('creates the identity and order tables', () => {
    const names = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((r) => r.name);
    expect(names).toEqual(['_migrations', 'audit_log', 'auth_tokens', 'login_events', 'order_status_history', 'orders', 'sessions', 'settings', 'user_permissions', 'users']);
  });

  describe('users', () => {
    it('applies defaults', () => {
      user();
      expect(db.get('SELECT status, is_owner, totp_enabled, failed_logins, password_hash, phone, locked_until FROM users')).toEqual({
        status: 'invited',
        is_owner: 0,
        totp_enabled: 0,
        failed_logins: 0,
        password_hash: null,
        phone: null,
        locked_until: null,
      });
    });

    it('treats email as unique case-insensitively', () => {
      user();
      expect(() => user({ id: 'u2', email: 'owner@example.com' })).toThrow(/UNIQUE/);
      expect(() => user({ id: 'u3', email: 'OWNER@example.com' })).toThrow(/CHECK|UNIQUE/); // blocked either way
      expect(db.get('SELECT id FROM users WHERE email = ?', 'Owner@Example.COM')).toEqual({ id: 'u1' });
    });

    it('requires a lower-cased, trimmed email', () => {
      expect(() => user({ email: 'Mixed@Example.com' })).toThrow(/CHECK/);
      expect(() => user({ email: ' padded@example.com' })).toThrow(/CHECK/);
      expect(() => user({ email: 'padded@example.com ' })).toThrow(/CHECK/);
      expect(() => user({ email: 'ok@example.com' })).not.toThrow();
    });

    it('limits role and status to the shared lists', () => {
      for (const role of ROLES) expect(() => user({ id: `r-${role}`, email: `${role}@x.io`, role })).not.toThrow();
      expect(() => user({ id: 'bad', email: 'bad@x.io', role: 'admin' })).toThrow(/CHECK/);
      for (const status of USER_STATUSES) expect(() => user({ id: `s-${status}`, email: `${status}@x.io`, status })).not.toThrow();
      expect(() => user({ id: 'bad2', email: 'bad2@x.io', status: 'banned' })).toThrow(/CHECK/);
    });

    it('stores booleans only as 0/1', () => {
      expect(() => user({ totp_enabled: 2 })).toThrow(/CHECK/);
      expect(() => user({ id: 'u3', email: 'u3@x.io', is_owner: 5 })).toThrow(/CHECK/);
    });

    it('only super managers can be owners', () => {
      expect(() => user({ is_owner: 1 })).not.toThrow();
      expect(() => user({ id: 'u2', email: 'u2@x.io', role: 'sub_manager', is_owner: 1 })).toThrow(/CHECK/);
      expect(() => user({ id: 'u3', email: 'u3@x.io', role: 'affiliate', is_owner: 1 })).toThrow(/CHECK/);
      expect(() => user({ id: 'u4', email: 'u4@x.io', role: 'sub_manager', is_owner: 0 })).not.toThrow();
      // demoting an owner without clearing the flag is rejected too
      expect(() => db.run("UPDATE users SET role = 'affiliate' WHERE id = 'u1'")).toThrow(/CHECK/);
    });

    it('requires full_name, role and timestamps', () => {
      expect(() => db.run("INSERT INTO users (id, email, role, created_at, updated_at) VALUES ('x','x@x.io','affiliate',1,1)")).toThrow(/NOT NULL/);
      expect(() => db.run("INSERT INTO users (id, email, full_name, role) VALUES ('x','x@x.io','X','affiliate')")).toThrow(/NOT NULL/);
    });
  });

  describe('user_permissions', () => {
    it('accepts every shared permission and rejects unknown ones', () => {
      user();
      for (const p of PERMISSIONS) db.run('INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)', 'u1', p);
      expect(() => db.run("INSERT INTO user_permissions VALUES ('u1', 'root.all')")).toThrow(/CHECK/);
      expect(() => db.run("INSERT INTO user_permissions VALUES ('u1', 'users.manage')")).toThrow(/UNIQUE|PRIMARY/);
    });

    it('requires an existing user and cascades on delete', () => {
      expect(() => db.run("INSERT INTO user_permissions VALUES ('ghost', 'users.manage')")).toThrow(/FOREIGN KEY/);
      user();
      db.run("INSERT INTO user_permissions VALUES ('u1', 'users.manage')");
      db.run("DELETE FROM users WHERE id = 'u1'");
      expect(db.get('SELECT * FROM user_permissions')).toBeUndefined();
    });
  });

  describe('sessions and auth_tokens', () => {
    it('sessions: unique token hash, cascade delete, boolean remember', () => {
      user();
      const ins = (id: string, hash: string, remember = 0) =>
        db.run(
          'INSERT INTO sessions (id, token_hash, user_id, remember, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?)',
          id, hash, 'u1', remember, NOW, NOW, NOW + 1000,
        );
      ins('s1', 'h1');
      expect(() => ins('s2', 'h1')).toThrow(/UNIQUE/);
      expect(() => ins('s3', 'h3', 2)).toThrow(/CHECK/);
      expect(db.get('SELECT revoked_at, ip FROM sessions')).toEqual({ revoked_at: null, ip: null });
      db.run("DELETE FROM users WHERE id = 'u1'");
      expect(db.get('SELECT * FROM sessions')).toBeUndefined();
    });

    it('auth_tokens: type limited to invite / password_reset, unique token hash, cascade', () => {
      user();
      const ins = (id: string, type: string, hash: string) =>
        db.run('INSERT INTO auth_tokens (id, user_id, type, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)', id, 'u1', type, hash, NOW + 1000, NOW);
      ins('t1', 'invite', 'a');
      ins('t2', 'password_reset', 'b');
      expect(() => ins('t3', 'magic_link', 'c')).toThrow(/CHECK/);
      expect(() => ins('t4', 'invite', 'a')).toThrow(/UNIQUE/);
      db.run("DELETE FROM users WHERE id = 'u1'");
      expect(db.get('SELECT * FROM auth_tokens')).toBeUndefined();
    });
  });

  describe('login_events', () => {
    it('keeps the row (user_id set to NULL) when the user is deleted', () => {
      user();
      db.run('INSERT INTO login_events (user_id, email_tried, success, at) VALUES (?, ?, ?, ?)', 'u1', 'owner@example.com', false, NOW);
      db.run("DELETE FROM users WHERE id = 'u1'");
      expect(db.get('SELECT user_id, email_tried, success FROM login_events')).toEqual({ user_id: null, email_tried: 'owner@example.com', success: 0 });
    });

    it('has an index on (email_tried, at) used for the lockout/throttle lookup', () => {
      const idx = db.all<{ name: string }>("SELECT name FROM pragma_index_list('login_events')").map((r) => r.name);
      expect(idx.length).toBeGreaterThan(0);
      const plan = db
        .all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT count(*) FROM login_events WHERE email_tried = 'a' AND at > 5")
        .map((r) => r.detail)
        .join(' ');
      expect(plan).toMatch(/USING (COVERING )?INDEX/);
    });

    it('assigns increasing integer ids', () => {
      for (let i = 0; i < 3; i += 1) db.run('INSERT INTO login_events (email_tried, success, at) VALUES (?, 1, ?)', 'a@b.c', NOW + i);
      expect(db.all<{ id: number }>('SELECT id FROM login_events ORDER BY id').map((r) => r.id)).toEqual([1, 2, 3]);
    });
  });

  describe('audit_log', () => {
    const add = () =>
      db.run(
        'INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before, after, at) VALUES (?,?,?,?,?,?,?)',
        'u1', 'user.update', 'user', 'u2', JSON.stringify({ role: 'a' }), JSON.stringify({ role: 'b' }), NOW,
      );

    it('accepts inserts and stores JSON text', () => {
      add();
      const row = db.get<{ before: string; after: string }>('SELECT before, after FROM audit_log');
      expect(JSON.parse(row!.before)).toEqual({ role: 'a' });
      expect(() => db.run("INSERT INTO audit_log (action, entity_type, entity_id, before, at) VALUES ('a','b','c','not json', 1)")).toThrow(/CHECK/);
    });

    it('is append-only: UPDATE aborts', () => {
      add();
      expect(() => db.run("UPDATE audit_log SET action = 'x'")).toThrow(/audit_log is append-only/);
    });

    it('is append-only: DELETE aborts', () => {
      add();
      expect(() => db.run('DELETE FROM audit_log')).toThrow(/audit_log is append-only/);
      expect(db.get<{ c: number }>('SELECT count(*) AS c FROM audit_log')?.c).toBe(1);
    });

    it('does not reference users with a foreign key (rows outlive users)', () => {
      expect(() => add()).not.toThrow();
    });
  });

  describe('settings', () => {
    it('stores JSON text with who/when', () => {
      db.run('INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)', 'commission.affiliate_da', JSON.stringify(300), null, NOW);
      expect(db.get<{ value: string }>('SELECT value FROM settings')?.value).toBe('300');
      expect(() => db.run("INSERT INTO settings (key, value, updated_at) VALUES ('k', '{bad', 1)")).toThrow(/CHECK/);
      expect(() => db.run("INSERT INTO settings (key, value, updated_at) VALUES ('commission.affiliate_da', '1', 1)")).toThrow(/UNIQUE|PRIMARY/);
    });
  });

  it('keeps the CHECK lists in the SQL identical to the shared lists (no drift)', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'migrations', '0001_identity.sql'), 'utf8');
    const list = (re: RegExp) => [...(re.exec(sql)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(list(/role\s+IN\s*\(([^)]*)\)/i)).toEqual([...ROLES]);
    expect(list(/status\s+IN\s*\(([^)]*)\)/i)).toEqual([...USER_STATUSES]);
    expect(list(/permission\s+IN\s*\(([^)]*)\)/i)).toEqual([...PERMISSIONS]);
  });
});
