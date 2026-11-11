import {
  affiliateLink,
  maskCustomerName,
  type AdminAffiliateRow,
  type AdminCommissionRow,
  type CommissionKind,
  type CommissionStatus,
  type CommissionTotals,
  type MaskedOrder,
  type MeAffiliate,
  type MeTeam,
  type OwnTotals,
  type OwnAdjustment,
  type OwnCommission,
  type OwnPayout,
  type PayoutMethod,
  type TeamMember,
} from '@/shared';
import type { Db, Scalar } from '../db/sqlite';
import { notFound } from '../admin/errors';
import { payableOf } from './payouts';

// Read side of affiliation. Two audiences with very different rights:
//   - staff holding commissions.manage / payouts.manage see everyone, but still only a MASKED customer name (that
//     permission does not include orders.read, so it must not reveal phone numbers or addresses);
//   - an influenceuse sees only her own rows, a sous-manager only his team's (orders snapshot their manager, so
//     "his" orders are the ones created while he was her manager). Customers are always "Prénom X.".
// No query here ever selects a phone, an address, internal notes or a customer's full name for those audiences:
// the masked name is computed from `customer_name` and nothing else of the customer leaves the database.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();
const escapeLike = (term: string): string => term.replace(/[\\%_]/g, '\\$&');

export const PAGE_SIZE = 50;
/** Self-service lists show the most recent rows; the totals always cover everything. */
export const RECENT_LIMIT = 100;

export function emptyTotals(): CommissionTotals {
  return { pending: 0, validated: 0, paid: 0, cancelled: 0, onHold: 0 };
}

/** Sums per status, plus the held part of `pending`, for `WHERE <clause>` over `commissions c`. */
export function totalsWhere(db: Db, clause: string, params: Record<string, Scalar>): CommissionTotals {
  const totals = emptyTotals();
  for (const r of db.all<{ status: string; on_hold: number; s: number | null }>(
    `SELECT c.status, c.on_hold, sum(c.amount) AS s FROM commissions c WHERE ${clause} GROUP BY c.status, c.on_hold`,
    params,
  )) {
    const sum = r.s ?? 0;
    if (r.status === 'pending' || r.status === 'validated' || r.status === 'paid' || r.status === 'cancelled') totals[r.status] += sum;
    if (r.status === 'pending' && r.on_hold === 1) totals.onHold += sum;
  }
  return totals;
}

// --- staff ---------------------------------------------------------------------------------------------------

export interface AffiliateFilter {
  q?: string | undefined;
  status?: string | undefined;
  manager?: string | undefined;
  page: number;
}

interface AffiliateDbRow {
  user_id: string;
  code: string;
  name: string;
  status: string;
  manager_user_id: string | null;
  manager_name: string | null;
  clicks: number;
  orders: number;
  delivered: number;
}

const AFFILIATE_SELECT = `
  SELECT p.user_id, p.code, u.full_name AS name, u.status, p.manager_user_id, m.full_name AS manager_name,
         (SELECT count(*) FROM affiliate_clicks k WHERE k.affiliate_user_id = p.user_id) AS clicks,
         (SELECT count(*) FROM orders o WHERE o.affiliate_user_id = p.user_id) AS orders,
         (SELECT count(*) FROM orders o WHERE o.affiliate_user_id = p.user_id AND o.status = 'delivered') AS delivered
  FROM affiliate_profiles p JOIN users u ON u.id = p.user_id LEFT JOIN users m ON m.id = p.manager_user_id`;

function toAffiliateRow(db: Db, r: AffiliateDbRow, origin: string): AdminAffiliateRow {
  return {
    userId: r.user_id,
    code: r.code,
    name: r.name,
    status: r.status,
    manager: r.manager_user_id === null ? null : { userId: r.manager_user_id, name: r.manager_name ?? '' },
    clicks: r.clicks,
    orders: r.orders,
    delivered: r.delivered,
    totals: totalsWhere(db, 'c.beneficiary_user_id = :u', { u: r.user_id }),
    link: affiliateLink(origin, r.code),
  };
}

