import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@/shared';
import { createTestApp, login, seedUser, type TestApp } from '../test/app';
import { commissionsOf, insertClick, makeOrder, moveTo, seedAffiliate, seedManager } from '../test/affiliation';
import { seedStaff } from '../test/orders';
import { algiersDateString } from '../util/algiers';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
  app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
});
afterEach(() => app.close());

async function who(permissions: Permission[], owner = false) {
  const u = await seedUser(app, { role: 'super_manager', permissions, isOwner: owner });
  return { id: u.id, cookie: await login(app, u.email, u.password) };
}
const today = () => algiersDateString(app.clock.now());
const post = (cookie: string | undefined, url: string, body?: unknown) => app.call(url, { method: 'POST', cookie, ...(body === undefined ? {} : { body }) });
const state = (id: string) => app.db.get<{ status: string; on_hold: number; cancel_reason: string | null; validated_at: number | null }>('SELECT status, on_hold, cancel_reason, validated_at FROM commissions WHERE id = ?', id)!;
const audits = (action: string) => app.db.all<{ actor_user_id: string; entity_id: string; before: string | null; after: string | null; reason: string | null }>('SELECT * FROM audit_log WHERE action = ? ORDER BY id', action);

async function heldOrder() {
  const aya = await seedAffiliate(app, { phone: '0550123456' });
  const order = makeOrder(app, { clickId: insertClick(app, aya.id), phone: '0550123456' });
  return { aya, order, commission: commissionsOf(app, order.id)[0]! };
}

