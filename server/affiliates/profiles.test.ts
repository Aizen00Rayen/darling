import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AFFILIATE_CODE_PATTERN } from '@/shared';
import { settleBackgroundWork } from '../mail/outbox';
import { createTestApp, login, seedUser, type TestApp } from '../test/app';
import { createUser, updateUser } from '../admin/users';
import { nextAffiliateCode } from './profiles';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
  app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
});
afterEach(async () => {
  await settleBackgroundWork();
  app.close();
});

async function owner() {
  const u = await seedUser(app, { role: 'super_manager', isOwner: true });
  return { ...u, cookie: await login(app, u.email, u.password) };
}
const post = (cookie: string, body: Record<string, unknown>) => app.call('/api/users', { cookie, body });
const patch = (cookie: string, id: string, body: Record<string, unknown>) => app.call(`/api/users/${id}`, { method: 'PATCH', cookie, body });
const profileOf = (userId: string) => app.db.get<{ code: string; manager_user_id: string | null }>('SELECT code, manager_user_id FROM affiliate_profiles WHERE user_id = ?', userId);
let seq = 0;
const email = () => `p${(seq += 1)}@example.test`;
const actorOf = (id: string) => ({ userId: id, ip: '10.0.0.1', requestId: 'r' });

describe('affiliate codes', () => {
  it('creates the profile with the invitation: first three letters + a three-digit sequence per prefix', async () => {
    const me = await owner();
    const a = await (await post(me.cookie, { email: email(), fullName: 'Aya Benali', role: 'affiliate' })).json();
    const b = await (await post(me.cookie, { email: email(), fullName: 'Ayano Kato', role: 'affiliate' })).json();
    const c = await (await post(me.cookie, { email: email(), fullName: 'Élodie Martin', role: 'affiliate' })).json();
    const d = await (await post(me.cookie, { email: email(), fullName: 'Li', role: 'affiliate' })).json();
    expect(a.affiliate).toEqual({ code: 'AYA001', managerUserId: null, managerName: null });
    expect(b.affiliate.code).toBe('AYA002');
    expect(c.affiliate.code).toBe('ELO001');
    expect(d.affiliate.code).toBe('LIX001');
    for (const u of [a, b, c, d]) expect(u.affiliate.code).toMatch(AFFILIATE_CODE_PATTERN);
  });

  it('gives no profile to other roles, and the user DTO then has no affiliate field', async () => {
    const me = await owner();
    const sm = await (await post(me.cookie, { email: email(), fullName: 'Sam Manager', role: 'sub_manager' })).json();
    expect(sm.affiliate).toBeUndefined();
    expect(app.db.get('SELECT 1 FROM affiliate_profiles WHERE user_id = ?', sm.id)).toBeUndefined();
    const read = await (await app.call(`/api/users/${sm.id}`, { cookie: me.cookie })).json();
    expect(read.affiliate).toBeUndefined();
  });

  it('never reuses a code, even when the holder stops being an influenceuse or is deactivated', async () => {
    const me = await owner();
    const a = await (await post(me.cookie, { email: email(), fullName: 'Aya One', role: 'affiliate' })).json();
    app.db.run("UPDATE users SET status = 'deactivated' WHERE id = ?", a.id);
    const b = await (await post(me.cookie, { email: email(), fullName: 'Aya Two', role: 'affiliate' })).json();
    expect([a.affiliate.code, b.affiliate.code]).toEqual(['AYA001', 'AYA002']);
    // the newest is gone from the user table's point of view only: the sequence keeps growing
    app.db.run("UPDATE users SET role = 'sub_manager' WHERE id = ?", b.id);
    const c = await (await post(me.cookie, { email: email(), fullName: 'Aya Three', role: 'affiliate' })).json();
    expect(c.affiliate.code).toBe('AYA003');
  });

  it('keeps counting past 999 with more digits (and the pattern still matches)', () => {
    const me = 'x';
    void me;
    app.db.run("INSERT INTO users (id, email, full_name, role, status, created_at, updated_at) VALUES ('u999', 'u999@x.test', 'Aya', 'affiliate', 'active', 1, 1)");
    app.db.run("INSERT INTO affiliate_profiles (user_id, code, created_at) VALUES ('u999', 'AYA999', 1)");
    const code = app.db.transaction((tx) => nextAffiliateCode(tx, 'Aya'), 'immediate');
    expect(code).toBe('AYA1000');
    expect(code).toMatch(AFFILIATE_CODE_PATTERN);
  });

  it('is rolled back with the user when the profile cannot be created (no account without a code)', async () => {
    const me = await owner();
    const quiet = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    app.db.run('CREATE TRIGGER boom BEFORE INSERT ON affiliate_profiles BEGIN SELECT RAISE(ABORT, \'profile refused\'); END');
    const res = await post(me.cookie, { email: 'boom@example.test', fullName: 'Aya Boom', role: 'affiliate' });
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(app.db.get("SELECT 1 FROM users WHERE email = 'boom@example.test'")).toBeUndefined();
    expect(app.db.get("SELECT 1 FROM audit_log WHERE action = 'user.created' AND after LIKE '%boom@%'")).toBeUndefined();
  });

  it('writes the profile audit row without any secret', async () => {
    const me = await owner();
    const a = await (await post(me.cookie, { email: email(), fullName: 'Aya Benali', role: 'affiliate' })).json();
    const rows = app.db.all<{ action: string; after: string }>("SELECT action, after FROM audit_log WHERE entity_id = ? ORDER BY id", a.id);
    expect(rows.map((r) => r.action)).toEqual(['affiliate.profile_created', 'user.created']);
    expect(JSON.parse(rows[0]!.after)).toEqual({ code: 'AYA001', managerUserId: null });
  });

  it('stays unique and gapless over many creations spread across several connections to one file database', async () => {
    const file = createTestApp({ file: true, connections: 4 });
    try {
      const boss = await seedUser(file, { role: 'super_manager', isOwner: true });
      const names = ['Aya', 'Ayane', 'Ayla', 'Aya', 'Bella', 'Aya', 'Béa', 'Ayoub', 'Aya', 'Bel'];
      const codes: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        const user = createUser(
          { db: file.db, clock: file.clock, config: file.config, mailer: file.mailer },
          actorOf(boss.id),
          { email: `f${i}@example.test`, fullName: `${names[i % names.length]} N${i}`, role: 'affiliate' },
        );
        codes.push(user.affiliate!.code);
      }
      expect(new Set(codes).size).toBe(60);
      const aya = codes.filter((c) => c.startsWith('AYA')).map((c) => Number(c.slice(3))).sort((a, b) => a - b);
      expect(aya).toEqual(Array.from({ length: aya.length }, (_, i) => i + 1));
      const bel = codes.filter((c) => c.startsWith('BEL')).map((c) => Number(c.slice(3))).sort((a, b) => a - b);
      expect(bel).toEqual(Array.from({ length: bel.length }, (_, i) => i + 1));
    } finally {
      await settleBackgroundWork();
      file.close();
    }
  });

  it('the UNIQUE index is the backstop: a second profile with an existing code is refused by the database', () => {
    app.db.run("INSERT INTO users (id, email, full_name, role, status, created_at, updated_at) VALUES ('u1', 'u1@x.test', 'A', 'affiliate', 'active', 1, 1), ('u2', 'u2@x.test', 'B', 'affiliate', 'active', 1, 1)");
    app.db.run("INSERT INTO affiliate_profiles (user_id, code, created_at) VALUES ('u1', 'AYA001', 1)");
    expect(() => app.db.run("INSERT INTO affiliate_profiles (user_id, code, created_at) VALUES ('u2', 'AYA001', 1)")).toThrow(/UNIQUE/);
  });
});

