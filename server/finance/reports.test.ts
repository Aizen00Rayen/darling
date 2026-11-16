import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, seedUser, type TestApp } from '../test/app';
import { orderInput } from '../test/orders';
import { createOrder } from '../orders/create';
import { deleteOrder, updateOrder } from '../orders/manage';
import { changeStatus } from '../orders/status';
import { ensureDefaultProduct } from '../products/db';
import { readOverview, recordManualMovement, setCostPrice } from '../inventory/stock';
import { algiersDateString } from '../util/algiers';
import { csvCell, monthReport, ordersCsv } from './reports';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
  ensureDefaultProduct(app.db);
});
afterEach(() => app.close());

const month = () => algiersDateString(app.clock.now()).slice(0, 7);
const pid = () => app.db.get<{ id: string }>("SELECT id FROM products WHERE slug = 'wet-kiss'")!.id;
async function actor(perms: ('orders.write' | 'stock.write' | 'finance.read')[]) {
  const u = await seedUser(app, { role: 'super_manager', permissions: perms });
  return { userId: u.id, ip: '10.9.9.9', requestId: 'r' };
}

describe('profit', () => {
  it('snapshots the real cost on the order and reports delivered profit net of commissions', async () => {
    const fin = await actor(['finance.read']);
    setCostPrice(app.db, fin, pid(), 1200, Date.now());
    const o = createOrder(app, orderInput({ quantity: 2 }), { source: 'website' }).order; // 2 x 3300 sale, 2 x 1200 cost
    const staff = await actor(['orders.write']);
    changeStatus(app, staff, o.id, 'confirmed');
    changeStatus(app, staff, o.id, 'shipped');
    let r = monthReport(app.db, month());
    expect(r.pipeline).toMatchObject({ count: 1, sales: 6600, cost: 2400, margin: 4200, profit: 4200 });
    expect(r.realised.count).toBe(0);

    changeStatus(app, staff, o.id, 'delivered');
    setCostPrice(app.db, fin, pid(), 2000, Date.now()); // later cost changes must not rewrite history
    r = monthReport(app.db, month());
    expect(r.realised).toMatchObject({ count: 1, sales: 6600, cost: 2400, margin: 4200 });
    expect(r.deliveryRate).toBe(100);
  });

  it('counts off-site sales at the cost of the day, and not the orders staff entered by hand twice', async () => {
    const fin = await actor(['finance.read', 'stock.write']);
    setCostPrice(app.db, fin, pid(), 1000, Date.now());
    recordManualMovement(app.db, fin, { productId: pid(), shadeCode: '', reason: 'sale_offsite', quantity: 3, channel: 'instagram', unitPrice: 3000 }, app.clock.now());
    const r = monthReport(app.db, month());
    expect(r.offsite).toEqual({ units: 3, sales: 9000, cost: 3000 });
    expect(r.realised.profit).toBe(6000);
    expect(r.bySource[0]?.label).toContain('Hors site');
  });

  it('keeps a weighted average cost when stock is received at a cost', async () => {
    const fin = await actor(['finance.read', 'stock.write']);
    setCostPrice(app.db, fin, pid(), 1000, Date.now()); // 100 units on hand at 1000
    recordManualMovement(app.db, fin, { productId: pid(), shadeCode: '', reason: 'purchase', quantity: 100, unitPrice: 2000 }, Date.now());
    expect(readOverview(app.db, { withCost: true })[0]?.costPrice).toBe(1500);
    expect(readOverview(app.db)[0]?.costPrice).toBeNull(); // never exposed without finance
  });

  it('requires finance.read to set a cost', async () => {
    const stock = await actor(['stock.write']);
    expect(() => setCostPrice(app.db, stock, pid(), 100, Date.now())).toThrow(/forbidden/);
  });
});

describe('order edit and delete', () => {
  it('editing the quantity moves the stock and recomputes the total', async () => {
    const staff = await actor(['orders.write']);
    const o = createOrder(app, orderInput({ quantity: 2 }), { source: 'website' }).order;
    expect(readOverview(app.db)[0]?.total).toBe(98);
    const edited = updateOrder(app, staff, o.id, { customerName: 'Nadia K', phone: '0612345678', wilayaCode: 16, commune: 'Hydra', mode: 'desk', shadeCode: '*02', quantity: 5 });
    expect(edited.quantity).toBe(5);
    expect(edited.total).toBe(5 * 3300 + edited.deliveryFee);
    expect(readOverview(app.db)[0]?.total).toBe(95);
  });

  it('deleting an order hides it, returns its stock and removes it from the report', async () => {
    const staff = await actor(['orders.write']);
    const o = createOrder(app, orderInput({ quantity: 4 }), { source: 'website' }).order;
    deleteOrder(app, staff, o.id, 'doublon');
    expect(readOverview(app.db)[0]?.total).toBe(100);
    expect(monthReport(app.db, month()).orders).toBe(0);
    expect(() => deleteOrder(app, staff, o.id)).toThrow(/not_found/);
  });
});

describe('csv', () => {
  it('neutralises spreadsheet formulas and escapes separators', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell(12)).toBe('12');
  });

  it('exports the month with profit columns and a BOM', async () => {
    createOrder(app, orderInput({ fullName: '=cmd|calc' }), { source: 'website' });
    const csv = ordersCsv(app.db, month());
    expect(csv.startsWith('﻿Numéro;Date;')).toBe(true);
    expect(csv).toContain("'=cmd|calc");
    expect(csv.trim().split('\r\n')).toHaveLength(2);
  });
});
