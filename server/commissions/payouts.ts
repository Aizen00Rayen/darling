import { PAYOUT_METHODS, type AdminPayoutRow, type PayoutMethod } from '@/shared';
import type { Clock } from '../clock';
import type { Db, Scalar } from '../db/sqlite';
import { forbidden, HttpFailure, notFound, validation } from '../admin/errors';
import { recordAudit } from '../audit';
import { newId } from '../ids';
import { algiersDateString, algiersDayBounds } from '../util/algiers';
import { authorisePermission } from './authorise';

export const PAYOUTS_PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PayoutInput {
  beneficiaryUserId: string;
  method: PayoutMethod;
  reference?: string | null | undefined;
  /** The Algiers calendar day the money was handed over, `YYYY-MM-DD` (not in the future). */
  paidAt: string;
  note?: string | null | undefined;
}

export interface PayoutActor {
  userId: string;
  ip: string;
  requestId: string;
}

const clean = (text: string | null | undefined): string | null => {
  const t = (text ?? '').trim();
  return t === '' ? null : t;
};

/** What a payout to this person would be right now: validated, not-held commissions plus their unnetted adjustments. */
export function payableOf(db: Db, userId: string): { commissions: number; commissionCount: number; adjustments: number; amount: number } {
  const c = db.get<{ n: number; sum: number | null }>("SELECT count(*) AS n, sum(amount) AS sum FROM commissions WHERE beneficiary_user_id = ? AND status = 'validated' AND on_hold = 0", userId);
  const a = db.get<{ sum: number | null }>('SELECT sum(amount) AS sum FROM commission_adjustments WHERE beneficiary_user_id = ? AND payout_id IS NULL', userId);
  const commissions = c?.sum ?? 0;
  const adjustments = a?.sum ?? 0;
  return { commissions, commissionCount: c?.n ?? 0, adjustments, amount: commissions + adjustments };
}

/**
 * Pays one person everything that is payable to them, in ONE immediate transaction: the validated, not-held
 * commissions and their unnetted adjustments are summed, marked (`paid` + `payout_id` / `payout_id`) and recorded
 * as one payout with its audit row. Nothing payable, or a total of zero or less (clawbacks exceeding the
 * commissions), answers 409 `nothing_to_pay` and changes nothing. A second call finds nothing left: 409.
 */