describe('POST /api/commissions/:id/release-hold', () => {
  it('releases a held commission of an order that is not delivered yet: stays pending, validates on delivery', async () => {
    const me = await who(['commissions.manage']);
    const { order, commission } = await heldOrder();
    const res = await post(me.cookie, `/api/commissions/${commission.id}/release-hold`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending' });
    expect(state(commission.id)).toMatchObject({ status: 'pending', on_hold: 0 });
    const staff = await seedStaff(app);
    moveTo(app, staff, order.id, 'confirmed', 'shipped', 'delivered');
    expect(state(commission.id).status).toBe('validated');
  });

  it('validates at once when the order is already delivered', async () => {
    const me = await who(['commissions.manage']);
    const { order, commission } = await heldOrder();
    const staff = await seedStaff(app);
    moveTo(app, staff, order.id, 'confirmed', 'shipped', 'delivered');
    expect(state(commission.id)).toMatchObject({ status: 'pending', on_hold: 1 });
    app.clock.advance(5000);
    const res = await post(me.cookie, `/api/commissions/${commission.id}/release-hold`);
    expect(await res.json()).toEqual({ status: 'validated' });
    expect(state(commission.id)).toMatchObject({ status: 'validated', on_hold: 0, validated_at: app.clock.now() });
  });

  it('is audited with the actor, the before and the after', async () => {
    const me = await who(['commissions.manage']);
    const { commission } = await heldOrder();
    await post(me.cookie, `/api/commissions/${commission.id}/release-hold`);
    const [row] = audits('commission.hold_released');
    expect(row).toMatchObject({ actor_user_id: me.id, entity_id: commission.id });
    expect(JSON.parse(row!.before!)).toMatchObject({ onHold: true, holdReason: 'auto-référence' });
    expect(JSON.parse(row!.after!)).toEqual({ status: 'pending', onHold: false });
  });

  it('answers 409 for a commission that is not held, cancelled or paid, and 404 for unknown or malformed ids', async () => {
    const me = await who(['commissions.manage']);
    const aya = await seedAffiliate(app);
    const order = makeOrder(app, { clickId: insertClick(app, aya.id) });
    const c = commissionsOf(app, order.id)[0]!;
    expect(await (await post(me.cookie, `/api/commissions/${c.id}/release-hold`)).json()).toEqual({ code: 'not_on_hold' });
    app.db.run("UPDATE commissions SET on_hold = 1, status = 'cancelled', cancelled_at = 1 WHERE id = ?", c.id);
    const res = await post(me.cookie, `/api/commissions/${c.id}/release-hold`);
    expect([res.status, (await res.json()).code]).toEqual([409, 'commission_closed']);
    expect(state(c.id)).toMatchObject({ status: 'cancelled', on_hold: 1 });
    for (const id of ['018f0000-0000-7000-8000-000000000000', 'nope', "1'; DROP TABLE commissions;--"]) {
      expect((await post(me.cookie, `/api/commissions/${encodeURIComponent(id)}/release-hold`)).status, id).toBe(404);
    }
  });

  it('needs commissions.manage, checked again inside the transaction', async () => {
    const { commission } = await heldOrder();
    const nobody = await who(['orders.read', 'payouts.manage']);
    expect((await post(nobody.cookie, `/api/commissions/${commission.id}/release-hold`)).status).toBe(403);
    expect(state(commission.id).on_hold).toBe(1);
    const me = await who(['commissions.manage']);
    app.db.run('DELETE FROM user_permissions WHERE user_id = ?', me.id); // revoked after authentication would be the stale case
    expect((await post(me.cookie, `/api/commissions/${commission.id}/release-hold`)).status).toBe(403);
    expect(state(commission.id).on_hold).toBe(1);
    expect(audits('commission.hold_released')).toEqual([]);
  });
});

describe('POST /api/commissions/:id/cancel', () => {
  it.each([['pending'], ['validated']])('cancels a %s commission with the reason, audited', async (from) => {
    const me = await who(['commissions.manage']);
    const aya = await seedAffiliate(app);
    const order = makeOrder(app, { clickId: insertClick(app, aya.id) });
    const c = commissionsOf(app, order.id)[0]!;
    if (from === 'validated') app.db.run("UPDATE commissions SET status = 'validated', validated_at = 1 WHERE id = ?", c.id);
    const res = await post(me.cookie, `/api/commissions/${c.id}/cancel`, { reason: '  Fraude constatée  ' });
    expect(res.status).toBe(200);
    expect(state(c.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'Fraude constatée' });
    const [row] = audits('commission.cancelled');
    expect(row).toMatchObject({ actor_user_id: me.id, reason: 'Fraude constatée' });
    expect(JSON.parse(row!.before!).status).toBe(from);
  });

  it('cancels a held commission too', async () => {
    const me = await who(['commissions.manage']);
    const { commission } = await heldOrder();
    expect((await post(me.cookie, `/api/commissions/${commission.id}/cancel`, { reason: 'x' })).status).toBe(200);
    expect(state(commission.id).status).toBe('cancelled');
  });

  it('refuses a paid commission (409 commission_paid) and an already cancelled one, changing nothing', async () => {
    const me = await who(['commissions.manage']);
    const aya = await seedAffiliate(app);
    const order = makeOrder(app, { clickId: insertClick(app, aya.id) });
    const c = commissionsOf(app, order.id)[0]!;
    app.db.run("INSERT INTO payouts (id, beneficiary_user_id, amount, method, paid_at, created_by, created_at) VALUES ('p1', ?, 300, 'cash', 1, ?, 1)", aya.id, aya.id);
    app.db.run("UPDATE commissions SET status = 'paid', payout_id = 'p1' WHERE id = ?", c.id);
    const paid = await post(me.cookie, `/api/commissions/${c.id}/cancel`, { reason: 'x' });
    expect([paid.status, (await paid.json()).code]).toEqual([409, 'commission_paid']);
    expect(state(c.id).status).toBe('paid');
    app.db.run("UPDATE commissions SET status = 'cancelled', payout_id = NULL, cancelled_at = 1 WHERE id = ?", c.id);
    const again = await post(me.cookie, `/api/commissions/${c.id}/cancel`, { reason: 'x' });
    expect([again.status, (await again.json()).code]).toEqual([409, 'commission_cancelled']);
    expect(audits('commission.cancelled')).toEqual([]);
  });

  it('requires a reason (400) of at most 500 characters, and validates before looking the commission up', async () => {
    const me = await who(['commissions.manage']);
    const { commission } = await heldOrder();
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 5 }, { reason: 'x'.repeat(501) }]) {
      const res = await post(me.cookie, `/api/commissions/${commission.id}/cancel`, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(state(commission.id).status).toBe('pending');
    expect((await post(me.cookie, `/api/commissions/${commission.id}/cancel`, { reason: 'x'.repeat(500) })).status).toBe(200);
  });

  it('does not touch the order or the sibling commission', async () => {
    const me = await who(['commissions.manage']);
    const boss = await seedManager(app);
    const aya = await seedAffiliate(app, { managerId: boss.id });
    const order = makeOrder(app, { clickId: insertClick(app, aya.id) });
    const [a, m] = commissionsOf(app, order.id);
    await post(me.cookie, `/api/commissions/${a!.id}/cancel`, { reason: 'x' });
    expect(state(m!.id).status).toBe('pending');
    expect(app.db.get('SELECT status FROM orders WHERE id = ?', order.id)).toEqual({ status: 'new' });
  });
});

