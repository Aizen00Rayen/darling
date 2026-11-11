import type { OrderStatus } from '@/shared';
import type { Clock } from '../clock';
import type { Db } from '../db/sqlite';
import { recordAudit } from '../audit';
import { newId } from '../ids';
import { getSetting } from '../settings';

// The commission lifecycle. It runs INSIDE the order transactions (createOrder, changeStatus), never as a separate
// step, so an order and its commissions can never disagree:
//   created            -> `pending` (amounts snapshotted from the settings at that moment)
//   -> delivered       -> pending and not held: `validated`
//   -> cancelled/refused -> pending|validated: `cancelled`
//   -> returned        -> pending|validated: `cancelled`; PAID: a negative adjustment, netted by the next payout
// A `paid` commission never changes status. A held commission stays `pending` until an admin releases it.

export interface CommissionOrder {
  id: string;
  affiliateUserId: string;
  managerUserId: string | null;
  /** Commissions are created on hold with this reason (null = not held). */
  holdReason: string | null;
}

/** Creates the `pending` commissions of a freshly inserted, attributed order: the influenceuse's and her manager's. */
export function createCommissions(tx: Db, clock: Pick<Clock, 'now'>, order: CommissionOrder, now: number): void {
  const hold = order.holdReason !== null;
  const insert = (kind: 'affiliate' | 'manager', beneficiary: string, amount: number) =>
    tx.run(
      `INSERT INTO commissions (id, order_id, beneficiary_user_id, kind, amount, status, on_hold, hold_reason, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      newId(clock),
      order.id,
      beneficiary,
      kind,
      amount,
      hold,
      order.holdReason,
      now,
    );
  // A kind configured at 0 DA gets no row at all: a zero commission would sit in `validated` forever (no payout can settle it).
  const affiliateAmount = getSetting(tx, 'commission.affiliate_amount');
  if (affiliateAmount > 0) insert('affiliate', order.affiliateUserId, affiliateAmount);
  const managerAmount = getSetting(tx, 'commission.manager_amount');
  if (order.managerUserId !== null && managerAmount > 0) insert('manager', order.managerUserId, managerAmount);
}

export interface LifecycleActor {
  userId: string | null;
  ip?: string;
  requestId?: string;
}

interface Row {
  id: string;
  beneficiary_user_id: string;
  kind: string;
  amount: number;
  status: string;
  on_hold: number;
}

const CANCEL_REASON: Partial<Record<OrderStatus, string>> = {
  cancelled: 'commande annulée',
  refused: 'commande refusée',
  returned: 'commande retournée',
};

/** Applies a status change of an order to its commissions (see the table above). Idempotent on its own rows. */
export function applyOrderStatus(tx: Db, clock: Pick<Clock, 'now'>, orderId: string, to: OrderStatus, actor: LifecycleActor, now: number): void {
  const audit = (action: string, row: Row, before: unknown, after: unknown, reason?: string) =>
    recordAudit(tx, {
      actorUserId: actor.userId,
      action,
      entityType: 'commission',
      entityId: row.id,
      before,
      after,
      ...(reason === undefined ? {} : { reason }),
      ...(actor.ip === undefined ? {} : { ip: actor.ip }),
      ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
      at: now,
    });
  const rows = tx.all<Row>('SELECT id, beneficiary_user_id, kind, amount, status, on_hold FROM commissions WHERE order_id = ? ORDER BY kind', orderId);

  if (to === 'delivered') {
    for (const row of rows) {
      if (row.status !== 'pending' || row.on_hold === 1) continue;
      tx.run("UPDATE commissions SET status = 'validated', validated_at = ? WHERE id = ? AND status = 'pending' AND on_hold = 0", now, row.id);
      audit('commission.validated', row, { status: 'pending' }, { status: 'validated', amount: row.amount });
    }
    return;
  }

  const reason = CANCEL_REASON[to];
  if (reason === undefined) return; // confirmed, shipped: nothing to do
  for (const row of rows) {
    if (row.status === 'pending' || row.status === 'validated') {
      tx.run("UPDATE commissions SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ? AND status IN ('pending', 'validated')", now, reason, row.id);
      audit('commission.cancelled', row, { status: row.status }, { status: 'cancelled' }, reason);
    } else if (row.status === 'paid' && to === 'returned' && row.amount > 0) {
      // Already paid out: the money cannot be taken back here, it is deducted from the next payout instead.
      tx.run(
        `INSERT INTO commission_adjustments (id, beneficiary_user_id, amount, reason, order_id, created_at, created_by)
         VALUES (?, ?, ?, 'retour', ?, ?, ?)`,
        newId(clock),
        row.beneficiary_user_id,
        -row.amount,
        orderId,
        now,
        actor.userId,
      );
      audit('commission.clawback', row, { status: 'paid' }, { adjustment: -row.amount }, reason);
    }
  }
}
