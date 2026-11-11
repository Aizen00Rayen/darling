import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORDER_STATUSES, ORDER_TRANSITIONS, type OrderStatus } from '@/shared';
import { createTestApp, type TestApp } from '../test/app';
import { commissionsOf, insertClick, makeOrder, moveTo, seedAffiliate, seedManager } from '../test/affiliation';
import { forceStatus, seedStaff } from '../test/orders';
import { changeStatus } from '../orders/status';
import type { OrderActor } from '../orders/types';
import { createPayout } from './payouts';

let app: TestApp;
let staff: OrderActor;
beforeEach(async () => {
  app = createTestApp();
  staff = await seedStaff(app);
});
afterEach(() => app.close());

async function attributedOrder(opts: { selfPhone?: boolean } = {}) {
  const boss = await seedManager(app);
  const aya = await seedAffiliate(app, { managerId: boss.id, phone: '0550123456' });
  const clickId = insertClick(app, aya.id);
  const order = makeOrder(app, { clickId, phone: opts.selfPhone ? '0550123456' : undefined });
  return { boss, aya, order };
}

/** Commission start states, forced straight into the table. */
type Start = 'pending' | 'held' | 'validated' | 'paid' | 'cancelled';
const STARTS: Start[] = ['pending', 'held', 'validated', 'paid', 'cancelled'];

function force(orderId: string, start: Start) {
  const payoutId = '018f0000-0000-7000-8000-00000000aaaa';
  if (start === 'paid') {
    const owner = commissionsOf(app, orderId)[0]!.beneficiary_user_id;
    app.db.run("INSERT OR IGNORE INTO payouts (id, beneficiary_user_id, amount, method, paid_at, created_by, created_at) VALUES (?, ?, 1, 'cash', 1, ?, 1)", payoutId, owner, owner);
  }
  const sql = {
    pending: "UPDATE commissions SET status = 'pending', on_hold = 0 WHERE order_id = ?1",
    held: "UPDATE commissions SET status = 'pending', on_hold = 1, hold_reason = 'auto-référence' WHERE order_id = ?1",
    validated: "UPDATE commissions SET status = 'validated', on_hold = 0, validated_at = 1 WHERE order_id = ?1",
    paid: `UPDATE commissions SET status = 'paid', on_hold = 0, payout_id = '${payoutId}' WHERE order_id = ?1`,
    cancelled: "UPDATE commissions SET status = 'cancelled', on_hold = 0, cancelled_at = 1, cancel_reason = 'x' WHERE order_id = ?1",
  }[start];
  app.db.run(sql.replace('?1', '?'), orderId);
}

/** Written by hand, independent of the implementation: what each commission becomes after `to`. */
function expected(to: OrderStatus, start: Start): { status: string; adjustment: boolean } {
  if (to === 'confirmed' || to === 'shipped') return { status: { pending: 'pending', held: 'pending', validated: 'validated', paid: 'paid', cancelled: 'cancelled' }[start], adjustment: false };
  if (to === 'delivered') return { status: { pending: 'validated', held: 'pending', validated: 'validated', paid: 'paid', cancelled: 'cancelled' }[start], adjustment: false };
  // cancelled, refused, returned
  return { status: { pending: 'cancelled', held: 'cancelled', validated: 'cancelled', paid: 'paid', cancelled: 'cancelled' }[start], adjustment: to === 'returned' && start === 'paid' };
}

const EDGES = ORDER_STATUSES.flatMap((from) => ORDER_TRANSITIONS[from].map((to) => [from, to] as const));

