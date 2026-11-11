import type { Clock } from '../clock';
import type { Db } from '../db/sqlite';
import { HttpFailure, notFound, validation } from '../admin/errors';
import { recordAudit } from '../audit';
import { authorisePermission } from './authorise';

// Staff actions on ONE commission (permission `commissions.manage`). Each runs in one immediate transaction that
// re-authorises the actor, re-reads the commission, changes it and writes its audit row.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CANCEL_REASON_MAX = 500;

export interface CommissionActor {
  userId: string;
  ip: string;
  requestId: string;
}

interface Row {
  id: string;
  order_id: string;
  status: string;
  on_hold: number;
  hold_reason: string | null;
  order_status: string;
}

function load(tx: Db, id: string): Row {
  if (!UUID.test(id)) throw notFound();
  const row = tx.get<Row>(
    `SELECT c.id, c.order_id, c.status, c.on_hold, c.hold_reason, o.status AS order_status
     FROM commissions c JOIN orders o ON o.id = c.order_id WHERE c.id = ?`,
    id,
  );
  if (!row) throw notFound();
  return row;
}

/**
 * Releases a held commission. If its order is already delivered it becomes `validated` in the same transaction (it
 * could not be validated while held); otherwise it simply stays `pending` and validates on delivery.
 * 409 `not_on_hold` when it is not held; 409 `commission_closed` when it is cancelled or paid.
 */
export function releaseHold(deps: { db: Db; clock: Clock }, actor: CommissionActor, id: string): { status: string } {
  return deps.db.transaction((tx) => {
    authorisePermission(tx, actor.userId, 'commissions.manage');
    const row = load(tx, id);
    if (row.on_hold !== 1) throw new HttpFailure(409, 'not_on_hold');
    if (row.status !== 'pending') throw new HttpFailure(409, 'commission_closed');
    const now = deps.clock.now();
    const validate = row.order_status === 'delivered';
    tx.run(
      `UPDATE commissions SET on_hold = 0${validate ? ", status = 'validated', validated_at = :now" : ''} WHERE id = :id AND status = 'pending' AND on_hold = 1`,
      validate ? { id, now } : { id },
    );
    const status = validate ? 'validated' : 'pending';
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'commission.hold_released',
      entityType: 'commission',
      entityId: id,
      before: { status: row.status, onHold: true, holdReason: row.hold_reason },
      after: { status, onHold: false },
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    return { status };
  }, 'immediate');
}

/** Cancels a `pending` or `validated` commission with a reason. Paid (and already cancelled) commissions answer 409. */
export function cancelCommission(deps: { db: Db; clock: Clock }, actor: CommissionActor, id: string, reasonInput: string): { status: string } {
  const reason = reasonInput.trim();
  if (reason === '') throw validation({ reason: 'Indiquez le motif de l’annulation.' });
  if (reason.length > CANCEL_REASON_MAX) throw validation({ reason: `Le motif est trop long (${CANCEL_REASON_MAX} caractères maximum).` });
  return deps.db.transaction((tx) => {
    authorisePermission(tx, actor.userId, 'commissions.manage');
    const row = load(tx, id);
    if (row.status === 'paid') throw new HttpFailure(409, 'commission_paid');
    if (row.status === 'cancelled') throw new HttpFailure(409, 'commission_cancelled');
    const now = deps.clock.now();
    const result = tx.run("UPDATE commissions SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ? AND status IN ('pending', 'validated')", now, reason, id);
    if (result.changes !== 1) throw new HttpFailure(409, 'commission_closed');
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'commission.cancelled',
      entityType: 'commission',
      entityId: id,
      before: { status: row.status, onHold: row.on_hold === 1 },
      after: { status: 'cancelled' },
      reason,
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    return { status: 'cancelled' };
  }, 'immediate');
}