describe('payouts', () => {
  const body = (beneficiaryUserId: string, extra: Record<string, unknown> = {}) => ({ beneficiaryUserId, method: 'ccp', reference: 'CCP 12345', paidAt: today(), note: 'ok', ...extra });
  const pay = (cookie: string | undefined, b: unknown) => post(cookie, '/api/payouts', b);

  async function delivered(affiliate: { id: string }, n: number) {
    const staff = await seedStaff(app);
    const orders = [];
    for (let i = 0; i < n; i += 1) {
      const o = makeOrder(app, { clickId: insertClick(app, affiliate.id) });
      moveTo(app, staff, o.id, 'confirmed', 'shipped', 'delivered');
      orders.push(o);
    }
    return orders;
  }

  it('pays the validated commissions of one beneficiary: amount, rows marked paid with the payout, audit', async () => {
    const me = await who(['payouts.manage']);
    const aya = await seedAffiliate(app);
    const [o1, o2] = await delivered(aya, 2);
    const res = await pay(me.cookie, body(aya.id));
    expect(res.status).toBe(201);
    const payout = await res.json();
    expect(payout).toMatchObject({ amount: 600, method: 'ccp', reference: 'CCP 12345', note: 'ok', beneficiary: { userId: aya.id }, commissionCount: 2 });
    expect(new Date(payout.paidAt).getTime()).toBe(Date.parse(`${today()}T00:00:00+01:00`));
    for (const o of [o1!, o2!]) expect(commissionsOf(app, o.id)[0]).toMatchObject({ status: 'paid', payout_id: payout.id });
    const [row] = audits('payout.created');
    expect(row).toMatchObject({ actor_user_id: me.id, entity_id: payout.id });
    expect(JSON.parse(row!.after!)).toMatchObject({ amount: 600, commissions: 2, adjustments: 0 });
  });

  it('only touches THAT beneficiary: another influenceuse and the manager keep their validated commissions', async () => {
    const me = await who(['payouts.manage']);
    const boss = await seedManager(app);
    const aya = await seedAffiliate(app, { managerId: boss.id });
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont' });
    const [o] = await delivered(aya, 1);
    await delivered(bea, 1);
    await pay(me.cookie, body(aya.id));
    expect(commissionsOf(app, o!.id).map((c) => [c.kind, c.status])).toEqual([['affiliate', 'paid'], ['manager', 'validated']]);
    expect(app.db.get("SELECT count(*) AS n FROM commissions WHERE beneficiary_user_id = ? AND status = 'validated'", bea.id)).toEqual({ n: 1 });
    const managerPayout = await (await pay(me.cookie, body(boss.id, { method: 'cash' }))).json();
    expect(managerPayout.amount).toBe(200);
  });

  it('skips held, pending and cancelled commissions', async () => {
    const me = await who(['payouts.manage']);
    const aya = await seedAffiliate(app, { phone: '0550123456' });
    const staff = await seedStaff(app);
    const held = makeOrder(app, { clickId: insertClick(app, aya.id), phone: '0550123456' });
    const pending = makeOrder(app, { clickId: insertClick(app, aya.id) });
    const cancelled = makeOrder(app, { clickId: insertClick(app, aya.id) });
    const ok = makeOrder(app, { clickId: insertClick(app, aya.id) });
    for (const o of [held, cancelled, ok]) moveTo(app, staff, o.id, 'confirmed', 'shipped', 'delivered');
    moveTo(app, staff, pending.id, 'confirmed');
    const c = commissionsOf(app, cancelled.id)[0]!;
    app.db.run("UPDATE commissions SET status = 'cancelled', cancelled_at = 1 WHERE id = ?", c.id);
    const payout = await (await pay(me.cookie, body(aya.id))).json();
    expect(payout.amount).toBe(300);
    expect(commissionsOf(app, held.id)[0]).toMatchObject({ status: 'pending', on_hold: 1, payout_id: null });
    expect(commissionsOf(app, pending.id)[0]).toMatchObject({ status: 'pending' });
    expect(commissionsOf(app, ok.id)[0]).toMatchObject({ status: 'paid' });
  });

  it('answers 409 nothing_to_pay with nothing validated, and for a double click (the second finds nothing)', async () => {
    const me = await who(['payouts.manage']);
    const aya = await seedAffiliate(app);
    const none = await pay(me.cookie, body(aya.id));
    expect([none.status, (await none.json()).code]).toEqual([409, 'nothing_to_pay']);
    await delivered(aya, 1);
    expect((await pay(me.cookie, body(aya.id))).status).toBe(201);
    const again = await pay(me.cookie, body(aya.id));
    expect([again.status, (await again.json()).code]).toEqual([409, 'nothing_to_pay']);
    expect(app.db.get('SELECT count(*) AS n FROM payouts')).toEqual({ n: 1 });
  });

  it('nets unsettled adjustments; a total of zero or less pays nothing and consumes nothing', async () => {
    const me = await who(['payouts.manage']);
    const aya = await seedAffiliate(app);
    await delivered(aya, 1); // 300
    app.db.run("INSERT INTO commission_adjustments (id, beneficiary_user_id, amount, reason, created_at) VALUES ('j1', ?, -300, 'retour', 1), ('j2', ?, -50, 'correction', 2)", aya.id, aya.id);
    const res = await pay(me.cookie, body(aya.id));
    expect([res.status, (await res.json()).code]).toEqual([409, 'nothing_to_pay']); // 300 - 350 < 0
    expect(app.db.get('SELECT count(*) AS n FROM commission_adjustments WHERE payout_id IS NULL')).toEqual({ n: 2 });
    expect(app.db.get("SELECT count(*) AS n FROM commissions WHERE status = 'validated'")).toEqual({ n: 1 });
    await delivered(aya, 1); // 600 - 350 = 250
    const ok = await (await pay(me.cookie, body(aya.id))).json();
    expect(ok.amount).toBe(250);
    expect(app.db.all<{ payout_id: string | null }>('SELECT payout_id FROM commission_adjustments').every((a) => a.payout_id === ok.id)).toBe(true);
  });

  it('exactly zero after netting is also nothing to pay', async () => {
    const me = await who(['payouts.manage']);
    const aya = await seedAffiliate(app);
    await delivered(aya, 1);
    app.db.run("INSERT INTO commission_adjustments (id, beneficiary_user_id, amount, reason, created_at) VALUES ('j1', ?, -300, 'x', 2)", aya.id);
    expect((await pay(me.cookie, body(aya.id))).status).toBe(409);
  });

  it('only counts the beneficiary\'s own adjustments', async () => {
    const me = await who(['payouts.manage']);
    const aya = await seedAffiliate(app);
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont' });
    await delivered(aya, 1);
    app.db.run("INSERT INTO commission_adjustments (id, beneficiary_user_id, amount, reason, created_at) VALUES ('j1', ?, -100, 'x', 2)", bea.id);
    expect((await (await pay(me.cookie, body(aya.id))).json()).amount).toBe(300);
    expect(app.db.get('SELECT payout_id FROM commission_adjustments')).toEqual({ payout_id: null });
  });

  it('validates the input: method, date (real, not in the future), lengths, beneficiary', async () => {
    const me = await who(['payouts.manage']);
    const aya = await seedAffiliate(app);
    await delivered(aya, 1);
    const tomorrow = algiersDateString(app.clock.now() + 86_400_000);
    for (const bad of [
      body(aya.id, { method: 'paypal' }),
      body(aya.id, { method: undefined }),
      body(aya.id, { paidAt: '2026-02-30' }),
      body(aya.id, { paidAt: 'yesterday' }),
      body(aya.id, { paidAt: tomorrow }),
      body(aya.id, { reference: 'x'.repeat(101) }),
      body(aya.id, { note: 'x'.repeat(501) }),
      body('not-an-id'),
      {},
    ]) {
      expect((await pay(me.cookie, bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await pay(me.cookie, body('018f0000-0000-7000-8000-000000000000'))).status).toBe(404);
    expect(app.db.get('SELECT count(*) AS n FROM payouts')).toEqual({ n: 0 });
    expect((await pay(me.cookie, body(aya.id, { reference: '', note: '  ', paidAt: today() }))).status).toBe(201);
    expect(app.db.get('SELECT reference, note FROM payouts')).toEqual({ reference: null, note: null });
  });

  it('needs payouts.manage (commissions.manage alone is not enough), re-checked in the transaction, and mutates nothing when refused', async () => {
    const aya = await seedAffiliate(app);
    await delivered(aya, 1);
    const reader = await who(['commissions.manage', 'orders.read']);
    expect((await pay(reader.cookie, body(aya.id))).status).toBe(403);
    const payer = await who(['payouts.manage']);
    app.db.run('DELETE FROM user_permissions WHERE user_id = ?', payer.id);
    expect((await pay(payer.cookie, body(aya.id))).status).toBe(403);
    expect(app.db.get('SELECT count(*) AS n FROM payouts')).toEqual({ n: 0 });
    expect(app.db.get("SELECT count(*) AS n FROM commissions WHERE status = 'paid'")).toEqual({ n: 0 });
    const owner = await who([], true);
    expect((await pay(owner.cookie, body(aya.id))).status).toBe(201);
  });

  it('nobody pays themselves: 403 forbidden decided inside the transaction, nothing changes (even for an owner)', async () => {
    const owner = await who([], true);
    const aya = await seedAffiliate(app);
    await delivered(aya, 1);
    // give the staffer a validated commission of their own through an order they manage
    const mgr = await seedUser(app, { role: 'super_manager', permissions: ['payouts.manage'] });
    const cookie = await login(app, mgr.email, mgr.password);
    app.db.run("UPDATE commissions SET beneficiary_user_id = ? WHERE beneficiary_user_id = ?", mgr.id, aya.id);
    const self = await pay(cookie, body(mgr.id));
    expect([self.status, await self.json()]).toEqual([403, { code: 'forbidden' }]);
    expect(app.db.get('SELECT count(*) AS n FROM payouts')).toEqual({ n: 0 });
    expect(app.db.get("SELECT count(*) AS n FROM commissions WHERE status = 'paid'")).toEqual({ n: 0 });
    expect(app.db.get("SELECT count(*) AS n FROM audit_log WHERE action = 'payout.created'")).toEqual({ n: 0 });
    // someone else can still pay that person
    expect((await pay(owner.cookie, body(mgr.id))).status).toBe(201);
    expect((await pay(owner.cookie, body(owner.id))).status).toBe(403);
  });

  it('rolls back completely when anything fails halfway (payout row, marks, adjustments)', async () => {
    const me = await who(['payouts.manage']);
    const aya = await seedAffiliate(app);
    await delivered(aya, 2);
    app.db.run("INSERT INTO commission_adjustments (id, beneficiary_user_id, amount, reason, created_at) VALUES ('j1', ?, -10, 'x', 2)", aya.id);
    const quiet = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    app.db.exec("CREATE TRIGGER boom BEFORE INSERT ON audit_log WHEN NEW.action = 'payout.created' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect((await pay(me.cookie, body(aya.id))).status).toBe(500);
    quiet.mockRestore();
    expect(app.db.get('SELECT count(*) AS n FROM payouts')).toEqual({ n: 0 });
    expect(app.db.get("SELECT count(*) AS n FROM commissions WHERE status = 'validated'")).toEqual({ n: 2 });
    expect(app.db.get('SELECT payout_id FROM commission_adjustments')).toEqual({ payout_id: null });
  });

  it('GET /api/payouts lists newest first, filters by beneficiary and by payment day', async () => {
    const me = await who(['payouts.manage']);
    const aya = await seedAffiliate(app);
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont' });
    await delivered(aya, 1);
    await delivered(bea, 1);
    await pay(me.cookie, body(aya.id));
    await pay(me.cookie, body(bea.id, { method: 'cash' }));
    const list = await (await app.call('/api/payouts', { cookie: me.cookie })).json();
    expect(list.total).toBe(2);
    expect(list.items.map((p: { beneficiary: { name: string } }) => p.beneficiary.name)).toHaveLength(2);
    const mine = await (await app.call(`/api/payouts?beneficiary=${aya.id}`, { cookie: me.cookie })).json();
    expect(mine.items.map((p: { beneficiary: { userId: string } }) => p.beneficiary.userId)).toEqual([aya.id]);
    expect((await (await app.call(`/api/payouts?from=${today()}&to=${today()}`, { cookie: me.cookie })).json()).total).toBe(2);
    expect((await (await app.call('/api/payouts?to=2020-01-01', { cookie: me.cookie })).json()).total).toBe(0);
    expect((await app.call('/api/payouts?from=2026-13-01', { cookie: me.cookie })).status).toBe(400);
    expect((await app.call('/api/payouts?beneficiary=x', { cookie: me.cookie })).status).toBe(400);
  });

  it('GET /api/payouts/payable shows who has something to be paid and how much (netted)', async () => {
    const me = await who(['payouts.manage']);
    const boss = await seedManager(app);
    const aya = await seedAffiliate(app, { managerId: boss.id });
    await delivered(aya, 2);
    app.db.run("INSERT INTO commission_adjustments (id, beneficiary_user_id, amount, reason, created_at) VALUES ('j1', ?, -100, 'x', 2)", aya.id);
    const { items } = await (await app.call('/api/payouts/payable', { cookie: me.cookie })).json();
    expect(items.map((i: { userId: string; amount: number; commissions: number; adjustments: number }) => [i.userId, i.commissions, i.adjustments, i.amount]).sort()).toEqual(
      [[aya.id, 600, -100, 500], [boss.id, 400, 0, 400]].sort(),
    );
  });

  it('concurrent payouts for the same person on a file database: exactly one succeeds and nothing is paid twice', async () => {
    const file = createTestApp({ file: true, connections: 3 });
    file.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
    try {
      const payer = await seedUser(file, { role: 'super_manager', permissions: ['payouts.manage'] });
      const cookie = await login(file, payer.email, payer.password);
      const aya = await seedAffiliate(file);
      const staff = await seedStaff(file);
      for (let i = 0; i < 5; i += 1) {
        const o = makeOrder(file, { clickId: insertClick(file, aya.id) });
        moveTo(file, staff, o.id, 'confirmed', 'shipped', 'delivered');
      }
      const results = await Promise.all(Array.from({ length: 6 }, () => file.call('/api/payouts', { cookie, body: body(aya.id) })));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
      expect(file.db.get('SELECT count(*) AS n, sum(amount) AS s FROM payouts')).toEqual({ n: 1, s: 1500 });
      expect(file.db.get("SELECT count(*) AS n FROM commissions WHERE status = 'paid'")).toEqual({ n: 5 });
      expect(file.db.get("SELECT count(DISTINCT payout_id) AS n FROM commissions WHERE status = 'paid'")).toEqual({ n: 1 });
    } finally {
      file.close();
    }
  });

  it('two payouts for different people in parallel both succeed, each with its own rows', async () => {
    const file = createTestApp({ file: true, connections: 3 });
    file.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
    try {
      const payer = await seedUser(file, { role: 'super_manager', permissions: ['payouts.manage'] });
      const cookie = await login(file, payer.email, payer.password);
      const staff = await seedStaff(file);
      const people = [await seedAffiliate(file), await seedAffiliate(file, { fullName: 'Bea Dupont' })];
      for (const p of people) {
        const o = makeOrder(file, { clickId: insertClick(file, p.id) });
        moveTo(file, staff, o.id, 'confirmed', 'shipped', 'delivered');
      }
      const res = await Promise.all(people.map((p) => file.call('/api/payouts', { cookie, body: body(p.id) })));
      expect(res.map((r) => r.status)).toEqual([201, 201]);
      expect(file.db.get('SELECT count(*) AS n FROM payouts')).toEqual({ n: 2 });
    } finally {
      file.close();
    }
  });
});
