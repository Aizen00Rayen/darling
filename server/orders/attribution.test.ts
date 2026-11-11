import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, seedUser, type TestApp } from '../test/app';
import { clickIdFromRequest } from './attribution';
import { signRef } from '../affiliates/ref';
import { click, commissionsOf, cookieFor, freshPhone, insertClick, makeOrder, placeOrder, refCookieOf, seedAffiliate, seedManager } from '../test/affiliation';
import { seedStaff } from '../test/orders';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => app.close());

const orderRow = (number: string) =>
  app.db.get<{ id: string; source: string; affiliate_user_id: string | null; manager_user_id: string | null; attribution_click_id: string | null; self_referral: number }>(
    'SELECT id, source, affiliate_user_id, manager_user_id, attribution_click_id, self_referral FROM orders WHERE number = ?',
    number,
  )!;
const numberOf = async (res: Response) => (await res.json()).order.number as string;

describe('storefront attribution through the cookie', () => {
  it('attributes the order to the influenceuse and her manager, sets the click order and creates both commissions', async () => {
    const boss = await seedManager(app);
    const aya = await seedAffiliate(app, { managerId: boss.id });
    const cookie = await cookieFor(app, aya.code);
    const res = await placeOrder(app, cookie);
    expect(res.status).toBe(200);
    const row = orderRow(await numberOf(res));
    expect(row).toMatchObject({ source: 'affiliate', affiliate_user_id: aya.id, manager_user_id: boss.id, self_referral: 0 });
    const clickRow = app.db.get<{ id: string; order_id: string | null }>('SELECT id, order_id FROM affiliate_clicks')!;
    expect(row.attribution_click_id).toBe(clickRow.id);
    expect(clickRow.order_id).toBe(row.id);
    expect(commissionsOf(app, row.id).map((c) => [c.kind, c.beneficiary_user_id, c.amount, c.status, c.on_hold])).toEqual([
      ['affiliate', aya.id, 300, 'pending', 0],
      ['manager', boss.id, 200, 'pending', 0],
    ]);
  });

  it('creates only the influenceuse commission when she has no manager', async () => {
    const aya = await seedAffiliate(app);
    const row = orderRow(await numberOf(await placeOrder(app, await cookieFor(app, aya.code))));
    expect(row.manager_user_id).toBeNull();
    expect(commissionsOf(app, row.id).map((c) => c.kind)).toEqual(['affiliate']);
  });

  it('keeps the click linked to the FIRST order only (set when empty), while later orders still attribute', async () => {
    const aya = await seedAffiliate(app);
    const cookie = await cookieFor(app, aya.code);
    const first = orderRow(await numberOf(await placeOrder(app, cookie)));
    const second = orderRow(await numberOf(await placeOrder(app, cookie)));
    expect(second.affiliate_user_id).toBe(aya.id);
    expect(app.db.get('SELECT order_id FROM affiliate_clicks')).toEqual({ order_id: first.id });
  });

  it('ignores a forged, tampered, foreign-secret or garbage cookie: a normal website order, no commission, no error', async () => {
    const aya = await seedAffiliate(app);
    const good = await cookieFor(app, aya.code);
    const value = decodeURIComponent(good.slice(7));
    const clickId = value.split('.')[0]!;
    {
      const forgedWithOtherSecret = `dl_ref=${signRef({ encryptionKey: Buffer.alloc(32, 7) }, clickId)}`;
      for (const cookie of [
        `dl_ref=${clickId}.${'A'.repeat(43)}`,
        `dl_ref=${clickId}`,
        `dl_ref=${value}x`,
        forgedWithOtherSecret,
        'dl_ref=garbage',
        'dl_ref=',
        `dl_ref=${clickId.toUpperCase()}.${value.split('.')[1]}`,
      ]) {
        const res = await placeOrder(app, cookie);
        expect(res.status, cookie).toBe(200);
        const row = orderRow(await numberOf(res));
        expect(row, cookie).toMatchObject({ source: 'website', affiliate_user_id: null, manager_user_id: null, attribution_click_id: null });
      }
    }
    expect(app.db.get('SELECT count(*) AS n FROM commissions')).toEqual({ n: 0 });
    expect(app.db.get('SELECT order_id FROM affiliate_clicks')).toEqual({ order_id: null });
  });

  it('ignores a correctly signed cookie whose click row is gone', async () => {
    const aya = await seedAffiliate(app);
    const cookie = await cookieFor(app, aya.code);
    app.db.run('DELETE FROM affiliate_clicks');
    expect(orderRow(await numberOf(await placeOrder(app, cookie)))).toMatchObject({ source: 'website', affiliate_user_id: null });
  });

  it('ignores a click older than the attribution window (exact edge), honouring a changed setting', async () => {
    const aya = await seedAffiliate(app);
    const cookie = await cookieFor(app, aya.code);
    app.clock.advance(30 * 86_400_000); // exactly 30 days: still inside
    expect(orderRow(await numberOf(await placeOrder(app, cookie)))).toMatchObject({ source: 'affiliate' });
    app.clock.advance(1); // 30 days and 1 ms
    expect(orderRow(await numberOf(await placeOrder(app, cookie)))).toMatchObject({ source: 'website', affiliate_user_id: null });
    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('attribution.window_days', '31', 1)");
    expect(orderRow(await numberOf(await placeOrder(app, cookie)))).toMatchObject({ source: 'affiliate' });
    app.db.run("UPDATE settings SET value = '1' WHERE key = 'attribution.window_days'");
    expect(orderRow(await numberOf(await placeOrder(app, cookie)))).toMatchObject({ source: 'website' });
  });

  it.each([
    ['suspended', 'suspended' as const],
    ['deactivated', 'deactivated' as const],
    ['invited again', 'invited' as const],
  ])('does not attribute when she became %s after the click', async (_l, status) => {
    const aya = await seedAffiliate(app);
    const cookie = await cookieFor(app, aya.code);
    app.db.run('UPDATE users SET status = ? WHERE id = ?', status, aya.id);
    expect(orderRow(await numberOf(await placeOrder(app, cookie)))).toMatchObject({ source: 'website', affiliate_user_id: null });
    app.db.run("UPDATE users SET status = 'active' WHERE id = ?", aya.id);
    expect(orderRow(await numberOf(await placeOrder(app, cookie)))).toMatchObject({ source: 'affiliate' });
  });

  it('does not attribute when her role changed away from affiliate (profile kept for history)', async () => {
    const aya = await seedAffiliate(app);
    const cookie = await cookieFor(app, aya.code);
    app.db.run("UPDATE users SET role = 'sub_manager' WHERE id = ?", aya.id);
    expect(orderRow(await numberOf(await placeOrder(app, cookie)))).toMatchObject({ source: 'website' });
    expect(app.db.get('SELECT count(*) AS n FROM affiliate_profiles')).toEqual({ n: 1 });
  });

  it('snapshots her CURRENT manager at order time; an inactive manager means no manager commission', async () => {
    const m1 = await seedManager(app, 'Un');
    const m2 = await seedManager(app, 'Deux');
    const aya = await seedAffiliate(app, { managerId: m1.id });
    const cookie = await cookieFor(app, aya.code);
    const before = orderRow(await numberOf(await placeOrder(app, cookie)));
    app.db.run('UPDATE affiliate_profiles SET manager_user_id = ? WHERE user_id = ?', m2.id, aya.id);
    const after = orderRow(await numberOf(await placeOrder(app, cookie)));
    expect([before.manager_user_id, after.manager_user_id]).toEqual([m1.id, m2.id]);
    expect(app.db.get('SELECT manager_user_id FROM orders WHERE id = ?', before.id)).toEqual({ manager_user_id: m1.id }); // untouched
    app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", m2.id);
    const third = orderRow(await numberOf(await placeOrder(app, cookie)));
    expect(third.manager_user_id).toBeNull();
    expect(commissionsOf(app, third.id).map((c) => c.kind)).toEqual(['affiliate']);
    app.db.run("UPDATE users SET status = 'active', role = 'affiliate' WHERE id = ?", m2.id); // no longer a sous-manager
    expect(orderRow(await numberOf(await placeOrder(app, cookie))).manager_user_id).toBeNull();
  });

  it('last click wins: the second influenceuse gets the order, the first gets nothing', async () => {
    const aya = await seedAffiliate(app);
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont' });
    await click(app, aya.code, { ip: '203.0.113.7' });
    const cookie = await cookieFor(app, bea.code, '203.0.113.7'); // the browser now holds Bea's cookie
    const row = orderRow(await numberOf(await placeOrder(app, cookie)));
    expect(row.affiliate_user_id).toBe(bea.id);
    expect(app.db.get('SELECT count(*) AS n FROM commissions WHERE beneficiary_user_id = ?', aya.id)).toEqual({ n: 0 });
  });

  it('puts at most ONE influenceuse on an order, whatever else the request carries', async () => {
    const aya = await seedAffiliate(app);
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont' });
    const a = await cookieFor(app, aya.code, '203.0.113.1');
    const b = await cookieFor(app, bea.code, '203.0.113.2');
    const res = await app.call('/api/orders', {
      headers: { Cookie: `${a}; ${b}; dl_ref=bogus` },
      body: { ...{ productSlug: 'wet-kiss', shadeCode: '*02', quantity: 1, fullName: 'Amel B', phone: freshPhone(), wilayaCode: 16, commune: 'Hydra', mode: 'desk' }, affiliateCode: bea.code, affiliate_user_id: bea.id, manager_user_id: bea.id },
    });
    expect(res.status).toBe(200);
    const row = orderRow(await numberOf(res));
    expect(row.affiliate_user_id).toBe(aya.id); // the first dl_ref cookie of the header
    expect(app.db.get('SELECT count(*) AS n FROM commissions WHERE order_id = ?', row.id)).toEqual({ n: 1 });
  });

  it('never trusts attribution fields sent in the body', async () => {
    const aya = await seedAffiliate(app);
    const res = await app.call('/api/orders', {
      body: { productSlug: 'wet-kiss', shadeCode: '*02', quantity: 1, fullName: 'Amel B', phone: freshPhone(), wilayaCode: 16, commune: 'Hydra', mode: 'desk', source: 'affiliate', affiliateCode: aya.code, affiliateUserId: aya.id },
    });
    expect(orderRow(await numberOf(res))).toMatchObject({ source: 'website', affiliate_user_id: null });
  });

  it('a replay of the same Idempotency-Key creates no second order and no second commission', async () => {
    const aya = await seedAffiliate(app);
    const cookie = await cookieFor(app, aya.code);
    const body = { productSlug: 'wet-kiss', shadeCode: '*02', quantity: 1, fullName: 'Amel B', phone: freshPhone(), wilayaCode: 16, commune: 'Hydra', mode: 'desk' };
    const headers = { 'Idempotency-Key': 'key-abcdefgh-1' };
    expect((await app.call('/api/orders', { cookie, body, headers })).status).toBe(200);
    expect((await app.call('/api/orders', { cookie, body, headers })).status).toBe(200);
    expect(app.db.get('SELECT count(*) AS n FROM orders')).toEqual({ n: 1 });
    expect(app.db.get('SELECT count(*) AS n FROM commissions')).toEqual({ n: 1 });
  });
});