export function createPayout(deps: { db: Db; clock: Clock }, actor: PayoutActor, input: PayoutInput): AdminPayoutRow {
  const errors: Record<string, string> = {};
  if (!PAYOUT_METHODS.includes(input.method)) errors.method = 'Choisissez un mode de paiement.';
  const day = algiersDayBounds(input.paidAt);
  if (!day) errors.paidAt = 'Date invalide.';
  const reference = clean(input.reference);
  const note = clean(input.note);
  if (reference !== null && reference.length > 100) errors.reference = 'La référence est trop longue (100 caractères maximum).';
  if (note !== null && note.length > 500) errors.note = 'La note est trop longue (500 caractères maximum).';
  if (!UUID.test(input.beneficiaryUserId)) errors.beneficiaryUserId = 'Bénéficiaire invalide.';
  if (Object.keys(errors).length > 0 || !day) throw validation(errors);

  return deps.db.transaction((tx) => {
    authorisePermission(tx, actor.userId, 'payouts.manage');
    // Nobody pays themselves (decided here, inside the transaction, after the actor is re-authorised).
    if (actor.userId === input.beneficiaryUserId) throw forbidden();
    const now = deps.clock.now();
    if (input.paidAt > algiersDateString(now)) throw validation({ paidAt: 'La date ne peut pas être dans le futur.' });
    const person = tx.get<{ id: string; full_name: string }>('SELECT id, full_name FROM users WHERE id = ?', input.beneficiaryUserId);
    if (!person) throw notFound();

    const commissions = tx.all<{ id: string; amount: number }>(
      "SELECT id, amount FROM commissions WHERE beneficiary_user_id = ? AND status = 'validated' AND on_hold = 0 ORDER BY created_at, id",
      person.id,
    );
    const adjustments = tx.all<{ id: string; amount: number }>('SELECT id, amount FROM commission_adjustments WHERE beneficiary_user_id = ? AND payout_id IS NULL ORDER BY created_at, id', person.id);
    const amount = commissions.reduce((s, c) => s + c.amount, 0) + adjustments.reduce((s, a) => s + a.amount, 0);
    if (commissions.length === 0 || amount <= 0) throw new HttpFailure(409, 'nothing_to_pay');

    const id = newId(deps.clock);
    tx.run(
      `INSERT INTO payouts (id, beneficiary_user_id, amount, method, reference, paid_at, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      person.id,
      amount,
      input.method,
      reference,
      day.start,
      note,
      actor.userId,
      now,
    );
    // Each row is moved only while it is still validated / unnetted: if anything changed under us, undo everything.
    for (const c of commissions) {
      const r = tx.run("UPDATE commissions SET status = 'paid', payout_id = ? WHERE id = ? AND status = 'validated' AND on_hold = 0 AND payout_id IS NULL", id, c.id);
      if (r.changes !== 1) throw new HttpFailure(409, 'nothing_to_pay');
    }
    for (const a of adjustments) {
      const r = tx.run('UPDATE commission_adjustments SET payout_id = ? WHERE id = ? AND payout_id IS NULL', id, a.id);
      if (r.changes !== 1) throw new HttpFailure(409, 'nothing_to_pay');
    }
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'payout.created',
      entityType: 'payout',
      entityId: id,
      after: { beneficiaryUserId: person.id, amount, method: input.method, commissions: commissions.length, adjustments: adjustments.length, paidAt: input.paidAt },
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    return {
      id,
      beneficiary: { userId: person.id, name: person.full_name },
      amount,
      method: input.method,
      reference,
      paidAt: new Date(day.start).toISOString(),
      note,
      createdBy: null,
      createdAt: new Date(now).toISOString(),
      commissionCount: commissions.length,
    };
  }, 'immediate');
}

export interface PayoutFilter {
  beneficiary?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page: number;
}

/** Payouts, newest first, 50 a page. `from`/`to` are Algiers days applied to the payment date (both inclusive). */
export function listPayouts(db: Db, filter: PayoutFilter): { items: AdminPayoutRow[]; total: number } {
  const where: string[] = [];
  const params: Record<string, Scalar> = {};
  if (filter.beneficiary) {
    where.push('p.beneficiary_user_id = :b');
    params.b = filter.beneficiary;
  }
  const from = filter.from === undefined ? undefined : algiersDayBounds(filter.from);
  if (from) {
    where.push('p.paid_at >= :from');
    params.from = from.start;
  }
  const to = filter.to === undefined ? undefined : algiersDayBounds(filter.to);
  if (to) {
    where.push('p.paid_at < :to');
    params.to = to.endExclusive;
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all<{
    id: string; beneficiary_user_id: string; name: string; amount: number; method: string; reference: string | null; paid_at: number; note: string | null;
    created_by_name: string | null; created_at: number; n: number;
  }>(
    `SELECT p.id, p.beneficiary_user_id, u.full_name AS name, p.amount, p.method, p.reference, p.paid_at, p.note, c.full_name AS created_by_name, p.created_at,
            (SELECT count(*) FROM commissions x WHERE x.payout_id = p.id) AS n
     FROM payouts p JOIN users u ON u.id = p.beneficiary_user_id LEFT JOIN users c ON c.id = p.created_by
     ${clause} ORDER BY p.paid_at DESC, p.created_at DESC, p.id DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit: PAYOUTS_PAGE_SIZE, offset: (filter.page - 1) * PAYOUTS_PAGE_SIZE },
  );
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM payouts p ${clause}`, params)?.n ?? 0;
  return {
    items: rows.map((r) => ({
      id: r.id,
      beneficiary: { userId: r.beneficiary_user_id, name: r.name },
      amount: r.amount,
      method: r.method as PayoutMethod,
      reference: r.reference,
      paidAt: new Date(r.paid_at).toISOString(),
      note: r.note,
      createdBy: r.created_by_name,
      createdAt: new Date(r.created_at).toISOString(),
      commissionCount: r.n,
    })),
    total,
  };
}
