import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, seedUser, type TestApp } from '../test/app';
import { orderInput } from '../test/orders';
import { createOrder } from '../orders/create';
import { changeStatus } from '../orders/status';
import { ensureDefaultProduct } from '../products/db';
import { listMovements, readOverview, recordManualMovement, setStockLevels } from './stock';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
  ensureDefaultProduct(app.db);
});
afterEach(() => app.close());

const productId = () => app.db.get<{ id: string }>("SELECT id FROM products WHERE slug = 'wet-kiss'")!.id;
const level = (shade: string) => readOverview(app.db)[0]!.shades.find((s) => s.shadeCode === shade)!.quantity;
const total = () => readOverview(app.db)[0]!.total;
const ledgerSum = () => app.db.get<{ q: number }>('SELECT SUM(delta) AS q FROM stock_movements WHERE product_id = ?', productId())!.q;
async function stockManager() {
  const u = await seedUser(app, { role: 'super_manager', permissions: ['stock.write'] });
  return { userId: u.id, ip: '10.9.9.9', requestId: 'req-test' };
}

describe('stock ledger', () => {
  it('seeds the default product with an opening balance in the ledger', () => {
    expect(total()).toBe(100);
    expect(ledgerSum()).toBe(100);
    expect(level('')).toBe(100);
  });

  it('a website order removes stock and a cancelled order gives it back exactly once', async () => {
    const created = createOrder(app, orderInput({ quantity: 3 }), { source: 'website' }).order;
    expect(total()).toBe(97);
    expect(listMovements(app.db)[0]).toMatchObject({ reason: 'sale_website', delta: -3 });

    const actor = await seedUser(app, { role: 'super_manager', permissions: ['orders.write'] });
    const a = { userId: actor.id, ip: '10.9.9.9', requestId: 'r' };
    changeStatus(app, a, created.id, 'cancelled');
    expect(total()).toBe(100);
    expect(ledgerSum()).toBe(100);
  });

  it('takes from the shade pool first, then from the unallocated pool', async () => {
    const actor = await stockManager();
    recordManualMovement(app.db, actor, { productId: productId(), shadeCode: '*02', reason: 'purchase', quantity: 2 }, Date.now());
    expect(level('*02')).toBe(2);
    createOrder(app, orderInput({ shadeCode: '*02', quantity: 5 }), { source: 'website' });
    expect(level('*02')).toBe(0);
    expect(level('')).toBe(97);
    expect(total()).toBe(97);
    expect(ledgerSum()).toBe(97);
  });

  it('refuses an order above the available stock and creates nothing', () => {
    app.db.run('UPDATE products SET stock = 2 WHERE id = ?', productId());
    expect(() => createOrder(app, orderInput({ quantity: 3 }), { source: 'website' })).toThrow(/out_of_stock/);
    expect(app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM orders')!.n).toBe(0);
    expect(total()).toBe(2);
  });

  it('records an off-site sale with its channel and refuses to go below zero', async () => {
    const actor = await stockManager();
    const out = recordManualMovement(
      app.db,
      actor,
      { productId: productId(), shadeCode: '', reason: 'sale_offsite', quantity: 4, channel: 'instagram', unitPrice: 3300 },
      Date.now(),
    );
    expect(out.total).toBe(96);
    expect(out.soldOffsite).toBe(4);
    expect(listMovements(app.db)[0]).toMatchObject({ reason: 'sale_offsite', channel: 'instagram', unitPrice: 3300 });
    expect(() =>
      recordManualMovement(app.db, actor, { productId: productId(), shadeCode: '*01', reason: 'damage', quantity: 1, note: 'cassé' }, Date.now()),
    ).toThrow(/validation/);
    expect(ledgerSum()).toBe(total());
  });

  it('requires stock.write', async () => {
    const u = await seedUser(app, { role: 'super_manager', permissions: ['orders.write'] });
    expect(() =>
      recordManualMovement(app.db, { userId: u.id, ip: 'x', requestId: 'r' }, { productId: productId(), shadeCode: '', reason: 'purchase', quantity: 1 }, Date.now()),
    ).toThrow(/forbidden/);
  });

  it('the ledger is append-only', () => {
    expect(() => app.db.run('DELETE FROM stock_movements')).toThrow(/append-only/);
    expect(() => app.db.run('UPDATE stock_movements SET delta = 5')).toThrow(/append-only/);
  });
});

describe('set stock levels', () => {
  it('sets exact quantities per shade, records the differences and can change the alert level', async () => {
    const actor = await stockManager();
    const out = setStockLevels(app.db, actor, { productId: productId(), levels: { '*01': 12, '': 40 }, lowStockThreshold: 5 }, Date.now());
    expect(out.shades.find((s) => s.shadeCode === '*01')?.quantity).toBe(12);
    expect(out.shades.find((s) => s.shadeCode === '')?.quantity).toBe(40);
    expect(out.total).toBe(52);
    expect(out.lowStockThreshold).toBe(5);
    expect(ledgerSum()).toBe(52);
    expect(listMovements(app.db).filter((m) => m.reason === 'adjustment')).toHaveLength(2);
    // Setting the same numbers again changes nothing.
    setStockLevels(app.db, actor, { productId: productId(), levels: { '*01': 12, '': 40 } }, Date.now());
    expect(listMovements(app.db).filter((m) => m.reason === 'adjustment')).toHaveLength(2);
  });

  it('rejects an unknown shade', async () => {
    const actor = await stockManager();
    expect(() => setStockLevels(app.db, actor, { productId: productId(), levels: { '*99': 1 } }, Date.now())).toThrow(/validation/);
  });
});