describe('self-referral', () => {
  it('holds the commissions when the customer phone is the influenceuse phone', async () => {
    const boss = await seedManager(app);
    const aya = await seedAffiliate(app, { phone: '0550123456', managerId: boss.id });
    const cookie = await cookieFor(app, aya.code);
    const row = orderRow(await numberOf(await placeOrder(app, cookie, { phone: '0550123456' })));
    expect(row.self_referral).toBe(1);
    expect(row.source).toBe('affiliate');
    expect(commissionsOf(app, row.id).map((c) => [c.kind, c.status, c.on_hold, c.hold_reason])).toEqual([
      ['affiliate', 'pending', 1, 'auto-référence'],
      ['manager', 'pending', 1, 'auto-référence'],
    ]);
  });

  it('compares the normalised phone: +213 and spaces on the customer side, the stored form on hers', async () => {
    const aya = await seedAffiliate(app, { phone: '0550123456' });
    const cookie = await cookieFor(app, aya.code);
    expect(orderRow(await numberOf(await placeOrder(app, cookie, { phone: '+213 550 12 34 56' }))).self_referral).toBe(1);
    expect(orderRow(await numberOf(await placeOrder(app, cookie, { phone: '0550123457' }))).self_referral).toBe(0);
  });

  it('also holds when the customer is her manager (he would earn on his own purchase)', async () => {
    const boss = await seedManager(app);
    app.db.run('UPDATE users SET phone = ? WHERE id = ?', '0661000000', boss.id);
    const aya = await seedAffiliate(app, { managerId: boss.id, phone: '0550123456' });
    const row = orderRow(await numberOf(await placeOrder(app, await cookieFor(app, aya.code), { phone: '0661000000' })));
    expect(row.self_referral).toBe(1);
  });

  it('does not flag an influenceuse without a phone', async () => {
    const aya = await seedAffiliate(app, { phone: null });
    expect(orderRow(await numberOf(await placeOrder(app, await cookieFor(app, aya.code)))).self_referral).toBe(0);
  });
});

