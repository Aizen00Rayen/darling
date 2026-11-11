import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '@/shared';
import { createTestApp, type TestApp } from '../test/app';
import { forceStatus, orderInput } from '../test/orders';
import { createOrder } from './create';
import { ORDERS_PAGE_SIZE, listOrders, orderStats } from './list';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => app.close());

const make = (over: Parameters<typeof orderInput>[0] = {}, source: 'website' | 'whatsapp' | 'instagram' = 'website') => {
  app.clock.advance(1000);
  return createOrder(app, orderInput(over), { source }).order;
};
const numbers = (r: { items: { number: string }[] }) => r.items.map((i) => i.number);

describe('listOrders', () => {
  it('lists newest first with the columns of the table and a total', () => {
    const a = make({ fullName: 'Amel B' });
    const b = make({ fullName: 'Sara K', wilayaCode: 31 });
    const result = listOrders(app.db, { page: 1 });
    expect(result.total).toBe(2);
    expect(numbers(result)).toEqual([b.number, a.number]);
    expect(result.items[0]).toEqual({
      id: b.id,
      number: b.number,
      status: 'new',
      source: 'website',
      customerName: 'Sara K',
      phone: '0612345678',
      wilayaName: 'Oran',
      total: b.total,
      createdAt: b.createdAt,
    });
  });

  it('is empty, with total 0, when there are no orders', () => {
    expect(listOrders(app.db, { page: 1 })).toEqual({ items: [], total: 0 });
  });

  it('filters by status and by source', () => {
    const a = make();
    const b = make({}, 'whatsapp');
    const c = make({}, 'instagram');
    forceStatus(app, a.id, 'confirmed');
    forceStatus(app, c.id, 'confirmed');
    expect(numbers(listOrders(app.db, { page: 1, status: 'confirmed' }))).toEqual([c.number, a.number]);
    expect(numbers(listOrders(app.db, { page: 1, source: 'whatsapp' }))).toEqual([b.number]);
    expect(numbers(listOrders(app.db, { page: 1, status: 'confirmed', source: 'instagram' }))).toEqual([c.number]);
    expect(listOrders(app.db, { page: 1, status: 'refused' })).toEqual({ items: [], total: 0 });
  });

  describe('Algiers date range', () => {
    it('includes both end days entirely and nothing outside (UTC+1)', () => {
      const at = (iso: string) => {
        app.clock.set(Date.parse(iso));
        return createOrder(app, orderInput(), { source: 'website' }).order.number; // exactly at `iso`
      };
      const before = at('2026-11-09T22:59:59.000Z'); // 09/11 23:59:59 Algiers
      const start = at('2026-11-09T23:00:00.000Z'); // 10/11 00:00:00 Algiers
      const mid = at('2026-11-10T12:00:00.000Z');
      const end = at('2026-11-11T22:59:59.000Z'); // 11/11 23:59:59 Algiers
      const after = at('2026-11-11T23:00:00.000Z'); // 12/11 00:00 Algiers
      expect(numbers(listOrders(app.db, { page: 1, from: '2026-11-10', to: '2026-11-11' }))).toEqual([end, mid, start]);
      expect(numbers(listOrders(app.db, { page: 1, from: '2026-11-10' }))).toEqual([after, end, mid, start]);
      expect(numbers(listOrders(app.db, { page: 1, to: '2026-11-09' }))).toEqual([before]);
      expect(numbers(listOrders(app.db, { page: 1, from: '2026-11-12', to: '2026-11-12' }))).toEqual([after]);
    });
  });

  describe('search (q)', () => {
    it('matches the order number, the customer name and the phone, case-insensitively', () => {
      const a = make({ fullName: 'Amel Benali', phone: '0551234567' });
      const b = make({ fullName: 'Sara Khelifi', phone: '0661234567' });
      expect(numbers(listOrders(app.db, { page: 1, q: 'amel' }))).toEqual([a.number]);
      expect(numbers(listOrders(app.db, { page: 1, q: 'KHELI' }))).toEqual([b.number]);
      expect(numbers(listOrders(app.db, { page: 1, q: '0661234' }))).toEqual([b.number]);
      expect(numbers(listOrders(app.db, { page: 1, q: a.number }))).toEqual([a.number]);
      expect(numbers(listOrders(app.db, { page: 1, q: '000002' }))).toEqual([b.number]);
      expect(numbers(listOrders(app.db, { page: 1, q: '  amel  ' }))).toEqual([a.number]);
    });

    it('finds a phone typed with spaces or +213', () => {
      const a = make({ phone: '0551234567' });
      make({ phone: '0661234567' });
      expect(numbers(listOrders(app.db, { page: 1, q: '055 12 34 567' }))).toEqual([a.number]);
      expect(numbers(listOrders(app.db, { page: 1, q: '+213 551234567' }))).toEqual([a.number]);
    });

    it('treats %, _ and \\ literally', () => {
      const a = make({ fullName: '100% Amel' });
      const b = make({ fullName: 'A_b Sara' });
      const c = make({ fullName: 'Back\\slash' });
      make({ fullName: 'Plain Name' });
      expect(numbers(listOrders(app.db, { page: 1, q: '%' }))).toEqual([a.number]);
      expect(numbers(listOrders(app.db, { page: 1, q: '_' }))).toEqual([b.number]);
      expect(numbers(listOrders(app.db, { page: 1, q: '\\' }))).toEqual([c.number]);
      expect(numbers(listOrders(app.db, { page: 1, q: '100%' }))).toEqual([a.number]);
      expect(listOrders(app.db, { page: 1, q: 'A%b' }).total).toBe(0); // % is not a wildcard
      expect(listOrders(app.db, { page: 1, q: 'P_ain' }).total).toBe(0); // nor is _
    });

    it('is not an injection vector', () => {
      make();
      expect(listOrders(app.db, { page: 1, q: "' OR 1=1 --" }).total).toBe(0);
      expect(listOrders(app.db, { page: 1, q: "'; DROP TABLE orders; --" }).total).toBe(0);
      expect(listOrders(app.db, { page: 1 }).total).toBe(1);
    });

    it('combines with the other filters', () => {
      const a = make({ fullName: 'Amel A' }, 'whatsapp');
      make({ fullName: 'Amel B' }, 'instagram');
      expect(numbers(listOrders(app.db, { page: 1, q: 'amel', source: 'whatsapp' }))).toEqual([a.number]);
    });
  });

  describe('pagination', () => {
    it('pages of 50, newest first, with a stable total', () => {
      expect(ORDERS_PAGE_SIZE).toBe(50);
      const made = Array.from({ length: 120 }, (_, i) => make({ fullName: `Client ${i}` }).number).reverse();
      const p1 = listOrders(app.db, { page: 1 });
      const p2 = listOrders(app.db, { page: 2 });
      const p3 = listOrders(app.db, { page: 3 });
      expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([50, 50, 20]);
      expect([p1.total, p2.total, p3.total]).toEqual([120, 120, 120]);
      expect([...numbers(p1), ...numbers(p2), ...numbers(p3)]).toEqual(made);
      expect(listOrders(app.db, { page: 4 })).toEqual({ items: [], total: 120 });
    });

    it('breaks ties between orders created in the same millisecond by creation order', () => {
      const a = createOrder(app, orderInput(), { source: 'website' }).order;
      const b = createOrder(app, orderInput(), { source: 'website' }).order;
      const c = createOrder(app, orderInput(), { source: 'website' }).order;
      expect(numbers(listOrders(app.db, { page: 1 }))).toEqual([c.number, b.number, a.number]);
    });

    it('treats an out-of-range page as empty', () => {
      make();
      expect(listOrders(app.db, { page: 9999 })).toEqual({ items: [], total: 1 });
    });
  });
});

