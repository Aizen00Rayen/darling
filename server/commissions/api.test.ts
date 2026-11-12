import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORDER_STATUSES, type Permission } from '@/shared';
import { createTestApp, login, seedUser, type TestApp } from '../test/app';
import { insertClick, makeOrder, moveTo, seedAffiliate, seedManager, type SeededAffiliate } from '../test/affiliation';
import { seedStaff } from '../test/orders';
import { createPayout } from './payouts';
import { orderInput } from '../test/orders';
import { createOrder } from '../orders/create';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
  app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
});
afterEach(() => app.close());

async function staffCookie(permissions: Permission[], owner = false) {
  const u = await seedUser(app, { role: 'super_manager', permissions, isOwner: owner });
  return login(app, u.email, u.password);
}
const asUser = (u: { email: string; password: string }) => login(app, u.email, u.password);
const get = async (cookie: string | undefined, url: string) => {
  const res = await app.call(url, { cookie });
  return { status: res.status, text: await res.text() };
};
const json = (r: { text: string }) => JSON.parse(r.text);

/** A customer with distinctive private details, ordering through `clickId`. */
function privateOrder(clickId: string, over: { phone?: string; fullName?: string; address?: string; quantity?: number } = {}) {
  const order = createOrder(app, orderInput({ quantity: over.quantity ?? 1, fullName: over.fullName ?? 'Fatima Zohra Belkacemi', phone: over.phone ?? '0771234567', mode: 'home', address: over.address ?? '12 rue des Orangers Secretville', wilayaCode: 31, commune: 'Bir El Djir' }), {
    source: 'website',
    refClickId: clickId,
  }).order;
  app.db.run("UPDATE orders SET internal_notes = 'NOTE-INTERNE-CONFIDENTIELLE' WHERE id = ?", order.id);
  return order;
}

const SECRETS = ['0771234567', '771234567', '077 12 34 56', 'Secretville', 'Orangers', 'NOTE-INTERNE', 'Belkacemi', 'Zohra', 'Bir El Djir', '@'];
function expectNoLeak(text: string, extra: string[] = []) {
  for (const s of [...SECRETS, ...extra]) expect(text, s).not.toContain(s);
  expect(text).not.toMatch(/"phone"|"address"|"internalNotes"|"internal_notes"|"customerName"|"email"/);
}