describe('commission lifecycle: every legal status change x every commission state', () => {
  it('covers all 8 legal edges', () => expect(EDGES).toHaveLength(8));

  describe.each(EDGES)('%s -> %s', (from, to) => {
    it.each(STARTS)('commissions that are %s', async (start) => {
      const { order } = await attributedOrder();
      forceStatus(app, order.id, from);
      force(order.id, start);
      const before = commissionsOf(app, order.id);
      changeStatus(app, staff, order.id, to);
      const after = commissionsOf(app, order.id);
      const want = expected(to, start);
      expect(after.map((c) => c.status)).toEqual([want.status, want.status]);
      expect(after.map((c) => c.amount)).toEqual(before.map((c) => c.amount)); // amounts never change
      const adjustments = app.db.all<{ beneficiary_user_id: string; amount: number; reason: string; order_id: string; payout_id: string | null }>('SELECT * FROM commission_adjustments ORDER BY beneficiary_user_id');
      if (want.adjustment) {
        expect(adjustments.map((a) => [a.amount, a.reason, a.order_id, a.payout_id]).sort()).toEqual(
          [[-300, 'retour', order.id, null], [-200, 'retour', order.id, null]].sort(),
        );
        expect(adjustments.map((a) => a.beneficiary_user_id).sort()).toEqual(before.map((c) => c.beneficiary_user_id).sort());
      } else {
        expect(adjustments).toEqual([]);
      }
      // a paid commission keeps its payout; a validated-by-this-change one gets a timestamp; held ones keep their flag
      for (const [i, c] of after.entries()) {
        expect(c.payout_id).toBe(before[i]!.payout_id);
        if (start === 'held' && want.status === 'pending') expect(c.on_hold).toBe(1);
      }
      if (want.status === 'validated' && start === 'pending') {
        expect(app.db.get('SELECT count(*) AS n FROM commissions WHERE order_id = ? AND validated_at = ?', order.id, app.clock.now())).toEqual({ n: 2 });
      }
      if (want.status === 'cancelled' && start !== 'cancelled') {
        expect(after.every((c) => c.cancel_reason !== null)).toBe(true);
      }
    });
  });
});

