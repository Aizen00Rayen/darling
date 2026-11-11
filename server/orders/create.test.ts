import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORDER_NUMBER_PATTERN } from '@/shared';
import { HttpFailure } from '../admin/errors';
import { createTestApp, seedUser, type TestApp } from '../test/app';
import { orderInput, seedStaff } from '../test/orders';
import { createOrder, findByIdempotencyKey } from './create';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => app.close());

const algiers = (iso: string) => Date.parse(iso); // helper for readability

describe('createOrder (storefront)', () => {
  it('stores the order with a server-computed snapshot and returns it', () => {
    const { order, created } = createOrder(app, orderInput(), { source: 'website' });
    expect(created).toBe(true);
    expect(order).toMatchObject({
      status: 'new',
      source: 'website',
      customerName: 'Amel B',
      phone: '0612345678',
      wilayaCode: 16,
      wilayaName: 'Alger',
      commune: 'Hydra',
      address: null,
      deliveryMode: 'desk',
      productSlug: 'wet-kiss',
      productName: 'Wet Kiss',
      shadeCode: '*02',
      quantity: 2,
      unitPrice: 3300,
      deliveryFee: 300,
      total: 6900,
      internalNotes: null,
      createdBy: null,
      confirmedAt: null,
      shippedAt: null,
      deliveredAt: null,
      closedAt: null,
    });
    expect(order.createdAt).toBe(new Date(app.clock.now()).toISOString());
    const row = app.db.get<Record<string, unknown>>('SELECT * FROM orders WHERE id = ?', order.id);
    expect(row).toMatchObject({ unit_price: 3300, delivery_fee: 300, total: 6900, created_at: app.clock.now(), updated_at: app.clock.now() });
  });

  it('charges home delivery and keeps the address', () => {
    const { order } = createOrder(app, orderInput({ quantity: 1, wilayaCode: 37, mode: 'home', address: 'Cité 5 juillet' }), { source: 'website' });
    expect(order).toMatchObject({ deliveryMode: 'home', address: 'Cité 5 juillet', deliveryFee: 1650, total: 4950, wilayaName: 'Tindouf' });
  });

  it('writes the first history row ("new", no previous status, no actor) in the same transaction', () => {
    const { order } = createOrder(app, orderInput(), { source: 'website' });
    expect(app.db.all('SELECT order_id, from_status, to_status, actor_user_id, note, at FROM order_status_history')).toEqual([
      { order_id: order.id, from_status: null, to_status: 'new', actor_user_id: null, note: null, at: app.clock.now() },
    ]);
  });

  it('does not write an audit row for a storefront order (no staff actor)', () => {
    createOrder(app, orderInput(), { source: 'website' });
    expect(app.db.get('SELECT count(*) AS n FROM audit_log')).toEqual({ n: 0 });
  });

  it('refuses a desk order to a wilaya without desk service and stores nothing', () => {
    let err: unknown;
    try {
      createOrder(app, orderInput({ wilayaCode: 37, mode: 'desk' }), { source: 'website' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpFailure);
    expect(err).toMatchObject({ status: 400, code: 'validation', errors: { mode: expect.any(String) } });
    expect(app.db.get('SELECT count(*) AS n FROM orders')).toEqual({ n: 0 });
  });

  it('refuses an unknown product, shade or wilaya (defence in depth behind parseOrder)', () => {
    for (const bad of [{ productSlug: 'nope' }, { shadeCode: 'zz' }, { wilayaCode: 99 }]) {
      expect(() => createOrder(app, orderInput(bad), { source: 'website' })).toThrow(HttpFailure);
    }
    expect(app.db.get('SELECT count(*) AS n FROM orders')).toEqual({ n: 0 });
  });

  it('ignores any price carried by the input (prices come from data/ only)', () => {
    const tampered = { ...orderInput(), unitPrice: 1, deliveryFee: 0, total: 1 } as unknown as ReturnType<typeof orderInput>;
    expect(createOrder(app, tampered, { source: 'website' }).order).toMatchObject({ unitPrice: 3300, deliveryFee: 300, total: 6900 });
  });
});

describe('order numbers', () => {
  it('is DL-<YY Algiers>-<sequence padded to 6>', () => {
    const a = createOrder(app, orderInput(), { source: 'website' }).order;
    const b = createOrder(app, orderInput(), { source: 'website' }).order;
    expect(a.number).toBe('DL-23-000001');
    expect(b.number).toBe('DL-23-000002');
    expect(a.number).toMatch(ORDER_NUMBER_PATTERN);
  });

  it('changes the year at Algiers midnight, not at UTC midnight, and keeps counting', () => {
    // 2026-12-31 22:59:59.999 UTC = 23:59:59.999 in Algiers; one millisecond later it is 2027-01-01 there.
    app.clock.set(algiers('2026-12-31T22:59:59.999Z'));
    expect(createOrder(app, orderInput(), { source: 'website' }).order.number).toBe('DL-26-000001');
    app.clock.set(algiers('2026-12-31T23:00:00.000Z'));
    expect(createOrder(app, orderInput(), { source: 'website' }).order.number).toBe('DL-27-000002');
  });

  it('never reuses a number, even when the latest order is gone', () => {
    const a = createOrder(app, orderInput(), { source: 'website' }).order;
    app.db.exec('PRAGMA foreign_keys = OFF');
    app.db.run('DELETE FROM orders WHERE id = ?', a.id);
    app.db.exec('PRAGMA foreign_keys = ON');
    expect(createOrder(app, orderInput(), { source: 'website' }).order.number).toBe('DL-23-000002');
  });

  it('stays unique and gapless under a burst of creates on a file database with several connections', async () => {
    const file = createTestApp({ file: true, connections: 3 });
    try {
      const results = await Promise.all(
        Array.from({ length: 150 }, async (_, i) => {
          await Promise.resolve();
          return createOrder(file, orderInput({ fullName: `Client ${i}` }), { source: 'website' }).order.number;
        }),
      );
      expect(new Set(results).size).toBe(150);
      expect([...results].sort()).toEqual(Array.from({ length: 150 }, (_, i) => `DL-23-${String(i + 1).padStart(6, '0')}`));
      expect(file.db.get('SELECT count(*) AS n FROM order_status_history')).toEqual({ n: 150 });
    } finally {
      file.close();
    }
  });
});

describe('idempotency', () => {
  it('returns the same order for the same key and stores one', () => {
    const first = createOrder(app, orderInput(), { source: 'website', idempotencyKey: 'key-0123456789' });
    app.clock.advance(5000);
    const second = createOrder(app, orderInput(), { source: 'website', idempotencyKey: 'key-0123456789' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.order.id).toBe(first.order.id);
    expect(second.order.number).toBe(first.order.number);
    expect(app.db.get('SELECT count(*) AS n FROM orders')).toEqual({ n: 1 });
    expect(app.db.get('SELECT count(*) AS n FROM order_status_history')).toEqual({ n: 1 });
  });

  it('does not burn an order number on a replay', () => {
    createOrder(app, orderInput(), { source: 'website', idempotencyKey: 'key-0123456789' });
    createOrder(app, orderInput(), { source: 'website', idempotencyKey: 'key-0123456789' });
    expect(createOrder(app, orderInput(), { source: 'website', idempotencyKey: 'other-key-1234' }).order.number).toBe('DL-23-000002');
  });

  it('treats a reused key with a different phone as a conflict (409), never returning the other order', () => {
    createOrder(app, orderInput(), { source: 'website', idempotencyKey: 'key-0123456789' });
    expect(() => createOrder(app, orderInput({ phone: '0712345678' }), { source: 'website', idempotencyKey: 'key-0123456789' })).toThrow(
      expect.objectContaining({ status: 409, code: 'idempotency_conflict' }),
    );
    expect(app.db.get('SELECT count(*) AS n FROM orders')).toEqual({ n: 1 });
  });

  it('orders without a key are all distinct', () => {
    createOrder(app, orderInput(), { source: 'website' });
    createOrder(app, orderInput(), { source: 'website' });
    expect(app.db.get('SELECT count(*) AS n FROM orders')).toEqual({ n: 2 });
  });

  it('finds an order by its key', () => {
    expect(findByIdempotencyKey(app.db, 'key-0123456789')).toBeNull();
    const { order } = createOrder(app, orderInput(), { source: 'website', idempotencyKey: 'key-0123456789' });
    expect(findByIdempotencyKey(app.db, 'key-0123456789')?.id).toBe(order.id);
  });

  it('a burst of identical submissions creates exactly one order', async () => {
    const file = createTestApp({ file: true, connections: 3 });
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, async () => {
          await Promise.resolve();
          return createOrder(file, orderInput(), { source: 'website', idempotencyKey: 'burst-key-000001' });
        }),
      );
      expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(file.db.get('SELECT count(*) AS n FROM orders')).toEqual({ n: 1 });
    } finally {
      file.close();
    }
  });
});

