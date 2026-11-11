import { INTERNAL_NOTES_MAX, STATUS_NOTE_MAX, canTransition, isOrderStatus, type OrderDetail, type OrderDto, type OrderStatus } from '@/shared';
import { HttpFailure, notFound } from '../admin/errors';
import { recordAudit } from '../audit';
import { applyOrderStatus } from '../commissions/lifecycle';
import { authoriseOrdersWrite } from './authorise';
import { InvalidTransitionError } from './errors';
import { assertOrderId, readDetail, readOrder } from './read';
import type { OrderActor, OrderDeps } from './types';

const blankToNull = (text: string | null | undefined): string | null => {
  const trimmed = (text ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

/** The timestamp column a status sets when an order enters it. The three final statuses all set `closed_at`. */
const TIMESTAMP_OF: Record<OrderStatus, 'confirmed_at' | 'shipped_at' | 'delivered_at' | 'closed_at' | null> = {
  new: null,
  confirmed: 'confirmed_at',
  shipped: 'shipped_at',
  delivered: 'delivered_at',
  cancelled: 'closed_at',
  refused: 'closed_at',
  returned: 'closed_at',
};

/**
 * Moves an order along the status machine (shared/orders.ts). One `BEGIN IMMEDIATE` transaction: the actor is
 * re-authorised, the order is RE-READ here (the status the caller looked at may be gone), the change is checked,
 * and the order update, the history row and the audit row commit together or not at all.
 * Illegal changes, the same status included, throw `InvalidTransitionError` (409 `invalid_transition`).
 */
export function changeStatus(deps: OrderDeps, actor: OrderActor, id: string, to: OrderStatus, note?: string | null): OrderDetail {
  assertOrderId(id);
  const cleanNote = blankToNull(note);
  if (cleanNote !== null && cleanNote.length > STATUS_NOTE_MAX) {
    throw new HttpFailure(400, 'validation', { note: `La note est trop longue (${STATUS_NOTE_MAX} caractères maximum).` });
  }
  return deps.db.transaction((tx) => {
    authoriseOrdersWrite(tx, actor.userId);
    const current = tx.get<{ status: string }>('SELECT status FROM orders WHERE id = ?', id);
    if (!current || !isOrderStatus(current.status)) throw notFound();
    const from = current.status;
    if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);

    const now = deps.clock.now();
    const column = TIMESTAMP_OF[to];
    // The WHERE re-states the status that was judged: a concurrent change cannot slip in between.
    const result = tx.run(
      `UPDATE orders SET status = :to, updated_at = :now${column ? `, ${column} = :now` : ''} WHERE id = :id AND status = :from`,
      { to, now, id, from },
    );
    if (result.changes !== 1) throw new InvalidTransitionError(from, to);
    tx.run('INSERT INTO order_status_history (order_id, from_status, to_status, actor_user_id, note, at) VALUES (?, ?, ?, ?, ?, ?)', id, from, to, actor.userId, cleanNote, now);
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'order.status_changed',
      entityType: 'order',
      entityId: id,
      before: { status: from },
      after: { status: to },
      ...(cleanNote === null ? {} : { reason: cleanNote }),
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    // The commissions follow the order in the SAME transaction (validate on delivery, cancel or claw back otherwise).
    applyOrderStatus(tx, deps.clock, id, to, { userId: actor.userId, ip: actor.ip, requestId: actor.requestId }, now);
    const detail = readDetail(tx, id);
    if (!detail) throw notFound();
    return detail;
  }, 'immediate');
}

/** Replaces the internal notes (blank or null clears them). Audited without the text: the notes can hold customer details. */
export function updateNotes(deps: OrderDeps, actor: OrderActor, id: string, notes: string | null): OrderDto {
  assertOrderId(id);
  const clean = blankToNull(notes);
  if (clean !== null && clean.length > INTERNAL_NOTES_MAX) {
    throw new HttpFailure(400, 'validation', { internalNotes: `Les notes sont trop longues (${INTERNAL_NOTES_MAX} caractères maximum).` });
  }
  return deps.db.transaction((tx) => {
    authoriseOrdersWrite(tx, actor.userId);
    const current = tx.get<{ internal_notes: string | null }>('SELECT internal_notes FROM orders WHERE id = ?', id);
    if (!current) throw notFound();
    const now = deps.clock.now();
    tx.run('UPDATE orders SET internal_notes = ?, updated_at = ? WHERE id = ?', clean, now, id);
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'order.notes_updated',
      entityType: 'order',
      entityId: id,
      before: { notesLength: current.internal_notes?.length ?? 0 },
      after: { notesLength: clean?.length ?? 0 },
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    const order = readOrder(tx, id);
    if (!order) throw notFound();
    return order;
  }, 'immediate');
}