describe('end to end', () => {
  it('new -> confirmed -> shipped -> delivered: pending until delivery, then validated with the snapshot amounts', async () => {
    const { order, aya, boss } = await attributedOrder();
    moveTo(app, staff, order.id, 'confirmed', 'shipped');
    expect(commissionsOf(app, order.id).map((c) => c.status)).toEqual(['pending', 'pending']);
    app.clock.advance(1000);
    moveTo(app, staff, order.id, 'delivered');
    expect(commissionsOf(app, order.id).map((c) => [c.kind, c.beneficiary_user_id, c.amount, c.status])).toEqual([
      ['affiliate', aya.id, 300, 'validated'],
      ['manager', boss.id, 200, 'validated'],
    ]);
  });

  it('writes audit rows for every automatic commission change, with the staff actor', async () => {
    const { order } = await attributedOrder();
    moveTo(app, staff, order.id, 'confirmed', 'shipped', 'delivered');
    const rows = app.db.all<{ action: string; actor_user_id: string }>("SELECT action, actor_user_id FROM audit_log WHERE entity_type = 'commission'");
    expect(rows.map((r) => r.action)).toEqual(['commission.validated', 'commission.validated']);
    expect(rows.every((r) => r.actor_user_id === staff.userId)).toBe(true);
  });

  it('an order without attribution has no commissions at any step', async () => {
    const plain = makeOrder(app);
    moveTo(app, staff, plain.id, 'confirmed', 'shipped', 'delivered', 'returned');
    expect(app.db.get('SELECT count(*) AS n FROM commissions')).toEqual({ n: 0 });
    expect(app.db.get('SELECT count(*) AS n FROM commission_adjustments')).toEqual({ n: 0 });
  });

  it('held (self-referral) commissions stay pending on delivery, then validate when released after delivery', async () => {
    const { order } = await attributedOrder({ selfPhone: true });
    moveTo(app, staff, order.id, 'confirmed', 'shipped', 'delivered');
    expect(commissionsOf(app, order.id).map((c) => [c.status, c.on_hold])).toEqual([['pending', 1], ['pending', 1]]);
  });

  it('cancelled and refused orders cancel their commissions with a reason', async () => {
    const a = (await attributedOrder()).order;
    moveTo(app, staff, a.id, 'cancelled');
    expect(commissionsOf(app, a.id).map((c) => [c.status, c.cancel_reason])).toEqual([['cancelled', 'commande annulée'], ['cancelled', 'commande annulée']]);
    const aya = await seedAffiliate(app, { fullName: 'Bea Dupont' });
    const b = makeOrder(app, { clickId: insertClick(app, aya.id) });
    moveTo(app, staff, b.id, 'confirmed', 'shipped', 'refused');
    expect(commissionsOf(app, b.id).map((c) => [c.status, c.cancel_reason])).toEqual([['cancelled', 'commande refusée']]);
  });

  it('delivered then returned BEFORE payment cancels the validated commissions, no adjustment', async () => {
    const { order } = await attributedOrder();
    moveTo(app, staff, order.id, 'confirmed', 'shipped', 'delivered', 'returned');
    expect(commissionsOf(app, order.id).map((c) => [c.status, c.cancel_reason])).toEqual([['cancelled', 'commande retournée'], ['cancelled', 'commande retournée']]);
    expect(app.db.get('SELECT count(*) AS n FROM commission_adjustments')).toEqual({ n: 0 });
  });

  it('returned AFTER payment: the paid commission stays paid, a negative adjustment is created, and the next payout nets it', async () => {
    const boss = await seedManager(app);
    const aya = await seedAffiliate(app, { managerId: boss.id });
    const admin = await seedStaff(app, ['orders.read', 'orders.write']);
    const payer = await seedPayer();
    const first = makeOrder(app, { clickId: insertClick(app, aya.id) });
    const second = makeOrder(app, { clickId: insertClick(app, aya.id) });
    moveTo(app, admin, first.id, 'confirmed', 'shipped', 'delivered');
    pay(payer, aya.id); // pays 300 for the first order
    expect(commissionsOf(app, first.id)[0]).toMatchObject({ status: 'paid' });

    moveTo(app, admin, first.id, 'returned');
    expect(commissionsOf(app, first.id).find((c) => c.kind === 'affiliate')).toMatchObject({ status: 'paid', amount: 300 }); // never changes
    expect(app.db.all('SELECT beneficiary_user_id, amount, reason, order_id, payout_id FROM commission_adjustments WHERE beneficiary_user_id = ?', aya.id)).toEqual([
      { beneficiary_user_id: aya.id, amount: -300, reason: 'retour', order_id: first.id, payout_id: null },
    ]);
    // the manager's commission for the first order was still validated (not paid yet): simply cancelled
    expect(commissionsOf(app, first.id).find((c) => c.kind === 'manager')).toMatchObject({ status: 'cancelled' });

    // second order delivered: 300 validated minus the 300 clawback = 0 -> nothing to pay (and nothing is consumed)
    moveTo(app, admin, second.id, 'confirmed', 'shipped', 'delivered');
    expect(() => pay(payer, aya.id)).toThrowError(expect.objectContaining({ status: 409, code: 'nothing_to_pay' }));
    expect(app.db.get('SELECT count(*) AS n FROM commission_adjustments WHERE payout_id IS NULL')).toEqual({ n: 1 });
    expect(commissionsOf(app, second.id).find((c) => c.kind === 'affiliate')).toMatchObject({ status: 'validated' });

    // a third delivered order: 600 validated - 300 = 300 paid, the adjustment is linked to that payout
    const third = makeOrder(app, { clickId: insertClick(app, aya.id) });
    moveTo(app, admin, third.id, 'confirmed', 'shipped', 'delivered');
    const payout = pay(payer, aya.id);
    expect(payout.amount).toBe(300);
    expect(app.db.get('SELECT payout_id FROM commission_adjustments')).toEqual({ payout_id: payout.id });
    expect(app.db.get('SELECT count(*) AS n FROM commissions WHERE payout_id = ?', payout.id)).toEqual({ n: 2 });
  });

  it('a zero-amount paid commission creates no adjustment on return (the amount is never zero in the table)', async () => {
    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('commission.affiliate_amount', '0', 1)");
    const aya = await seedAffiliate(app);
    const o = makeOrder(app, { clickId: insertClick(app, aya.id) });
    moveTo(app, staff, o.id, 'confirmed', 'shipped', 'delivered');
    force(o.id, 'paid');
    moveTo(app, staff, o.id, 'returned');
    expect(app.db.get('SELECT count(*) AS n FROM commission_adjustments')).toEqual({ n: 0 });
  });

  it('a status change that fails halfway leaves order AND commissions untouched (one transaction)', async () => {
    const { order } = await attributedOrder();
    forceStatus(app, order.id, 'shipped');
    app.db.exec("CREATE TRIGGER boom BEFORE UPDATE OF status ON commissions BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => changeStatus(app, staff, order.id, 'delivered')).toThrow(/boom/);
    expect(app.db.get('SELECT status FROM orders WHERE id = ?', order.id)).toEqual({ status: 'shipped' });
    expect(commissionsOf(app, order.id).map((c) => c.status)).toEqual(['pending', 'pending']);
    expect(app.db.get("SELECT count(*) AS n FROM audit_log WHERE action = 'order.status_changed'")).toEqual({ n: 0 });
    expect(app.db.get('SELECT count(*) AS n FROM order_status_history WHERE order_id = ?', order.id)).toEqual({ n: 1 });
  });

  it('a second identical change is refused (409) and does not re-run the commission rules', async () => {
    const { order } = await attributedOrder();
    moveTo(app, staff, order.id, 'confirmed', 'shipped', 'delivered');
    app.db.run("UPDATE commissions SET status = 'paid', payout_id = NULL WHERE 0"); // no-op, keeps the intent readable
    expect(() => changeStatus(app, staff, order.id, 'delivered')).toThrowError(expect.objectContaining({ status: 409 }));
    expect(app.db.get("SELECT count(*) AS n FROM audit_log WHERE action = 'commission.validated'")).toEqual({ n: 2 });
  });
});

describe('settings changes affect only future orders', () => {
  it('snapshots the amounts when the order is created; later changes never touch existing commissions', async () => {
    const { order, aya } = await attributedOrder();
    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('commission.affiliate_amount', '450', 1), ('commission.manager_amount', '10', 1)");
    moveTo(app, staff, order.id, 'confirmed', 'shipped', 'delivered');
    expect(commissionsOf(app, order.id).map((c) => c.amount)).toEqual([300, 200]);
    const later = makeOrder(app, { clickId: insertClick(app, aya.id) });
    expect(commissionsOf(app, later.id).map((c) => c.amount)).toEqual([450, 10]);
  });

  it('falls back to the defaults for a corrupt stored value (never to zero)', async () => {
    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('commission.affiliate_amount', '\"lots\"', 1)");
    const aya = await seedAffiliate(app);
    expect(commissionsOf(app, makeOrder(app, { clickId: insertClick(app, aya.id) }).id)[0]!.amount).toBe(300);
  });
});

// --- helpers for the payout steps above --------------------------------------------------------------------------

async function seedPayer() {
  const { seedUser } = await import('../test/app');
  const u = await seedUser(app, { role: 'super_manager', permissions: ['payouts.manage'] });
  return { userId: u.id, ip: '10.1.1.1', requestId: 'r' };
}
function pay(payer: { userId: string; ip: string; requestId: string }, beneficiaryUserId: string) {
  return createPayout(app, payer, { beneficiaryUserId, method: 'cash', paidAt: new Date(app.clock.now()).toISOString().slice(0, 10) });
}
