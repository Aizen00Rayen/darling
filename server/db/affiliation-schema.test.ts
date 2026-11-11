import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test/db';
import type { Db } from './sqlite';

let db: Db;
beforeEach(() => {
  db = createTestDb().db;
});
const NOW = 1_700_000_000_000;

function user(id: string, role = 'affiliate') {
  db.run(`INSERT INTO users (id, email, full_name, role, status, created_at, updated_at) VALUES (?, ?, 'N', ?, 'active', ?, ?)`, id, `${id}@x.test`, role, NOW, NOW);
}
function order(id: string, extra: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id, number: `DL-23-${id}`, source: 'website', customer_name: 'A', phone: '0612345678', wilaya_code: 16, wilaya_name: 'Alger', commune: 'H',
    delivery_mode: 'desk', product_slug: 'p', product_name: 'P', shade_code: '*01', quantity: 1, unit_price: 3000, delivery_fee: 300, total: 3300,
    created_at: NOW, updated_at: NOW, ...extra,
  };
  const cols = Object.keys(row);
  db.run(`INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...(Object.values(row) as never[]));
}
function profile(userId: string, code: string) {
  db.run('INSERT INTO affiliate_profiles (user_id, code, created_at) VALUES (?, ?, ?)', userId, code, NOW);
}
function commission(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { id: 'c1', order_id: 'o1', beneficiary_user_id: 'a1', kind: 'affiliate', amount: 300, created_at: NOW, ...over };
  const cols = Object.keys(row);
  db.run(`INSERT INTO commissions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...(Object.values(row) as never[]));
}

describe('0003_affiliation', () => {
  it('creates the tables and adds the order columns with safe defaults', () => {
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    for (const t of ['affiliate_profiles', 'affiliate_clicks', 'commissions', 'commission_adjustments', 'payouts']) expect(tables).toContain(t);
    order('o1');
    expect(db.get('SELECT affiliate_user_id, manager_user_id, attribution_click_id, self_referral FROM orders')).toEqual({
      affiliate_user_id: null, manager_user_id: null, attribution_click_id: null, self_referral: 0,
    });
    expect(() => order('o2', { self_referral: 2 })).toThrow();
  });

  it('keeps codes unique and well formed, one profile per user, and needs a real user', () => {
    user('a1');
    user('a2');
    profile('a1', 'AYA001');
    expect(() => profile('a2', 'AYA001')).toThrow(/UNIQUE/);
    expect(() => profile('a1', 'AYA002')).toThrow(/UNIQUE/);
    expect(() => profile('a2', 'aya002')).toThrow(/CHECK/);
    expect(() => profile('a2', 'AY001')).toThrow(/CHECK/);
    expect(() => profile('nobody', 'ZZZ001')).toThrow(/FOREIGN/);
    expect(() => db.run('INSERT INTO affiliate_profiles (user_id, code, manager_user_id, created_at) VALUES (?, ?, ?, ?)', 'a2', 'AYA003', 'ghost', NOW)).toThrow(/FOREIGN/);
  });

  it('stores clicks against an affiliate and refuses unknown ones', () => {
    user('a1');
    db.run("INSERT INTO affiliate_clicks (id, affiliate_user_id, ip_hash, at, landing_path) VALUES ('k1', 'a1', 'h', ?, '/')", NOW);
    expect(() => db.run("INSERT INTO affiliate_clicks (id, affiliate_user_id, ip_hash, at, landing_path) VALUES ('k2', 'nobody', 'h', ?, '/')", NOW)).toThrow(/FOREIGN/);
    const idx = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'affiliate_clicks'").map((i) => i.name);
    expect(idx.some((n) => n.includes('affiliate'))).toBe(true);
  });

  it('constrains commissions: amount, kind, status, one per order and kind, paid needs a payout', () => {
    user('a1');
    user('m1', 'sub_manager');
    order('o1');
    commission();
    commission({ id: 'c2', kind: 'manager', beneficiary_user_id: 'm1', amount: 200 });
    expect(() => commission({ id: 'c3' })).toThrow(/UNIQUE/);
    order('o2');
    expect(() => commission({ id: 'c4', order_id: 'o2', amount: -1 })).toThrow(/CHECK/);
    expect(() => commission({ id: 'c4', order_id: 'o2', amount: 3.5 })).toThrow(/CHECK/);
    expect(() => commission({ id: 'c4', order_id: 'o2', amount: '300.5' })).toThrow(/CHECK/);
    expect(() => commission({ id: 'c4', order_id: 'o2', kind: 'boss' })).toThrow(/CHECK/);
    expect(() => commission({ id: 'c4', order_id: 'o2', status: 'done' })).toThrow(/CHECK/);
    expect(() => commission({ id: 'c4', order_id: 'o2', on_hold: 2 })).toThrow(/CHECK/);
    expect(() => commission({ id: 'c4', order_id: 'o2', status: 'paid' })).toThrow(/CHECK/);
    expect(() => commission({ id: 'c4', order_id: 'ghost' })).toThrow(/FOREIGN/);
    expect(() => commission({ id: 'c4', order_id: 'o2', beneficiary_user_id: 'ghost' })).toThrow(/FOREIGN/);
    expect(db.get('SELECT status, on_hold, hold_reason, payout_id FROM commissions WHERE id = ?', 'c1')).toEqual({ status: 'pending', on_hold: 0, hold_reason: null, payout_id: null });
  });

  it('constrains payouts and links paid commissions to them', () => {
    user('a1');
    order('o1');
    const payout = (over: Record<string, unknown> = {}) =>
      db.run('INSERT INTO payouts (id, beneficiary_user_id, amount, method, reference, paid_at, note, created_by, created_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
        (over.id as string) ?? 'p1', 'a1', (over.amount as number) ?? 300, (over.method as string) ?? 'cash', NOW, 'a1', NOW);
    payout();
    for (const m of ['ccp', 'baridimob', 'bank', 'other']) payout({ id: `p-${m}`, method: m });
    expect(() => payout({ id: 'p2', method: 'paypal' })).toThrow(/CHECK/);
    expect(() => payout({ id: 'p3', amount: 0 })).toThrow(/CHECK/);
    expect(() => payout({ id: 'p4', amount: 1.5 })).toThrow(/CHECK/);
    commission({ status: 'paid', payout_id: 'p1' });
    expect(() => commission({ id: 'c9', order_id: 'o1', kind: 'manager', status: 'paid', payout_id: 'nope' })).toThrow(/FOREIGN/);
  });

  it('constrains adjustments: integer, non-zero, one "retour" clawback per order and beneficiary', () => {
    user('a1');
    order('o1');
    const adj = (over: Record<string, unknown> = {}) =>
      db.run('INSERT INTO commission_adjustments (id, beneficiary_user_id, amount, reason, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        (over.id as string) ?? 'j1', 'a1', (over.amount as number) ?? -300, (over.reason as string) ?? 'retour', 'o1', NOW);
    adj();
    expect(() => adj({ id: 'j2' })).toThrow(/UNIQUE/);
    expect(() => adj({ id: 'j3', amount: 0, reason: 'autre' })).toThrow(/CHECK/);
    expect(() => adj({ id: 'j4', amount: -1.5, reason: 'autre' })).toThrow(/CHECK/);
    adj({ id: 'j5', amount: -10, reason: 'correction' });
    expect(db.get('SELECT payout_id, created_by FROM commission_adjustments WHERE id = ?', 'j1')).toEqual({ payout_id: null, created_by: null });
  });
});