describe('orderStats', () => {
  it('counts every status (zero included), today in Algiers, and the orders still to process', () => {
    // 2026-11-11 10:00 Algiers; two orders "yesterday" (Algiers), three today.
    const at = (iso: string) => app.clock.set(Date.parse(iso));
    at('2026-11-10T21:00:00Z'); // 22:00 on the 10th
    const y1 = make();
    const y2 = make();
    at('2026-11-10T23:00:00Z'); // 00:00 on the 11th
    const t1 = make();
    const t2 = make();
    at('2026-11-11T09:00:00Z');
    const t3 = make();
    forceStatus(app, y1.id, 'delivered');
    forceStatus(app, y2.id, 'cancelled');
    forceStatus(app, t1.id, 'confirmed');
    void t2;
    void t3;
    const stats = orderStats(app.db, app.clock.now());
    expect(stats.byStatus).toEqual({ new: 2, confirmed: 1, shipped: 0, delivered: 1, cancelled: 1, refused: 0, returned: 0 });
    expect(Object.keys(stats.byStatus)).toEqual([...ORDER_STATUSES]);
    expect(stats).toMatchObject({ total: 5, today: 3, toProcess: 2 });
  });

  it('is all zeros on an empty database', () => {
    expect(orderStats(app.db, app.clock.now())).toEqual({
      byStatus: { new: 0, confirmed: 0, shipped: 0, delivered: 0, cancelled: 0, refused: 0, returned: 0 },
      total: 0,
      today: 0,
      toProcess: 0,
    });
  });

  it('the "today" window ends at Algiers midnight', () => {
    app.clock.set(Date.parse('2026-11-11T22:59:59Z'));
    createOrder(app, orderInput(), { source: 'website' });
    expect(orderStats(app.db, Date.parse('2026-11-11T22:59:59Z')).today).toBe(1);
    expect(orderStats(app.db, Date.parse('2026-11-11T23:00:00Z')).today).toBe(0);
  });
});