export function listAffiliates(db: Db, filter: AffiliateFilter, origin: string): { items: AdminAffiliateRow[]; total: number } {
  const where: string[] = [];
  const params: Record<string, Scalar> = {};
  const term = filter.q?.trim();
  if (term) {
    where.push("(u.full_name LIKE :q ESCAPE '\\' OR p.code LIKE :q ESCAPE '\\')");
    params.q = `%${escapeLike(term)}%`;
  }
  if (filter.status) {
    where.push('u.status = :status');
    params.status = filter.status;
  }
  if (filter.manager) {
    where.push('p.manager_user_id = :manager');
    params.manager = filter.manager;
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all<AffiliateDbRow>(`${AFFILIATE_SELECT} ${clause} ORDER BY u.full_name COLLATE NOCASE, p.code LIMIT :limit OFFSET :offset`, {
    ...params,
    limit: PAGE_SIZE,
    offset: (filter.page - 1) * PAGE_SIZE,
  });
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM affiliate_profiles p JOIN users u ON u.id = p.user_id ${clause}`, params)?.n ?? 0;
  return { items: rows.map((r) => toAffiliateRow(db, r, origin)), total };
}

export interface AffiliateDetail {
  affiliate: AdminAffiliateRow;
  /** What a payout to her would be right now. */
  payable: { amount: number; commissions: number; commissionCount: number; adjustments: number };
  unsettledAdjustments: number;
  commissions: AdminCommissionRow[];
  orders: (MaskedOrder & { id: string; source: string; selfReferral: boolean })[];
  clicks: { id: string; at: string; referrerHost: string | null; landingPath: string; converted: boolean }[];
  payouts: { id: string; amount: number; method: PayoutMethod; reference: string | null; paidAt: string }[];
}

export function getAffiliateDetail(db: Db, userId: string, origin: string): AffiliateDetail {
  if (!UUID.test(userId)) throw notFound();
  const row = db.get<AffiliateDbRow>(`${AFFILIATE_SELECT} WHERE p.user_id = ?`, userId);
  if (!row) throw notFound();
  const payable = payableOf(db, userId);
  const orders = db.all<{
    id: string; number: string; created_at: number; status: string; product_name: string; quantity: number; total: number; wilaya_name: string; customer_name: string; source: string; self_referral: number;
  }>(
    `SELECT id, number, created_at, status, product_name, quantity, total, wilaya_name, customer_name, source, self_referral
     FROM orders WHERE affiliate_user_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?`,
    userId,
    RECENT_LIMIT,
  );
  return {
    affiliate: toAffiliateRow(db, row, origin),
    payable: { amount: payable.amount, commissions: payable.commissions, commissionCount: payable.commissionCount, adjustments: payable.adjustments },
    unsettledAdjustments: payable.adjustments,
    commissions: listCommissions(db, { beneficiary: userId, page: 1 }).items,
    orders: orders.map((o) => ({
      id: o.id,
      number: o.number,
      createdAt: iso(o.created_at),
      status: o.status,
      productName: o.product_name,
      quantity: o.quantity,
      total: o.total,
      wilayaName: o.wilaya_name,
      customer: maskCustomerName(o.customer_name),
      source: o.source,
      selfReferral: o.self_referral === 1,
    })),
    clicks: db
      .all<{ id: string; at: number; referrer_host: string | null; landing_path: string; order_id: string | null }>(
        'SELECT id, at, referrer_host, landing_path, order_id FROM affiliate_clicks WHERE affiliate_user_id = ? ORDER BY at DESC LIMIT 50',
        userId,
      )
      .map((k) => ({ id: k.id, at: iso(k.at), referrerHost: k.referrer_host, landingPath: k.landing_path, converted: k.order_id !== null })),
    payouts: db
      .all<{ id: string; amount: number; method: string; reference: string | null; paid_at: number }>('SELECT id, amount, method, reference, paid_at FROM payouts WHERE beneficiary_user_id = ? ORDER BY paid_at DESC, created_at DESC LIMIT 50', userId)
      .map((p) => ({ id: p.id, amount: p.amount, method: p.method as PayoutMethod, reference: p.reference, paidAt: iso(p.paid_at) })),
  };
}

export interface CommissionFilter {
  status?: CommissionStatus | undefined;
  beneficiary?: string | undefined;
  /** A substring of the order number. */
  order?: string | undefined;
  page: number;
}

interface CommissionDbRow {
  id: string; order_id: string; number: string; order_created: number; order_status: string; customer_name: string; beneficiary_user_id: string; b_name: string;
  kind: string; amount: number; status: string; on_hold: number; hold_reason: string | null; validated_at: number | null; cancelled_at: number | null; cancel_reason: string | null; created_at: number;
}

const COMMISSION_SELECT = `SELECT c.id, c.order_id, o.number, o.created_at AS order_created, o.status AS order_status, o.customer_name, c.beneficiary_user_id, u.full_name AS b_name,
    c.kind, c.amount, c.status, c.on_hold, c.hold_reason, c.validated_at, c.cancelled_at, c.cancel_reason, c.created_at
  FROM commissions c JOIN orders o ON o.id = c.order_id JOIN users u ON u.id = c.beneficiary_user_id`;

function toCommissionRow(r: CommissionDbRow): AdminCommissionRow {
  return {
    id: r.id,
    orderId: r.order_id,
    orderNumber: r.number,
    orderDate: iso(r.order_created),
    orderStatus: r.order_status,
    customer: maskCustomerName(r.customer_name),
    beneficiary: { userId: r.beneficiary_user_id, name: r.b_name },
    kind: r.kind as CommissionKind,
    amount: r.amount,
    status: r.status as CommissionStatus,
    onHold: r.on_hold === 1,
    holdReason: r.hold_reason,
    validatedAt: r.validated_at === null ? null : iso(r.validated_at),
    cancelledAt: r.cancelled_at === null ? null : iso(r.cancelled_at),
    cancelReason: r.cancel_reason,
    createdAt: iso(r.created_at),
  };
}

export function listCommissions(db: Db, filter: CommissionFilter): { items: AdminCommissionRow[]; total: number; totals: CommissionTotals } {
  const where: string[] = [];
  const params: Record<string, Scalar> = {};
  if (filter.status) {
    where.push('c.status = :status');
    params.status = filter.status;
  }
  if (filter.beneficiary) {
    where.push('c.beneficiary_user_id = :b');
    params.b = filter.beneficiary;
  }
  const term = filter.order?.trim();
  if (term) {
    where.push("o.number LIKE :n ESCAPE '\\'");
    params.n = `%${escapeLike(term)}%`;
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all<CommissionDbRow>(`${COMMISSION_SELECT} ${clause} ORDER BY c.created_at DESC, c.id DESC LIMIT :limit OFFSET :offset`, {
    ...params,
    limit: PAGE_SIZE,
    offset: (filter.page - 1) * PAGE_SIZE,
  });
  const base = `FROM commissions c JOIN orders o ON o.id = c.order_id ${clause}`;
  const total = db.get<{ n: number }>(`SELECT count(*) AS n ${base}`, params)?.n ?? 0;
  const totals = emptyTotals();
  for (const r of db.all<{ status: string; on_hold: number; s: number | null }>(`SELECT c.status, c.on_hold, sum(c.amount) AS s ${base} GROUP BY c.status, c.on_hold`, params)) {
    const sum = r.s ?? 0;
    if (r.status === 'pending' || r.status === 'validated' || r.status === 'paid' || r.status === 'cancelled') totals[r.status] += sum;
    if (r.status === 'pending' && r.on_hold === 1) totals.onHold += sum;
  }
  return { items: rows.map(toCommissionRow), total, totals };
}

/** Everyone who has something to be paid right now (a `payouts.manage` view): amount = commissions + unnetted adjustments. */
export function listPayable(db: Db): { userId: string; name: string; role: string; commissionCount: number; commissions: number; adjustments: number; amount: number }[] {
  const people = db.all<{ id: string; full_name: string; role: string }>(
    `SELECT DISTINCT u.id, u.full_name, u.role FROM commissions c JOIN users u ON u.id = c.beneficiary_user_id
     WHERE c.status = 'validated' AND c.on_hold = 0 ORDER BY u.full_name COLLATE NOCASE`,
  );
  return people
    .map((p) => ({ userId: p.id, name: p.full_name, role: p.role, ...payableOf(db, p.id) }))
    .map(({ userId, name, role, commissionCount, commissions, adjustments, amount }) => ({ userId, name, role, commissionCount, commissions, adjustments, amount }))
    .filter((p) => p.amount > 0);
}

/** Dashboard numbers: what is payable now and what is still pending (held included). */
export function dashboardTotals(db: Db): { toPay: number; pending: number } {
  const row = db.get<{ to_pay: number | null; pending: number | null }>(
    `SELECT sum(CASE WHEN status = 'validated' AND on_hold = 0 THEN amount END) AS to_pay,
            sum(CASE WHEN status = 'pending' THEN amount END) AS pending
     FROM commissions`,
  );
  return { toPay: row?.to_pay ?? 0, pending: row?.pending ?? 0 };
}

/** What a person who earns commissions may see: the sums per status, never which part of `pending` is held. */
function ownTotals(db: Db, clause: string, params: Record<string, Scalar>): OwnTotals {
  const { pending, validated, paid, cancelled } = totalsWhere(db, clause, params);
  return { pending, validated, paid, cancelled };
}

// --- self-service ---------------------------------------------------------------------------------------------

interface MaskedOrderRow {
  number: string; created_at: number; status: string; product_name: string; quantity: number; total: number; wilaya_name: string; customer_name: string; code?: string | null; a_name?: string | null;
}

const toMasked = (o: MaskedOrderRow): MaskedOrder => ({
  number: o.number,
  createdAt: iso(o.created_at),
  status: o.status,
  productName: o.product_name,
  quantity: o.quantity,
  total: o.total,
  wilayaName: o.wilaya_name,
  customer: maskCustomerName(o.customer_name),
  ...(o.code ? { affiliate: { code: o.code, name: o.a_name ?? '' } } : {}),
});

function ownCommissions(db: Db, where: string, params: Record<string, Scalar>): OwnCommission[] {
  return db
    .all<{ id: string; number: string; created_at: number; kind: string; amount: number; status: string }>(
      `SELECT c.id, o.number, o.created_at, c.kind, c.amount, c.status FROM commissions c JOIN orders o ON o.id = c.order_id
       WHERE ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT ${RECENT_LIMIT}`,
      params,
    )
    .map((c) => ({ id: c.id, orderNumber: c.number, orderDate: iso(c.created_at), kind: c.kind as CommissionKind, amount: c.amount, status: c.status as CommissionStatus }));
}

function ownAdjustments(db: Db, userId: string): { adjustments: OwnAdjustment[]; unsettled: number } {
  const adjustments = db
    .all<{ id: string; amount: number; reason: string; number: string | null; created_at: number; payout_id: string | null }>(
      `SELECT a.id, a.amount, a.reason, o.number, a.created_at, a.payout_id FROM commission_adjustments a LEFT JOIN orders o ON o.id = a.order_id
       WHERE a.beneficiary_user_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ${RECENT_LIMIT}`,
      userId,
    )
    .map((a) => ({ id: a.id, amount: a.amount, reason: a.reason, orderNumber: a.number, createdAt: iso(a.created_at), settled: a.payout_id !== null }));
  const unsettled = db.get<{ s: number | null }>('SELECT sum(amount) AS s FROM commission_adjustments WHERE beneficiary_user_id = ? AND payout_id IS NULL', userId)?.s ?? 0;
  return { adjustments, unsettled };
}

function ownPayouts(db: Db, userId: string): { payouts: OwnPayout[]; paidTotal: number } {
  const payouts = db
    .all<{ id: string; amount: number; method: string; reference: string | null; paid_at: number }>(
      `SELECT id, amount, method, reference, paid_at FROM payouts WHERE beneficiary_user_id = ? ORDER BY paid_at DESC, created_at DESC, id DESC LIMIT ${RECENT_LIMIT}`,
      userId,
    )
    .map((p) => ({ id: p.id, amount: p.amount, method: p.method as PayoutMethod, reference: p.reference, paidAt: iso(p.paid_at) }));
  const paidTotal = db.get<{ s: number | null }>('SELECT sum(amount) AS s FROM payouts WHERE beneficiary_user_id = ?', userId)?.s ?? 0;
  return { payouts, paidTotal };
}

/** An influenceuse's own page. 404 when the user has no affiliate profile. */
export function meAffiliate(db: Db, userId: string, origin: string): MeAffiliate {
  const profile = db.get<{ code: string }>('SELECT code FROM affiliate_profiles WHERE user_id = ?', userId);
  if (!profile) throw notFound();
  const orders = db.all<MaskedOrderRow>(
    `SELECT number, created_at, status, product_name, quantity, total, wilaya_name, customer_name
     FROM orders WHERE affiliate_user_id = ? ORDER BY created_at DESC, seq DESC LIMIT ${RECENT_LIMIT}`,
    userId,
  );
  const counts = db.get<{ n: number; d: number | null }>("SELECT count(*) AS n, sum(status = 'delivered') AS d FROM orders WHERE affiliate_user_id = ?", userId);
  const adj = ownAdjustments(db, userId);
  const paid = ownPayouts(db, userId);
  return {
    code: profile.code,
    link: affiliateLink(origin, profile.code),
    clicks: db.get<{ n: number }>('SELECT count(*) AS n FROM affiliate_clicks WHERE affiliate_user_id = ?', userId)?.n ?? 0,
    orderCount: counts?.n ?? 0,
    deliveredCount: counts?.d ?? 0,
    orders: orders.map(toMasked),
    commissions: ownCommissions(db, 'c.beneficiary_user_id = :u', { u: userId }),
    totals: ownTotals(db, 'c.beneficiary_user_id = :u', { u: userId }),
    unsettledAdjustments: adj.unsettled,
    adjustments: adj.adjustments,
    payouts: paid.payouts,
    paidTotal: paid.paidTotal,
  };
}

/** A sous-manager's team view: HIS affiliates, the orders created under him, and his OWN manager commissions. */
export function meTeam(db: Db, managerId: string): MeTeam {
  const members = db
    .all<{ user_id: string; code: string; name: string; status: string }>(
      `SELECT p.user_id, p.code, u.full_name AS name, u.status FROM affiliate_profiles p JOIN users u ON u.id = p.user_id
       WHERE p.manager_user_id = ? ORDER BY u.full_name COLLATE NOCASE, p.code`,
      managerId,
    )
    .map((m): TeamMember => {
      // Orders and money of a member are only the part created under THIS manager (the order's manager snapshot).
      const counts = db.get<{ n: number; d: number | null }>("SELECT count(*) AS n, sum(status = 'delivered') AS d FROM orders WHERE affiliate_user_id = ? AND manager_user_id = ?", m.user_id, managerId);
      return {
        userId: m.user_id,
        code: m.code,
        name: m.name,
        status: m.status,
        clicks: db.get<{ n: number }>('SELECT count(*) AS n FROM affiliate_clicks WHERE affiliate_user_id = ?', m.user_id)?.n ?? 0,
        orderCount: counts?.n ?? 0,
        deliveredCount: counts?.d ?? 0,
        totals: ownTotals(db, "c.beneficiary_user_id = :a AND c.kind = 'affiliate' AND c.order_id IN (SELECT id FROM orders WHERE manager_user_id = :m)", { a: m.user_id, m: managerId }),
      };
    });
  const orders = db.all<MaskedOrderRow>(
    `SELECT o.number, o.created_at, o.status, o.product_name, o.quantity, o.total, o.wilaya_name, o.customer_name, p.code, a.full_name AS a_name
     FROM orders o LEFT JOIN affiliate_profiles p ON p.user_id = o.affiliate_user_id LEFT JOIN users a ON a.id = o.affiliate_user_id
     WHERE o.manager_user_id = ? ORDER BY o.created_at DESC, o.seq DESC LIMIT ${RECENT_LIMIT}`,
    managerId,
  );
  const orderCount = db.get<{ n: number }>('SELECT count(*) AS n FROM orders WHERE manager_user_id = ?', managerId)?.n ?? 0;
  const adj = ownAdjustments(db, managerId);
  return {
    members,
    orders: orders.map(toMasked),
    orderCount,
    commissions: ownCommissions(db, "c.beneficiary_user_id = :u AND c.kind = 'manager'", { u: managerId }),
    totals: ownTotals(db, "c.beneficiary_user_id = :u AND c.kind = 'manager'", { u: managerId }),
    unsettledAdjustments: adj.unsettled,
    adjustments: adj.adjustments,
    payouts: ownPayouts(db, managerId).payouts,
  };
}

/** Everyone who has ever been owed a commission (for the beneficiary filter), by name. */
export function listBeneficiaries(db: Db): { userId: string; name: string; role: string }[] {
  return db
    .all<{ id: string; full_name: string; role: string }>(
      'SELECT DISTINCT u.id, u.full_name, u.role FROM commissions c JOIN users u ON u.id = c.beneficiary_user_id ORDER BY u.full_name COLLATE NOCASE, u.id',
    )
    .map((r) => ({ userId: r.id, name: r.full_name, role: r.role }));
}