describe('role changes', () => {
  it('creates the profile when someone becomes an influenceuse, keeps it when they stop, reuses it when they return', async () => {
    const me = await owner();
    const u = await (await post(me.cookie, { email: email(), fullName: 'Nour Ali', role: 'sub_manager' })).json();
    expect(profileOf(u.id)).toBeUndefined();
    const up = await (await patch(me.cookie, u.id, { role: 'affiliate' })).json();
    expect(up.affiliate.code).toBe('NOU001');
    const away = await (await patch(me.cookie, u.id, { role: 'sub_manager' })).json();
    expect(away.affiliate.code).toBe('NOU001');
    const back = await (await patch(me.cookie, u.id, { role: 'affiliate' })).json();
    expect(back.affiliate.code).toBe('NOU001');
    expect(app.db.all('SELECT 1 FROM affiliate_profiles WHERE user_id = ?', u.id)).toHaveLength(1);
  });

  it('repairs a legacy influenceuse without a profile on the next edit', async () => {
    const me = await owner();
    const legacy = await seedUser(app, { role: 'affiliate', fullName: 'Rym Legacy' });
    expect(profileOf(legacy.id)).toBeUndefined();
    const res = await patch(me.cookie, legacy.id, { fullName: 'Rym Legacy' });
    expect(res.status).toBe(200);
    expect((await res.json()).affiliate.code).toBe('RYM001');
  });
});