describe('GET /api/me/affiliate', () => {
  it('shows her code, link, counts, masked orders, commissions, payouts and totals', async () => {
    const boss = await seedManager(app);
    const aya = await seedAffiliate(app, { managerId: boss.id });
    const staff = await seedStaff(app);
    const payer = await seedUser(app, { role: 'super_manager', permissions: ['payouts.manage'] });
    insertClick(app, aya.id);
    insertClick(app, aya.id);
    const o1 = privateOrder(insertClick(app, aya.id));
    const o2 = privateOrder(insertClick(app, aya.id), { fullName: 'Nadia' });
    moveTo(app, staff, o1.id, 'confirmed', 'shipped', 'delivered');
    createPayout(app, { userId: payer.id, ip: 'x', requestId: 'r' }, { beneficiaryUserId: aya.id, method: 'baridimob', reference: 'BM-1', paidAt: new Date(app.clock.now()).toISOString().slice(0, 10) });
    moveTo(app, staff, o2.id, 'confirmed');

    const res = await get(await asUser(aya), '/api/me/affiliate');
    expect(res.status).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({
      code: aya.code,
      link: `http://localhost:3000/?ref=${aya.code}`,
      clicks: 4,
      orderCount: 2,
      deliveredCount: 1,
      totals: { pending: 300, validated: 0, paid: 300, cancelled: 0 },
      unsettledAdjustments: 0,
      paidTotal: 300,
    });
    expect(body.orders.map((o: { customer: string }) => o.customer).sort()).toEqual(['Fatima B.', 'Nadia']);
    expect(body.orders[0]).toEqual({ ref: expect.stringMatching(/^#\d+$/), createdAt: expect.any(String), status: expect.any(String), productName: 'Wet Kiss', quantity: 1, total: expect.any(Number), wilayaName: 'Oran', customer: expect.any(String) });
    expect(body.commissions).toHaveLength(2);
    expect(body.commissions.map((c: { status: string }) => c.status).sort()).toEqual(['paid', 'pending']);
    expect(body.payouts).toEqual([{ id: expect.any(String), amount: 300, method: 'baridimob', reference: 'BM-1', paidAt: expect.any(String) }]);
    expectNoLeak(res.text, [boss.email]);
  });

  it('never exposes hold flags or reasons to her (a held commission just shows as pending)', async () => {
    const aya = await seedAffiliate(app, { phone: '0550123456' });
    const o = createOrder(app, orderInput({ phone: '0550123456' }), { source: 'website', refClickId: insertClick(app, aya.id) }).order;
    void o;
    const res = await get(await asUser(aya), '/api/me/affiliate');
    expect(res.text).not.toMatch(/on_?hold|hold_?reason|auto-référence|selfReferral|self_referral/i);
    expect(json(res).commissions[0].status).toBe('pending');
  });

  it('is the caller\'s own data only: another influenceuse\'s orders, commissions, clicks and payouts never appear', async () => {
    const aya = await seedAffiliate(app);
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont' });
    const staff = await seedStaff(app);
    const payer = await seedUser(app, { role: 'super_manager', permissions: ['payouts.manage'] });
    for (let i = 0; i < 3; i += 1) insertClick(app, bea.id);
    const bo = makeOrder(app, { clickId: insertClick(app, bea.id), phone: '0661112223' });
    moveTo(app, staff, bo.id, 'confirmed', 'shipped', 'delivered');
    createPayout(app, { userId: payer.id, ip: 'x', requestId: 'r' }, { beneficiaryUserId: bea.id, method: 'cash', paidAt: new Date(app.clock.now()).toISOString().slice(0, 10) });
    const own = makeOrder(app, { clickId: insertClick(app, aya.id), phone: '0662223334' });
    const res = await get(await asUser(aya), '/api/me/affiliate');
    const body = json(res);
    expect(body.clicks).toBe(1);
    expect(body.orders.map((o: { ref: string }) => o.ref)).toEqual(['#1']);
    expect(res.text).not.toContain(own.number);
    expect(body.commissions).toHaveLength(1);
    expect(body.payouts).toEqual([]);
    expect(body.totals).toMatchObject({ paid: 0, pending: 300 });
    for (const leak of [bea.code, 'Bea', bo.number, '0661112223']) expect(res.text, leak).not.toContain(leak);
  });

  it('lists returned-after-paid clawbacks and the unsettled total', async () => {
    const aya = await seedAffiliate(app);
    const staff = await seedStaff(app);
    const payer = await seedUser(app, { role: 'super_manager', permissions: ['payouts.manage'] });
    const o = makeOrder(app, { clickId: insertClick(app, aya.id) });
    moveTo(app, staff, o.id, 'confirmed', 'shipped', 'delivered');
    createPayout(app, { userId: payer.id, ip: 'x', requestId: 'r' }, { beneficiaryUserId: aya.id, method: 'cash', paidAt: new Date(app.clock.now()).toISOString().slice(0, 10) });
    moveTo(app, staff, o.id, 'returned');
    const body = json(await get(await asUser(aya), '/api/me/affiliate'));
    expect(body.unsettledAdjustments).toBe(-300);
    expect(body.adjustments).toEqual([{ id: expect.any(String), amount: -300, reason: 'retour', orderRef: '#1', createdAt: expect.any(String), settled: false }]);
    expect(body.totals.paid).toBe(300);
  });

  it('is refused for every other role and anonymous; a user without profile gets 404', async () => {
    expect((await get(undefined, '/api/me/affiliate')).status).toBe(401);
    const manager = await seedManager(app);
    expect((await get(await asUser(manager), '/api/me/affiliate')).status).toBe(403);
    expect((await get(await staffCookie([], true), '/api/me/affiliate')).status).toBe(403);
    const legacy = await seedUser(app, { role: 'affiliate' });
    expect((await get(await asUser(legacy), '/api/me/affiliate')).status).toBe(404);
  });

  it('still shows her data when she was suspended? No: a suspended account cannot sign in at all', async () => {
    const aya = await seedAffiliate(app);
    const cookie = await asUser(aya);
    app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", aya.id);
    expect((await get(cookie, '/api/me/affiliate')).status).toBe(401);
  });
});

describe('GET /api/me/team', () => {
  async function team() {
    const boss = await seedManager(app, 'Karim Chef');
    const rival = await seedManager(app, 'Rachid Rival');
    const aya = await seedAffiliate(app, { managerId: boss.id });
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont', managerId: boss.id });
    const cara = await seedAffiliate(app, { fullName: 'Cara Rivale', managerId: rival.id });
    const staff = await seedStaff(app);
    return { boss, rival, aya, bea, cara, staff };
  }

  it('shows HIS affiliates, the orders of his team (masked) and his own manager commissions', async () => {
    const { boss, aya, bea, staff } = await team();
    const o1 = privateOrder(insertClick(app, aya.id));
    const o2 = privateOrder(insertClick(app, bea.id), { fullName: 'Yasmine Ait' });
    insertClick(app, aya.id);
    moveTo(app, staff, o1.id, 'confirmed', 'shipped', 'delivered');
    const res = await get(await asUser(boss), '/api/me/team');
    expect(res.status).toBe(200);
    const body = json(res);
    expect(body.members.map((m: { code: string }) => m.code).sort()).toEqual([aya.code, bea.code].sort());
    const ayaRow = body.members.find((m: { code: string }) => m.code === aya.code);
    expect(ayaRow).toMatchObject({ name: aya.email ? 'Aya Benali' : '', clicks: 2, orderCount: 1, deliveredCount: 1, totals: { validated: 300, pending: 0 } });
    expect(body.orderCount).toBe(2);
    expect(body.orders.map((o: { customer: string; affiliate: { code: string } }) => [o.customer, o.affiliate.code]).sort()).toEqual([['Fatima B.', aya.code], ['Yasmine A.', bea.code]].sort());
    expect(body.commissions.every((c: { kind: string }) => c.kind === 'manager')).toBe(true);
    expect(body.totals).toMatchObject({ validated: 200, pending: 200 });
    expect(o2.number).toBeTruthy();
    expectNoLeak(res.text);
    expect(res.text).not.toContain('Rachid');
  });

  it('never shows another sous-manager\'s team, orders or commissions', async () => {
    const { boss, cara } = await team();
    const secret = privateOrder(insertClick(app, cara.id));
    const res = await get(await asUser(boss), '/api/me/team');
    const body = json(res);
    expect(body.members.map((m: { code: string }) => m.code)).not.toContain(cara.code);
    expect(body.orders).toEqual([]);
    expect(body.commissions).toEqual([]);
    for (const leak of [cara.code, secret.number, 'Cara', 'Rival']) expect(res.text, leak).not.toContain(leak);
  });

  it('keeps showing the orders created while he was her manager after she moves to another manager (the order snapshot rules)', async () => {
    const { boss, rival, aya, staff } = await team();
    const o = makeOrder(app, { clickId: insertClick(app, aya.id) });
    moveTo(app, staff, o.id, 'confirmed', 'shipped', 'delivered');
    app.db.run('UPDATE affiliate_profiles SET manager_user_id = ? WHERE user_id = ?', rival.id, aya.id);
    const mine = json(await get(await asUser(boss), '/api/me/team'));
    expect(mine.members.map((m: { code: string }) => m.code)).not.toContain(aya.code);
    expect(mine.orders.map((x: { ref: string }) => x.ref)).toEqual(['#1']);
    expect(mine.totals.validated).toBe(200);
    const his = json(await get(await asUser(rival), '/api/me/team'));
    expect(his.members.map((m: { code: string }) => m.code)).toContain(aya.code);
    expect(his.orders).toEqual([]);
    expect(his.members.find((m: { code: string }) => m.code === aya.code)).toMatchObject({ orderCount: 0, totals: { validated: 0, pending: 0 } });
  });

  it('is refused for other roles and anonymous', async () => {
    const { aya } = await team();
    expect((await get(undefined, '/api/me/team')).status).toBe(401);
    expect((await get(await asUser(aya), '/api/me/team')).status).toBe(403);
    expect((await get(await staffCookie([], true), '/api/me/team')).status).toBe(403);
  });
});

describe('the shop\'s order numbers never reach influenceuses or sous-managers', () => {
  it('no number anywhere in /api/me/affiliate and /api/me/team; refs are stable per-person ranks', async () => {
    const boss = await seedManager(app);
    const aya = await seedAffiliate(app, { managerId: boss.id });
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont', managerId: boss.id });
    const staff = await seedStaff(app);
    const payer = await seedUser(app, { role: 'super_manager', permissions: ['payouts.manage'] });
    const orders = [bea, aya, bea, aya].map((p) => privateOrder(insertClick(app, p.id)));
    moveTo(app, staff, orders[1]!.id, 'confirmed', 'shipped', 'delivered');
    createPayout(app, { userId: payer.id, ip: 'x', requestId: 'r' }, { beneficiaryUserId: aya.id, method: 'cash', paidAt: new Date(app.clock.now()).toISOString().slice(0, 10) });
    moveTo(app, staff, orders[1]!.id, 'returned');
    const mine = await get(await asUser(aya), '/api/me/affiliate');
    const team = await get(await asUser(boss), '/api/me/team');
    for (const res of [mine, team]) {
      expect(res.text).not.toMatch(/DL-\d{2}-\d{6}/);
      for (const o of orders) expect(res.text).not.toContain(o.number);
      expect(res.text).not.toMatch(/"number"|"orderNumber"/);
    }
    // Aya's own ranks: her orders are her #1 and #2 whatever the global sequence says (#2 and #4 globally)
    expect(json(mine).orders.map((o: { ref: string }) => o.ref).sort()).toEqual(['#1', '#2']);
    expect(json(mine).commissions.map((c: { orderRef: string }) => c.orderRef).sort()).toEqual(['#1', '#2']);
    expect(json(mine).adjustments[0].orderRef).toBe('#1');
    // the manager ranks the whole team's orders: #1..#4
    expect(json(team).orders.map((o: { ref: string }) => o.ref).sort()).toEqual(['#1', '#2', '#3', '#4']);
    // refs do not change when a newer order arrives
    privateOrder(insertClick(app, aya.id));
    expect(json(await get(await asUser(aya), '/api/me/affiliate')).orders.map((o: { ref: string }) => o.ref).sort()).toEqual(['#1', '#2', '#3']);
  });

  it('staff screens keep the real number', async () => {
    const aya = await seedAffiliate(app);
    const o = privateOrder(insertClick(app, aya.id));
    const me = await staffCookie(['commissions.manage']);
    expect(json(await get(me, `/api/affiliates/${aya.id}`)).orders[0].number).toBe(o.number);
    expect(json(await get(me, '/api/commissions')).items[0].orderNumber).toBe(o.number);
  });
});

describe('staff reads', () => {
  it('GET /api/affiliates: code, manager, status, clicks, orders, delivered and commission totals', async () => {
    const boss = await seedManager(app, 'Karim Chef');
    const aya = await seedAffiliate(app, { managerId: boss.id });
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont', status: 'suspended' });
    const staff = await seedStaff(app);
    insertClick(app, aya.id);
    const o = makeOrder(app, { clickId: insertClick(app, aya.id) });
    makeOrder(app, { clickId: insertClick(app, aya.id) });
    moveTo(app, staff, o.id, 'confirmed', 'shipped', 'delivered');
    const me = await staffCookie(['commissions.manage']);
    const all = json(await get(me, '/api/affiliates'));
    expect(all.total).toBe(2);
    const row = all.items.find((r: { code: string }) => r.code === aya.code);
    expect(row).toMatchObject({ userId: aya.id, name: 'Aya Benali', status: 'active', manager: { userId: boss.id, name: 'Karim Chef' }, clicks: 3, orders: 2, delivered: 1, totals: { pending: 300, validated: 300, paid: 0 }, link: `http://localhost:3000/?ref=${aya.code}` });
    expect(json(await get(me, '/api/affiliates?status=suspended')).items.map((r: { code: string }) => r.code)).toEqual([bea.code]);
    expect(json(await get(me, `/api/affiliates?q=${bea.code.toLowerCase()}`)).items).toHaveLength(1);
    expect(json(await get(me, `/api/affiliates?manager=${boss.id}`)).items.map((r: { code: string }) => r.code)).toEqual([aya.code]);
    expect(json(await get(me, '/api/affiliates?q=%25')).total).toBe(0); // LIKE wildcards are escaped
    expect((await get(me, '/api/affiliates?page=0')).status).toBe(400);
    expect((await get(me, '/api/affiliates?status=weird')).status).toBe(400);
  });

  it('GET /api/affiliates/:id: detail with masked orders, no phone/address, 404 for non-affiliates and malformed ids', async () => {
    const aya = await seedAffiliate(app);
    const boss = await seedManager(app);
    privateOrder(insertClick(app, aya.id));
    const me = await staffCookie(['commissions.manage']);
    const res = await get(me, `/api/affiliates/${aya.id}`);
    expect(res.status).toBe(200);
    const body = json(res);
    expect(body.affiliate.code).toBe(aya.code);
    expect(body.orders[0].customer).toBe('Fatima B.');
    expect(body.clicks).toHaveLength(1);
    expect(body.payable).toEqual({ amount: 0, commissions: 0, commissionCount: 0, adjustments: 0 });
    expectNoLeak(res.text);
    for (const id of [boss.id, '018f0000-0000-7000-8000-000000000000', 'nope', "x' OR 1=1 --"]) expect((await get(me, `/api/affiliates/${encodeURIComponent(id)}`)).status, id).toBe(404);
  });

  it('GET /api/commissions: filters, masked customer, totals per status, paging of 50', async () => {
    const aya = await seedAffiliate(app);
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont' });
    const staff = await seedStaff(app);
    const first = privateOrder(insertClick(app, aya.id));
    for (let i = 0; i < 59; i += 1) {
      app.clock.advance(1000);
      makeOrder(app, { clickId: insertClick(app, i % 2 ? aya.id : bea.id) });
    }
    moveTo(app, staff, first.id, 'confirmed', 'shipped', 'delivered');
    const me = await staffCookie(['commissions.manage']);
    const page1 = await get(me, '/api/commissions');
    const body = json(page1);
    expect(body.total).toBe(60);
    expect(body.items).toHaveLength(50);
    expect(json(await get(me, '/api/commissions?page=2')).items).toHaveLength(10);
    expect(body.totals).toMatchObject({ validated: 300, pending: 59 * 300 });
    expectNoLeak(page1.text);
    expect(json(await get(me, '/api/commissions?status=validated')).items.map((c: { orderNumber: string; customer: string }) => [c.orderNumber, c.customer])).toEqual([[first.number, 'Fatima B.']]);
    expect(json(await get(me, `/api/commissions?order=${first.number.slice(-6)}`)).total).toBe(1);
    expect(json(await get(me, `/api/commissions?beneficiary=${bea.id}`)).total).toBe(30);
    expect(json(await get(me, '/api/commissions?order=%25')).total).toBe(0);
    expect((await get(me, '/api/commissions?status=nope')).status).toBe(400);
    expect((await get(me, '/api/commissions?beneficiary=nope')).status).toBe(400);
  });

  it('is refused without commissions.manage (even with orders.read / payouts.manage) and for non-staff', async () => {
    const aya = await seedAffiliate(app);
    for (const url of ['/api/commissions', '/api/affiliates', `/api/affiliates/${aya.id}`]) {
      expect((await get(undefined, url)).status).toBe(401);
      expect((await get(await asUser(aya), url)).status).toBe(403);
      expect((await get(await staffCookie(['orders.read', 'payouts.manage']), url)).status).toBe(403);
    }
  });

  it('order detail carries the attribution (code, manager, self-referral) for orders.read staff', async () => {
    const boss = await seedManager(app, 'Karim Chef');
    const aya = await seedAffiliate(app, { managerId: boss.id, phone: '0550123456' });
    const o = createOrder(app, orderInput({ phone: '0550123456' }), { source: 'website', refClickId: insertClick(app, aya.id) }).order;
    const plain = makeOrder(app);
    const me = await staffCookie(['orders.read']);
    const detail = json(await get(me, `/api/orders/${o.id}`));
    expect(detail.attribution).toEqual({ affiliate: { userId: aya.id, code: aya.code, name: 'Aya Benali' }, manager: { userId: boss.id, name: 'Karim Chef' }, selfReferral: true, viaClick: true });
    expect(json(await get(me, `/api/orders/${plain.id}`)).attribution).toBeNull();
    expect(ORDER_STATUSES.length).toBe(7);
  });
});

describe('response hygiene', () => {
  it('self-service and staff responses are never cacheable', async () => {
    const aya: SeededAffiliate = await seedAffiliate(app);
    const res = await app.call('/api/me/affiliate', { cookie: await asUser(aya) });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
