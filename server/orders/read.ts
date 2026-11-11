import { isOrderSource, isOrderStatus, type OrderAttribution, type OrderDto, type OrderHistoryEntry, type OrderDetail } from '@/shared';
import type { Db } from '../db/sqlite';
import { notFound } from '../admin/errors';
import type { OrderRow } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An unknown id and one that is not an id at all look the same, so ids cannot be probed. */
export function assertOrderId(id: string): void {
  if (!UUID.test(id)) throw notFound();
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

export const ORDER_SELECT = `SELECT o.*, u.full_name AS created_by_name
  FROM orders o LEFT JOIN users u ON u.id = o.created_by`;

export function toOrderDto(row: OrderRow): OrderDto {
  if (!isOrderStatus(row.status) || !isOrderSource(row.source)) throw new Error('orders row with an unknown status or source');
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    source: row.source,
    customerName: row.customer_name,
    phone: row.phone,
    wilayaCode: row.wilaya_code,
    wilayaName: row.wilaya_name,
    commune: row.commune,
    address: row.address,
    deliveryMode: row.delivery_mode === 'home' ? 'home' : 'desk',
    productSlug: row.product_slug,
    productName: row.product_name,
    shadeCode: row.shade_code,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    deliveryFee: row.delivery_fee,
    total: row.total,
    internalNotes: row.internal_notes,
    createdBy: row.created_by ? { id: row.created_by, fullName: row.created_by_name ?? '' } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    confirmedAt: isoOrNull(row.confirmed_at),
    shippedAt: isoOrNull(row.shipped_at),
    deliveredAt: isoOrNull(row.delivered_at),
    closedAt: isoOrNull(row.closed_at),
  };
}

export function readOrderRow(db: Db, id: string): OrderRow | undefined {
  return db.get<OrderRow>(`${ORDER_SELECT} WHERE o.id = ?`, id);
}

export function readOrder(db: Db, id: string): OrderDto | null {
  const row = readOrderRow(db, id);
  return row ? toOrderDto(row) : null;
}

interface HistoryRow {
  id: number;
  from_status: string | null;
  to_status: string;
  actor_user_id: string | null;
  actor_name: string | null;
  note: string | null;
  at: number;
}

export function readHistory(db: Db, orderId: string): OrderHistoryEntry[] {
  return db
    .all<HistoryRow>(
      `SELECT h.id, h.from_status, h.to_status, h.actor_user_id, u.full_name AS actor_name, h.note, h.at
       FROM order_status_history h LEFT JOIN users u ON u.id = h.actor_user_id
       WHERE h.order_id = ? ORDER BY h.id ASC`,
      orderId,
    )
    .map((r) => {
      if (!isOrderStatus(r.to_status) || (r.from_status !== null && !isOrderStatus(r.from_status))) throw new Error('history row with an unknown status');
      return {
        id: r.id,
        fromStatus: r.from_status === null ? null : (r.from_status as OrderHistoryEntry['toStatus']),
        toStatus: r.to_status,
        actor: r.actor_user_id ? { id: r.actor_user_id, fullName: r.actor_name ?? '' } : null,
        note: r.note,
        at: iso(r.at),
      };
    });
}

/** Who an order is attributed to (influenceuse, her manager at that moment, self-referral flag), or null. */
export function readAttribution(db: Db, orderId: string): OrderAttribution | null {
  const row = db.get<{ affiliate_user_id: string | null; code: string | null; a_name: string | null; manager_user_id: string | null; m_name: string | null; self_referral: number; attribution_click_id: string | null }>(
    `SELECT o.affiliate_user_id, p.code, a.full_name AS a_name, o.manager_user_id, m.full_name AS m_name, o.self_referral, o.attribution_click_id
     FROM orders o LEFT JOIN affiliate_profiles p ON p.user_id = o.affiliate_user_id LEFT JOIN users a ON a.id = o.affiliate_user_id LEFT JOIN users m ON m.id = o.manager_user_id
     WHERE o.id = ?`,
    orderId,
  );
  if (!row || row.affiliate_user_id === null) return null;
  return {
    affiliate: { userId: row.affiliate_user_id, code: row.code ?? '', name: row.a_name ?? '' },
    manager: row.manager_user_id === null ? null : { userId: row.manager_user_id, name: row.m_name ?? '' },
    selfReferral: row.self_referral === 1,
    viaClick: row.attribution_click_id !== null,
  };
}

/** The order with its status history and attribution, or null. */
export function readDetail(db: Db, id: string): OrderDetail | null {
  const order = readOrder(db, id);
  return order ? { ...order, history: readHistory(db, id), attribution: readAttribution(db, id) } : null;
}

/** One order with its status history; 404 for an unknown or malformed id. */
export function getOrder(db: Db, id: string): OrderDetail {
  assertOrderId(id);
  const detail = readDetail(db, id);
  if (!detail) throw notFound();
  return detail;
}
