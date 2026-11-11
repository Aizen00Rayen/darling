import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchApi } from '../server/api-registry';
import { fixedClock } from '../server/clock';
import { setServerContextForTests } from '../server/context';
import { applyMigrations } from '../server/db/migrate';
import { openDatabase, type Db } from '../server/db/sqlite';
import { memoryMailer } from '../server/mail/mailer';
import { createRateLimiter } from '../server/security/rate-limit';
import { getSetting } from '../server/settings';
import { testConfig } from '../server/test/app';
import { DEMO_PASSWORD, main, seedDemo, type DemoSummary } from './demo-seed';

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const count = (db: Db, sql: string, ...p: string[]) => db.get<{ n: number }>(sql, ...p)?.n ?? 0;

describe('demo seed (in memory)', () => {
  let db: Db;
  let summary: DemoSummary;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    applyMigrations(db);
    summary = await seedDemo({ db, config: testConfig(), now: NOW });
  }, 60_000);
  afterAll(() => db.close());

  it('creates the people: owner, restricted super manager, sous-manager and three influenceuses', () => {
    const owner = db.get<{ is_owner: number; totp_enabled: number; status: string }>("SELECT is_owner, totp_enabled, status FROM users WHERE email = 'owner@demo.darling.test'");
    expect(owner).toEqual({ is_owner: 1, totp_enabled: 0, status: 'active' });
    const ops = db.get<{ is_owner: number; role: string }>("SELECT is_owner, role FROM users WHERE email = 'ops@demo.darling.test'");
    expect(ops).toEqual({ is_owner: 0, role: 'super_manager' });
    const grants = db.all<{ permission: string }>("SELECT permission FROM user_permissions WHERE user_id = (SELECT id FROM users WHERE email = 'ops@demo.darling.test') ORDER BY permission");
    expect(grants.map((g) => g.permission)).toEqual(['orders.read', 'orders.write']);
    expect(count(db, "SELECT count(*) AS n FROM users WHERE role = 'sub_manager'")).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM users WHERE role = 'affiliate' AND status = 'active'")).toBe(3);
    expect(count(db, 'SELECT count(*) AS n FROM users')).toBe(6);
    const codes = db.all<{ code: string; manager: string | null }>(
      'SELECT p.code, m.email AS manager FROM affiliate_profiles p LEFT JOIN users m ON m.id = p.manager_user_id ORDER BY p.code',
    );
    expect(codes).toEqual([
      { code: 'AYA001', manager: 'karim@demo.darling.test' },
      { code: 'LIN001', manager: 'karim@demo.darling.test' },
      { code: 'SAR001', manager: null },
    ]);
  });

  it('turns the 2FA requirement off so the owner can log in directly', () => {
    expect(getSetting(db, 'security.require_2fa_super_managers')).toBe(false);
  });

  it('every demo account logs in with the documented password through the real login route', async () => {
    const clock = fixedClock(NOW);
    const ctx = { db, clock, config: testConfig(), mailer: memoryMailer(), limiter: createRateLimiter(clock) };
    setServerContextForTests(ctx);
    try {
      const statuses: number[] = [];
      for (const [i, account] of summary.accounts.entries()) {
        const headers = { 'X-Requested-With': 'fetch', Origin: ctx.config.appOrigin, 'X-Forwarded-For': `10.1.1.${i + 1}`, 'Content-Type': 'application/json' };
        const res = await dispatchApi(new Request(`${ctx.config.appOrigin}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email: account.email, password: DEMO_PASSWORD }) }));
        statuses.push(res.status);
      }
      expect(statuses).toEqual(summary.accounts.map(() => 200));
    } finally {
      setServerContextForTests(null);
    }
  }, 30_000);

  it('has at least 25 orders covering every status and several sources, spread over ~14 days', () => {
    expect(summary.orders.total).toBeGreaterThanOrEqual(25);
    for (const status of ['new', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refused', 'returned']) {
      expect(summary.orders.byStatus[status] ?? 0, status).toBeGreaterThanOrEqual(1);
    }
    expect(summary.orders.byStatus.delivered).toBeGreaterThan(summary.orders.byStatus.new ?? 0);
    const sources = db.all<{ source: string }>('SELECT DISTINCT source FROM orders').map((r) => r.source);
    expect(sources).toEqual(expect.arrayContaining(['website', 'affiliate', 'instagram', 'whatsapp']));
    const span = db.get<{ lo: number; hi: number }>('SELECT min(created_at) AS lo, max(created_at) AS hi FROM orders');
    expect(NOW - (span?.lo ?? NOW)).toBeGreaterThan(12 * 86_400_000);
    expect(NOW - (span?.lo ?? NOW)).toBeLessThanOrEqual(15 * 86_400_000);
    expect(span?.hi ?? 0).toBeLessThanOrEqual(NOW);
  });

  it('never writes a timestamp in the future', () => {
    for (const col of ['created_at', 'updated_at', 'confirmed_at', 'shipped_at', 'delivered_at', 'closed_at']) {
      expect(count(db, `SELECT count(*) AS n FROM orders WHERE ${col} > ${NOW}`), col).toBe(0);
    }
    expect(count(db, `SELECT count(*) AS n FROM order_status_history WHERE at > ${NOW}`)).toBe(0);
    expect(count(db, `SELECT count(*) AS n FROM affiliate_clicks WHERE at > ${NOW}`)).toBe(0);
    expect(count(db, `SELECT count(*) AS n FROM audit_log WHERE at > ${NOW}`)).toBe(0);
  });

  it('shows every commission state at least once, including an order on hold', () => {
    for (const status of ['pending', 'validated', 'paid', 'cancelled']) {
      expect(summary.commissions.byStatus[status] ?? 0, status).toBeGreaterThanOrEqual(1);
    }
    expect(summary.commissions.onHold).toBeGreaterThanOrEqual(1);
    const held = db.get<{ self_referral: number; status: string; phone: string }>(
      "SELECT o.self_referral, o.status, o.phone FROM orders o WHERE o.self_referral = 1",
    );
    expect(held?.self_referral).toBe(1);
    expect(held?.phone).toBe(db.get<{ phone: string }>("SELECT phone FROM users WHERE email = 'sara@demo.darling.test'")?.phone);
    expect(count(db, "SELECT count(*) AS n FROM commissions WHERE on_hold = 1 AND status = 'pending'")).toBeGreaterThanOrEqual(1);
  });

  it('gives each influenceuse and the manager a mix of commission states', () => {
    const states = (email: string) =>
      new Set(
        db
          .all<{ status: string; on_hold: number }>(
            'SELECT c.status, c.on_hold FROM commissions c JOIN users u ON u.id = c.beneficiary_user_id WHERE u.email = ?',
            email,
          )
          .map((r) => (r.on_hold === 1 ? 'on_hold' : r.status)),
      );
    for (const email of ['aya@demo.darling.test', 'lina@demo.darling.test', 'karim@demo.darling.test']) {
      for (const s of ['pending', 'validated', 'paid', 'cancelled']) expect(states(email), `${email} ${s}`).toContain(s);
    }
    for (const s of ['pending', 'validated', 'cancelled', 'on_hold']) expect(states('sara@demo.darling.test'), `sara ${s}`).toContain(s);
  });

  it('has payouts and a clawback adjustment for an order returned after payment', () => {
    expect(summary.payouts.count).toBeGreaterThanOrEqual(1);
    const aya = db.get<{ n: number }>("SELECT count(*) AS n FROM payouts p JOIN users u ON u.id = p.beneficiary_user_id WHERE u.email = 'aya@demo.darling.test'");
    expect(aya?.n).toBeGreaterThanOrEqual(1);
    expect(summary.adjustments.count).toBeGreaterThanOrEqual(1);
    const adj = db.all<{ amount: number; order_id: string; payout_id: string | null }>('SELECT amount, order_id, payout_id FROM commission_adjustments');
    for (const a of adj) {
      expect(a.amount).toBeLessThan(0);
      expect(a.payout_id).toBeNull(); // not netted yet: the next payout will do it
      expect(db.get<{ status: string }>('SELECT status FROM orders WHERE id = ?', a.order_id)?.status).toBe('returned');
    }
    expect(summary.totalToPay).toBeGreaterThan(0);
  });

  it('has more clicks than orders for every influenceuse, and every attributed order points at a click or a staff code', () => {
    const rows = db.all<{ code: string; clicks: number; orders: number }>(
      `SELECT p.code,
              (SELECT count(*) FROM affiliate_clicks k WHERE k.affiliate_user_id = p.user_id) AS clicks,
              (SELECT count(*) FROM orders o WHERE o.affiliate_user_id = p.user_id) AS orders
       FROM affiliate_profiles p`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.orders, r.code).toBeGreaterThanOrEqual(3);
      expect(r.clicks, r.code).toBeGreaterThan(r.orders);
    }
    expect(count(db, "SELECT count(*) AS n FROM orders WHERE affiliate_user_id IS NOT NULL AND attribution_click_id IS NULL AND source = 'website'")).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM orders WHERE attribution_click_id IS NOT NULL')).toBeGreaterThanOrEqual(10);
    expect(count(db, "SELECT count(*) AS n FROM orders WHERE affiliate_user_id IS NOT NULL AND attribution_click_id IS NULL AND source <> 'website'")).toBeGreaterThanOrEqual(1);
  });

  it('keeps the invariants: one commission per (order, kind), totals, history, payouts', () => {
    expect(count(db, 'SELECT count(*) AS n FROM (SELECT order_id, kind FROM commissions GROUP BY order_id, kind HAVING count(*) > 1)')).toBe(0);
    const bad = db.all<{ number: string }>('SELECT number FROM orders WHERE total <> unit_price * quantity + delivery_fee');
    expect(bad).toEqual([]);
    // every order has a first history row and a history that ends on its current status
    expect(count(db, 'SELECT count(*) AS n FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.from_status IS NULL)')).toBe(0);
    expect(
      count(db, 'SELECT count(*) AS n FROM orders o WHERE o.status <> (SELECT to_status FROM order_status_history h WHERE h.order_id = o.id ORDER BY h.at DESC, h.id DESC LIMIT 1)'),
    ).toBe(0);
    // a payout equals its paid commissions plus the adjustments it netted
    const payouts = db.all<{ id: string; amount: number }>('SELECT id, amount FROM payouts');
    for (const p of payouts) {
      const paid = db.get<{ s: number }>("SELECT coalesce(sum(amount), 0) AS s FROM commissions WHERE payout_id = ? AND status = 'paid'", p.id)?.s ?? 0;
      const adj = db.get<{ s: number }>('SELECT coalesce(sum(amount), 0) AS s FROM commission_adjustments WHERE payout_id = ?', p.id)?.s ?? 0;
      expect(p.amount).toBe(paid + adj);
    }
    // every paid commission belongs to a payout, and the sum of paid commissions covers the payouts
    expect(count(db, "SELECT count(*) AS n FROM commissions WHERE status = 'paid' AND payout_id IS NULL")).toBe(0);
    const paidSum = db.get<{ s: number }>("SELECT sum(amount) AS s FROM commissions WHERE status = 'paid'")?.s ?? 0;
    const payoutSum = db.get<{ s: number }>('SELECT sum(amount) AS s FROM payouts')?.s ?? 0;
    expect(paidSum).toBeGreaterThanOrEqual(payoutSum);
    // commissions of cancelled, refused or returned orders are cancelled unless they were already paid
    expect(
      count(db, "SELECT count(*) AS n FROM commissions c JOIN orders o ON o.id = c.order_id WHERE o.status IN ('cancelled','refused','returned') AND c.status IN ('pending','validated')"),
    ).toBe(0);
  });

  it('is deterministic: the same clock gives the same orders', async () => {
    const other = openDatabase(':memory:');
    applyMigrations(other);
    await seedDemo({ db: other, config: testConfig(), now: NOW });
    const shape = (d: Db) =>
      d.all('SELECT number, status, source, customer_name, phone, wilaya_code, commune, quantity, created_at FROM orders ORDER BY seq');
    expect(shape(other)).toEqual(shape(db));
    other.close();
  }, 60_000);
});

describe('demo seed command', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-demo-'));
    dirs.push(d);
    return d;
  };
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) } };
  };

  it('refuses to run in production, touching nothing', async () => {
    const dir = tmp();
    const { io: i, err } = io();
    const code = await main([], env({ NODE_ENV: 'production', DATA_DIR: dir }), i);
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/production/i);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('seeds an empty directory, prints the credentials block, then refuses a second run unless --reset', async () => {
    const dir = tmp();
    const first = io();
    expect(await main([], env({ DATA_DIR: dir }), first.io)).toBe(0);
    const text = first.out.join('');
    expect(text).toContain(DEMO_PASSWORD);
    expect(text).toContain('owner@demo.darling.test');
    expect(text).toContain('http://localhost:3000/connexion');
    expect(text).toContain('http://localhost:3000/?ref=AYA001');
    expect(fs.existsSync(path.join(dir, '.demo-env'))).toBe(true);

    const before = fs.statSync(path.join(dir, 'darling.sqlite')).mtimeMs;
    const second = io();
    expect(await main([], env({ DATA_DIR: dir }), second.io)).toBe(1);
    expect(second.err.join('')).toMatch(/already|--reset/);
    expect(fs.statSync(path.join(dir, 'darling.sqlite')).mtimeMs).toBe(before);

    const third = io();
    expect(await main(['--reset'], env({ DATA_DIR: dir }), third.io)).toBe(0);
    const db = openDatabase(path.join(dir, 'darling.sqlite'));
    expect(count(db, 'SELECT count(*) AS n FROM users')).toBe(6);
    db.close();
  }, 120_000);

  it('--reset deletes only the demo database: it refuses a directory that was never a demo one', async () => {
    const dir = tmp();
    const db = openDatabase(path.join(dir, 'darling.sqlite'));
    applyMigrations(db);
    db.run("INSERT INTO users (id, email, full_name, role, status, created_at, updated_at) VALUES ('x', 'real@example.com', 'Real', 'affiliate', 'invited', 1, 1)");
    db.close();
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
    const { io: i, err } = io();
    expect(await main(['--reset'], env({ DATA_DIR: dir }), i)).toBe(1);
    expect(err.join('')).toMatch(/demo/i);
    expect(fs.existsSync(path.join(dir, 'darling.sqlite'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses a database that already has users without --reset', async () => {
    const dir = tmp();
    const db = openDatabase(path.join(dir, 'darling.sqlite'));
    applyMigrations(db);
    db.run("INSERT INTO users (id, email, full_name, role, status, created_at, updated_at) VALUES ('x', 'real@example.com', 'Real', 'affiliate', 'invited', 1, 1)");
    db.close();
    const { io: i, err } = io();
    expect(await main([], env({ DATA_DIR: dir }), i)).toBe(1);
    expect(err.join('')).toMatch(/already has users/);
  });
});