describe('staff attribution by code (manual orders)', () => {
  async function staffCookie() {
    const staff = await seedUser(app, { role: 'super_manager', permissions: ['orders.write', 'orders.read'] });
    app.db.run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
    const res = await app.call('/api/auth/login', { body: { email: staff.email, password: staff.password } });
    return { id: staff.id, cookie: res.headers.getSetCookie().find((c) => c.startsWith('dl_session='))!.split(';')[0]! };
  }
  const manual = (cookie: string, extra: Record<string, unknown>) =>
    app.call('/api/orders/manual', { cookie, body: { source: 'instagram', productSlug: 'wet-kiss', shadeCode: '*02', quantity: 1, fullName: 'Amel B', phone: freshPhone(), wilayaCode: 16, commune: 'Hydra', mode: 'desk', ...extra } });

  it('attributes without a cookie, keeps the chosen source, creates the commissions and audits the code', async () => {
    const boss = await seedManager(app);
    const aya = await seedAffiliate(app, { managerId: boss.id });
    const staff = await staffCookie();
    const res = await manual(staff.cookie, { affiliateCode: ` ${aya.code.toLowerCase()} ` });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.source).toBe('instagram');
    expect(body.attribution).toMatchObject({ affiliate: { code: aya.code }, selfReferral: false, viaClick: false });
    const row = orderRow(body.number);
    expect(row).toMatchObject({ source: 'instagram', affiliate_user_id: aya.id, manager_user_id: boss.id, attribution_click_id: null });
    expect(commissionsOf(app, row.id)).toHaveLength(2);
    const audit = app.db.get<{ after: string }>("SELECT after FROM audit_log WHERE action = 'order.created_manual'")!;
    expect(JSON.parse(audit.after)).toMatchObject({ affiliateCode: aya.code, source: 'instagram' });
  });

  it('refuses an unknown or inactive code (400, no order) and a malformed one', async () => {
    const aya = await seedAffiliate(app, { status: 'suspended' });
    const staff = await staffCookie();
    for (const code of ['ZZZ999', aya.code, 'nope', "A'B"]) {
      const res = await manual(staff.cookie, { affiliateCode: code });
      expect(res.status, code).toBe(400);
      expect((await res.json()).errors.affiliateCode).toBeTruthy();
    }
    expect(app.db.get('SELECT count(*) AS n FROM orders')).toEqual({ n: 0 });
  });

  it('treats a blank code as none, and applies self-referral to staff-entered orders too', async () => {
    const aya = await seedAffiliate(app, { phone: '0550123456' });
    const staff = await staffCookie();
    expect((await (await manual(staff.cookie, { affiliateCode: '  ' })).json()).attribution).toBeNull();
    const held = await (await manual(staff.cookie, { affiliateCode: aya.code, phone: '0550123456' })).json();
    expect(held.attribution.selfReferral).toBe(true);
    expect(commissionsOf(app, orderRow(held.number).id)[0]).toMatchObject({ on_hold: 1 });
  });

  it('the storefront route does not read `affiliateCode` and the code field needs orders.write (matrix covers the permission)', async () => {
    const actor = await seedStaff(app);
    const aya = await seedAffiliate(app);
    const order = makeOrder(app, { affiliateCode: aya.code, createdBy: actor.userId, source: 'instagram' });
    expect(order.source).toBe('instagram');
    // without createdBy the code is not honoured by the domain either
    const plain = makeOrder(app, { affiliateCode: aya.code });
    expect(app.db.get('SELECT affiliate_user_id FROM orders WHERE id = ?', plain.id)).toEqual({ affiliate_user_id: null });
  });
});

describe('clickIdFromRequest and domain-level click ids', () => {
  it('reads and verifies the cookie', async () => {
    const aya = await seedAffiliate(app);
    const cookie = refCookieOf(await click(app, aya.code))!;
    const id = app.db.get<{ id: string }>('SELECT id FROM affiliate_clicks')!.id;
    expect(clickIdFromRequest(new Request('http://x/', { headers: { cookie: `a=b; ${cookie}` } }), app.config)).toBe(id);
    expect(clickIdFromRequest(new Request('http://x/'), app.config)).toBeNull();
  });

  it('a click timestamp in the future (clock skew beyond a minute) does not attribute', async () => {
    const aya = await seedAffiliate(app);
    const future = insertClick(app, aya.id, { at: app.clock.now() + 3_600_000 });
    expect(makeOrder(app, { clickId: future }).source).toBe('website');
    const slightly = insertClick(app, aya.id, { at: app.clock.now() + 30_000 });
    expect(makeOrder(app, { clickId: slightly }).source).toBe('affiliate');
  });
});