describe('createOrder (manual entry by staff)', () => {
  it('records the staff member, the source and an audit row, and re-authorises the actor in the transaction', async () => {
    const staff = await seedStaff(app, ['orders.write']);
    const { order } = createOrder(app, orderInput(), { source: 'whatsapp', createdBy: staff.userId, ip: staff.ip, requestId: staff.requestId });
    expect(order).toMatchObject({ source: 'whatsapp', createdBy: { id: staff.userId, fullName: 'Test User' } });
    expect(app.db.all('SELECT actor_user_id, to_status FROM order_status_history')).toEqual([{ actor_user_id: staff.userId, to_status: 'new' }]);
    const audit = app.db.get<{ actor_user_id: string; action: string; entity_type: string; entity_id: string; after: string; ip: string; request_id: string }>(
      'SELECT * FROM audit_log',
    );
    expect(audit).toMatchObject({ actor_user_id: staff.userId, action: 'order.created_manual', entity_type: 'order', entity_id: order.id, ip: '10.9.9.9', request_id: 'req-test' });
    expect(JSON.parse(audit!.after)).toEqual({ number: order.number, source: 'whatsapp', total: 6900 });
    expect(audit!.after).not.toContain('0612345678'); // no customer data in the audit log
    expect(audit!.after).not.toContain('Amel');
  });

  it.each([
    ['holds only orders.read', ['orders.read'] as const],
    ['holds no order permission', [] as const],
  ])('refuses (403) a staff member who %s and stores nothing', async (_name, permissions) => {
    const u = await seedUser(app, { role: 'super_manager', permissions: [...permissions] });
    expect(() => createOrder(app, orderInput(), { source: 'whatsapp', createdBy: u.id })).toThrow(expect.objectContaining({ status: 403 }));
    expect(app.db.get('SELECT count(*) AS n FROM orders')).toEqual({ n: 0 });
    expect(app.db.get('SELECT count(*) AS n FROM audit_log')).toEqual({ n: 0 });
  });

  it('refuses a suspended staff member, an affiliate and an unknown actor', async () => {
    const suspended = await seedUser(app, { role: 'super_manager', permissions: ['orders.write'], status: 'suspended' });
    const affiliate = await seedUser(app, { role: 'affiliate' });
    for (const id of [suspended.id, affiliate.id, '018f0000-0000-7000-8000-000000000000']) {
      expect(() => createOrder(app, orderInput(), { source: 'instagram', createdBy: id })).toThrow(expect.objectContaining({ status: 403 }));
    }
  });

  it('lets an owner create without explicit grants', async () => {
    const owner = await seedUser(app, { role: 'super_manager', isOwner: true });
    expect(createOrder(app, orderInput(), { source: 'direct', createdBy: owner.id }).order.createdBy?.id).toBe(owner.id);
  });

  it('rolls everything back when the audit write fails', async () => {
    const staff = await seedStaff(app, ['orders.write']);
    app.db.exec("CREATE TRIGGER boom BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => createOrder(app, orderInput(), { source: 'whatsapp', createdBy: staff.userId })).toThrow(/boom/);
    expect(app.db.get('SELECT count(*) AS n FROM orders')).toEqual({ n: 0 });
    expect(app.db.get('SELECT count(*) AS n FROM order_status_history')).toEqual({ n: 0 });
  });
});
