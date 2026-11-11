import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Permission, Role } from '@/shared';
import { createTestApp, login, seedUser, type TestApp } from '../test/app';

// The last-owner invariant under concurrency. Every mutation runs in ONE BEGIN IMMEDIATE transaction that re-reads
// the actor, the target and every owner row, so the second of two racing writers always sees the first one's effect.
// The app uses a temp FILE database with several connections; requests are fired together with Promise.all.

let app: TestApp;
beforeEach(() => {
  app = createTestApp({ file: true, connections: 4 });
  app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
});
afterEach(() => app.close());

async function actor(role: Role, extra: { isOwner?: boolean; permissions?: Permission[] } = {}) {
  const user = await seedUser(app, { role, ...extra });
  return { ...user, cookie: await login(app, user.email, user.password) };
}
const owner = () => actor('super_manager', { isOwner: true });
const patch = (cookie: string, id: string, body: object) => app.call(`/api/users/${id}`, { method: 'PATCH', cookie, body });
const suspend = (cookie: string, id: string) => app.call(`/api/users/${id}/suspend`, { method: 'POST', cookie });
const activeOwners = () => app.db.all<{ id: string }>("SELECT id FROM users WHERE is_owner = 1 AND status = 'active'").map((r) => r.id);
const statuses = (rs: Response[]) => rs.map((r) => r.status).sort((a, b) => a - b);

describe('last owner invariant under concurrency', () => {
  it('lets exactly one of two owners remove the other’s flag', async () => {
    for (let i = 0; i < 8; i += 1) {
      app.db.run('UPDATE users SET is_owner = 0');
      const a = await owner();
      const b = await owner();
      const results = await Promise.all([patch(b.cookie, a.id, { isOwner: false }), patch(a.cookie, b.id, { isOwner: false })]);
      const s = statuses(results);
      expect(s[0]).toBe(200); // exactly one succeeded...
      expect([403, 409]).toContain(s[1]); // ...and the loser was refused (409 last_owner, or 403: it was demoted first)
      expect(activeOwners()).toHaveLength(1);
    }
  });

  it('lets exactly one of two owners suspend the other', async () => {
    for (let i = 0; i < 8; i += 1) {
      app.db.run('UPDATE users SET is_owner = 0');
      const a = await owner();
      const b = await owner();
      const results = await Promise.all([suspend(b.cookie, a.id), suspend(a.cookie, b.id)]);
      const s = statuses(results);
      expect(s[0]).toBe(204);
      expect([403, 409]).toContain(s[1]);
      expect(activeOwners()).toHaveLength(1);
    }
  });

  it('never leaves zero owners with three owners demoting each other in a cycle', async () => {
    for (let i = 0; i < 6; i += 1) {
      app.db.run('UPDATE users SET is_owner = 0');
      const a = await owner();
      const b = await owner();
      const c = await owner();
      const results = await Promise.all([patch(a.cookie, b.id, { isOwner: false }), patch(b.cookie, c.id, { isOwner: false }), patch(c.cookie, a.id, { isOwner: false })]);
      const s = statuses(results);
      expect(s.filter((x) => x === 200).length).toBeGreaterThanOrEqual(1);
      expect(s.every((x) => [200, 401, 403, 409].includes(x))).toBe(true);
      expect(activeOwners().length).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps at least one owner when demotions and suspensions race in every direction', async () => {
    for (let i = 0; i < 10; i += 1) {
      app.db.run('UPDATE users SET is_owner = 0');
      const a = await owner();
      const b = await owner();
      const results = await Promise.all([
        patch(b.cookie, a.id, { isOwner: false }),
        patch(a.cookie, b.id, { isOwner: false }),
        suspend(a.cookie, b.id),
        suspend(b.cookie, a.id),
      ]);
      for (const res of results) expect([200, 204, 401, 403, 409]).toContain(res.status);
      expect(activeOwners().length).toBeGreaterThanOrEqual(1);
    }
  });

  it('an owner demoted by a racing request cannot then manage a super manager', async () => {
    const a = await owner();
    const b = await owner();
    const target = await seedUser(app, { role: 'super_manager', permissions: ['audit.read'] });
    const results = await Promise.all([patch(a.cookie, b.id, { isOwner: false }), suspend(b.cookie, target.id)]);
    // Either order is possible; what must hold: if b was demoted first, the suspension is refused.
    const demoted = app.db.get<{ is_owner: number }>('SELECT is_owner FROM users WHERE id = ?', b.id)?.is_owner === 0;
    const targetStatus = app.db.get<{ status: string }>('SELECT status FROM users WHERE id = ?', target.id)?.status;
    expect(results[0]?.status).toBe(200);
    if (results[1]?.status === 204) expect(targetStatus).toBe('suspended');
    else {
      expect([401, 403]).toContain(results[1]?.status);
      expect(targetStatus).toBe('active');
    }
    expect(demoted).toBe(true);
  });
});