describe('manager assignment', () => {
  it('accepts an active sous-manager on create and shows his name', async () => {
    const me = await owner();
    const boss = await seedUser(app, { role: 'sub_manager', fullName: 'Karim Chef' });
    const res = await post(me.cookie, { email: email(), fullName: 'Aya Benali', role: 'affiliate', managerUserId: boss.id });
    expect(res.status).toBe(201);
    expect((await res.json()).affiliate).toEqual({ code: 'AYA001', managerUserId: boss.id, managerName: 'Karim Chef' });
  });

  it.each([
    ['an invited sous-manager', { role: 'sub_manager' as const, status: 'invited' as const }],
    ['a suspended sous-manager', { role: 'sub_manager' as const, status: 'suspended' as const }],
    ['a deactivated sous-manager', { role: 'sub_manager' as const, status: 'deactivated' as const }],
    ['an influenceuse', { role: 'affiliate' as const, status: 'active' as const }],
    ['a super manager', { role: 'super_manager' as const, status: 'active' as const }],
  ])('refuses %s as manager, creating nothing', async (_label, spec) => {
    const me = await owner();
    const other = await seedUser(app, spec);
    const res = await post(me.cookie, { email: 'nope@example.test', fullName: 'Aya Benali', role: 'affiliate', managerUserId: other.id });
    expect(res.status).toBe(400);
    expect((await res.json()).errors.managerUserId).toBeTruthy();
    expect(app.db.get("SELECT 1 FROM users WHERE email = 'nope@example.test'")).toBeUndefined();
  });

  it('refuses unknown ids, malformed ids and a manager on a non-influenceuse', async () => {
    const me = await owner();
    const boss = await seedUser(app, { role: 'sub_manager' });
    expect((await post(me.cookie, { email: email(), fullName: 'Aya B', role: 'affiliate', managerUserId: '018f0000-0000-7000-8000-000000000000' })).status).toBe(400);
    expect((await post(me.cookie, { email: email(), fullName: 'Aya B', role: 'affiliate', managerUserId: "x'; DROP TABLE users;--" })).status).toBe(400);
    expect((await post(me.cookie, { email: email(), fullName: 'Aya B', role: 'sub_manager', managerUserId: boss.id })).status).toBe(400);
    expect((await post(me.cookie, { email: email(), fullName: 'Aya B', role: 'sub_manager', managerUserId: null })).status).toBe(201);
  });

  it('changes and clears the manager through PATCH, audited, and the other fields stay untouched', async () => {
    const me = await owner();
    const m1 = await seedUser(app, { role: 'sub_manager', fullName: 'Un' });
    const m2 = await seedUser(app, { role: 'sub_manager', fullName: 'Deux' });
    const a = await (await post(me.cookie, { email: email(), fullName: 'Aya Benali', role: 'affiliate', managerUserId: m1.id })).json();
    const moved = await patch(me.cookie, a.id, { managerUserId: m2.id });
    expect(moved.status).toBe(200);
    expect((await moved.json()).affiliate).toMatchObject({ managerUserId: m2.id, managerName: 'Deux', code: 'AYA001' });
    const same = await patch(me.cookie, a.id, { managerUserId: m2.id });
    expect(same.status).toBe(200);
    const cleared = await patch(me.cookie, a.id, { managerUserId: null });
    expect((await cleared.json()).affiliate.managerUserId).toBeNull();
    const audits = app.db.all<{ before: string; after: string }>("SELECT before, after FROM audit_log WHERE action = 'affiliate.manager_changed' ORDER BY id");
    expect(audits.map((x) => [JSON.parse(x.before).managerUserId, JSON.parse(x.after).managerUserId])).toEqual([
      [m1.id, m2.id],
      [m2.id, null],
    ]);
    expect(profileOf(a.id)?.manager_user_id).toBeNull();
  });

  it('refuses an inactive manager on PATCH and leaves the previous one', async () => {
    const me = await owner();
    const m1 = await seedUser(app, { role: 'sub_manager' });
    const gone = await seedUser(app, { role: 'sub_manager', status: 'suspended' });
    const a = await (await post(me.cookie, { email: email(), fullName: 'Aya Benali', role: 'affiliate', managerUserId: m1.id })).json();
    const res = await patch(me.cookie, a.id, { managerUserId: gone.id });
    expect(res.status).toBe(400);
    expect(profileOf(a.id)?.manager_user_id).toBe(m1.id);
  });

  it('does not touch existing orders when the manager changes (only future orders are affected)', async () => {
    const me = await owner();
    const m1 = await seedUser(app, { role: 'sub_manager' });
    const m2 = await seedUser(app, { role: 'sub_manager' });
    const a = await (await post(me.cookie, { email: email(), fullName: 'Aya Benali', role: 'affiliate', managerUserId: m1.id })).json();
    app.db.run(
      `INSERT INTO orders (id, number, source, customer_name, phone, wilaya_code, wilaya_name, commune, delivery_mode, product_slug, product_name, shade_code, quantity, unit_price, delivery_fee, total, created_at, updated_at, affiliate_user_id, manager_user_id)
       VALUES ('o1', 'DL-26-000001', 'affiliate', 'A', '0612345678', 16, 'Alger', 'H', 'desk', 'p', 'P', '*01', 1, 3000, 300, 3300, 1, 1, ?, ?)`,
      a.id,
      m1.id,
    );
    await patch(me.cookie, a.id, { managerUserId: m2.id });
    expect(app.db.get('SELECT manager_user_id FROM orders WHERE id = ?', 'o1')).toEqual({ manager_user_id: m1.id });
  });

  it('refuses a manager change from someone without users.manage (no profile change)', async () => {
    const m1 = await seedUser(app, { role: 'sub_manager' });
    const a = await seedUser(app, { role: 'affiliate' });
    const plain = await seedUser(app, { role: 'super_manager', permissions: ['orders.read'] });
    const cookie = await login(app, plain.email, plain.password);
    const res = await patch(cookie, a.id, { managerUserId: m1.id });
    expect(res.status).toBe(403);
    expect(profileOf(a.id)).toBeUndefined();
  });

  it('updateUser keeps working for a profile edit by a non-owner users.manage holder', async () => {
    const boss = await seedUser(app, { role: 'super_manager', permissions: ['users.manage'] });
    const a = await seedUser(app, { role: 'affiliate', fullName: 'Aya Test' });
    const user = updateUser(
      { db: app.db, clock: app.clock, config: app.config, mailer: app.mailer },
      actorOf(boss.id),
      a.id,
      { fullName: 'Aya Test 2' },
    );
    expect(user.affiliate?.code).toBe('AYA001');
  });
});
