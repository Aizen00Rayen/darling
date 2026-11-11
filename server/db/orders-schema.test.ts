import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ORDER_SOURCES, ORDER_STATUSES } from '@/shared';
import { createTestDb } from '../test/db';
import type { Db } from './sqlite';

let db: Db;
beforeEach(() => {
  db = createTestDb().db;
});

const NOW = 1_700_000_000_000;

function order(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: 'o1',
    number: 'DL-23-000001',
    source: 'website',
    customer_name: 'Amel B',
    phone: '0612345678',
    wilaya_code: 16,
    wilaya_name: 'Alger',
    commune: 'Hydra',
    address: null,
    delivery_mode: 'desk',
    product_slug: 'wet-kiss',
    product_name: 'Wet Kiss',
    shade_code: '*02',
    quantity: 2,
    unit_price: 3000,
    delivery_fee: 300,
    total: 6300,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  const cols = Object.keys(row);
  db.run(`INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...(row && (Object.values(row) as never[])));
  return row;
}

describe('0002_orders schema', () => {
  it('applies defaults', () => {
    order();
    expect(db.get('SELECT status, idempotency_key, internal_notes, created_by, confirmed_at, shipped_at, delivered_at, closed_at FROM orders')).toEqual({
      status: 'new',
      idempotency_key: null,
      internal_notes: null,
      created_by: null,
      confirmed_at: null,
      shipped_at: null,
      delivered_at: null,
      closed_at: null,
    });
  });

  it('numbers rows with an internal AUTOINCREMENT sequence', () => {
    order();
    order({ id: 'o2', number: 'DL-23-000002' });
    expect(db.all('SELECT seq FROM orders ORDER BY seq')).toEqual([{ seq: 1 }, { seq: 2 }]);
  });

  it('keeps id, number and idempotency key unique (NULL keys never collide)', () => {
    order({ idempotency_key: 'k1' });
    expect(() => order({ id: 'o1', number: 'DL-23-000002' })).toThrow(/UNIQUE/);
    expect(() => order({ id: 'o2', number: 'DL-23-000001' })).toThrow(/UNIQUE/);
    expect(() => order({ id: 'o2', number: 'DL-23-000002', idempotency_key: 'k1' })).toThrow(/UNIQUE/);
    order({ id: 'o3', number: 'DL-23-000003' });
    order({ id: 'o4', number: 'DL-23-000004' });
  });

  it('accepts exactly the shared statuses and sources', () => {
    for (const [i, status] of ORDER_STATUSES.entries()) order({ id: `s${i}`, number: `DL-23-1${i}`, status });
    for (const [i, source] of ORDER_SOURCES.entries()) order({ id: `r${i}`, number: `DL-23-2${i}`, source });
    expect(() => order({ id: 'x', number: 'DL-23-9', status: 'paid' })).toThrow(/CHECK/);
    expect(() => order({ id: 'x', number: 'DL-23-9', source: 'tiktok' })).toThrow(/CHECK/);
  });

  it('keeps the CHECK lists in the SQL identical to the shared lists (no drift)', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'migrations', '0002_orders.sql'), 'utf8');
    const list = (re: RegExp) => [...(re.exec(sql)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(list(/status\s+IN\s*\(([^)]*)\)/i)).toEqual([...ORDER_STATUSES]);
    expect(list(/source\s+IN\s*\(([^)]*)\)/i)).toEqual([...ORDER_SOURCES]);
  });

  it('requires a normalised phone', () => {
    for (const phone of ['612345678', '0412345678', '06123456789', '+213612345678', '06 12 34 56 78', '06123456ab']) {
      expect(() => order({ id: `p${phone}`, number: `n${phone}`, phone }), phone).toThrow(/CHECK/);
    }
  });

  it('keeps money whole, non-negative and consistent', () => {
    expect(() => order({ id: 'a', number: 'a', total: 6301 })).toThrow(/CHECK/);
    expect(() => order({ id: 'b', number: 'b', unit_price: -1, total: -1 - 0 + 300 })).toThrow(/CHECK/);
    expect(() => order({ id: 'c', number: 'c', delivery_fee: -300, unit_price: 3300, quantity: 2, total: 6300 })).toThrow(/CHECK/);
    expect(() => order({ id: 'd', number: 'd', unit_price: 3000.5, total: 6300.99 })).toThrow(/CHECK/);
    expect(() => order({ id: 'e', number: 'e', unit_price: '3000.5', total: 6300 })).toThrow(/CHECK/);
    expect(() => order({ id: 'f', number: 'f', quantity: 0, total: 300 })).toThrow(/CHECK/);
    order({ id: 'g', number: 'g', unit_price: 0, delivery_fee: 0, total: 0 });
  });

  it('requires an address for home delivery and none for Stop Desk', () => {
    expect(() => order({ id: 'h', number: 'h', delivery_mode: 'home', address: null })).toThrow(/CHECK/);
    expect(() => order({ id: 'i', number: 'i', delivery_mode: 'desk', address: 'Rue 1, Alger' })).toThrow(/CHECK/);
    order({ id: 'j', number: 'j', delivery_mode: 'home', address: 'Rue 1, Alger' });
  });

  it('bounds internal notes to 2000 characters', () => {
    order({ internal_notes: 'x'.repeat(2000) });
    expect(() => order({ id: 'k', number: 'k', internal_notes: 'x'.repeat(2001) })).toThrow(/CHECK/);
  });

  it('indexes status, created_at and phone', () => {
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orders'").map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['orders_status_idx', 'orders_created_at_idx', 'orders_phone_idx']));
  });
});

describe('order_status_history', () => {
  it('references an order, validates statuses and is append-only', () => {
    order();
    db.run("INSERT INTO order_status_history (order_id, from_status, to_status, at) VALUES ('o1', NULL, 'new', ?)", NOW);
    expect(() => db.run("INSERT INTO order_status_history (order_id, to_status, at) VALUES ('nope', 'new', ?)", NOW)).toThrow(/FOREIGN/);
    expect(() => db.run("INSERT INTO order_status_history (order_id, to_status, at) VALUES ('o1', 'paid', ?)", NOW)).toThrow(/CHECK/);
    expect(() => db.run("UPDATE order_status_history SET note = 'x'")).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM order_status_history')).toThrow(/append-only/);
  });
});
