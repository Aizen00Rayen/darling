import { ORDER_STATUSES, normalizePhone, type OrderListItem, type OrderSource, type OrderStats, type OrderStatus } from '@/shared';
import type { Db, Scalar } from '../db/sqlite';
import { algiersDateString, algiersDayBounds } from '../util/algiers';
import { toOrderDto } from './read';
import type { OrderRow } from './types';

export const ORDERS_PAGE_SIZE = 50;

export interface OrderFilter {
  status?: OrderStatus;
  source?: OrderSource;
  /** Algiers calendar days, `YYYY-MM-DD`, both inclusive. */
  from?: string;
  to?: string;
  /** Matches the order number, the customer name or the phone (substring). */
  q?: string;
  page: number;
}

/** `%`, `_` and the escape character itself must match literally in a LIKE pattern. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/**
 * Orders, newest first (creation order breaks ties), 50 a page, plus the total for the same filters.
 * LIKE is case-insensitive for ASCII letters only (accented capitals do not fold).
 */
export function listOrders(db: Db, filter: OrderFilter): { items: OrderListItem[]; total: number } {
  const where: string[] = [];
  const params: Record<string, Scalar> = {};
  if (filter.status) {
    where.push('o.status = :status');
    params.status = filter.status;
  }
  if (filter.source) {
    where.push('o.source = :source');
    params.source = filter.source;
  }
  const from = filter.from === undefined ? undefined : algiersDayBounds(filter.from);
  if (from) {
    where.push('o.created_at >= :from');
    params.from = from.start;
  }
  const to = filter.to === undefined ? undefined : algiersDayBounds(filter.to);
  if (to) {
    where.push('o.created_at < :to');
    params.to = to.endExclusive;
  }
  const term = filter.q?.trim();
  if (term) {
    const alternatives = ["o.number LIKE :q ESCAPE '\\'", "o.customer_name LIKE :q ESCAPE '\\'", "o.phone LIKE :q ESCAPE '\\'"];
    params.q = `%${escapeLike(term)}%`;
    // A phone is also found when typed with spaces, dots or +213 (the column holds the local 0XXXXXXXXX form).
    const compact = term.replace(/[\s.-]+/g, '');
    const normalised = normalizePhone(term);
    if (normalised) {
      alternatives.push('o.phone = :phoneExact');
      params.phoneExact = normalised;
    } else if (/^\+?\d{3,}$/.test(compact)) {
      alternatives.push("o.phone LIKE :phoneLike ESCAPE '\\'");
      params.phoneLike = `%${compact.replace(/^\+213/, '0')}%`;
    }
    where.push(`(${alternatives.join(' OR ')})`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.all<OrderRow>(
    `SELECT o.*, NULL AS created_by_name FROM orders o ${clause} ORDER BY o.created_at DESC, o.seq DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit: ORDERS_PAGE_SIZE, offset: (filter.page - 1) * ORDERS_PAGE_SIZE },
  );
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM orders o ${clause}`, params)?.n ?? 0;
  return {
    items: rows.map((row) => {
      const o = toOrderDto(row);
      return { id: o.id, number: o.number, status: o.status, source: o.source, customerName: o.customerName, phone: o.phone, wilayaName: o.wilayaName, total: o.total, createdAt: o.createdAt };
    }),
    total,
  };
}

/** Counts for the dashboard: per status, created during the Algiers day `nowMs` falls in, and still `new`. */
export function orderStats(db: Db, nowMs: number): OrderStats {
  const byStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
  for (const r of db.all<{ status: string; n: number }>('SELECT status, count(*) AS n FROM orders GROUP BY status')) {
    if ((ORDER_STATUSES as readonly string[]).includes(r.status)) byStatus[r.status as OrderStatus] = r.n;
  }
  const day = algiersDayBounds(algiersDateString(nowMs));
  const today = day ? (db.get<{ n: number }>('SELECT count(*) AS n FROM orders WHERE created_at >= ? AND created_at < ?', day.start, day.endExclusive)?.n ?? 0) : 0;
  return { byStatus, total: ORDER_STATUSES.reduce((sum, s) => sum + byStatus[s], 0), today, toProcess: byStatus.new };
}
