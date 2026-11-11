import type { Clock } from '../clock';
import type { Db } from '../db/sqlite';

/** What the order domain needs from the server context. */
export interface OrderDeps {
  db: Db;
  clock: Clock;
}

/** Who acts. Only the id is trusted: authority is re-read inside every transaction. */
export interface OrderActor {
  userId: string;
  ip: string;
  requestId: string;
}

/** The columns of `orders` joined with the creator's name, as read back. */
export interface OrderRow {
  seq: number;
  id: string;
  number: string;
  idempotency_key: string | null;
  status: string;
  source: string;
  customer_name: string;
  phone: string;
  wilaya_code: number;
  wilaya_name: string;
  commune: string;
  address: string | null;
  delivery_mode: string;
  product_slug: string;
  product_name: string;
  shade_code: string;
  quantity: number;
  unit_price: number;
  delivery_fee: number;
  total: number;
  internal_notes: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: number;
  updated_at: number;
  confirmed_at: number | null;
  shipped_at: number | null;
  delivered_at: number | null;
  closed_at: number | null;
  affiliate_user_id: string | null;
  manager_user_id: string | null;
  attribution_click_id: string | null;
  self_referral: number;
}

/** Who an order is attributed to: one influenceuse, her current manager at that moment, the click (when it came through a link). */
export interface Attribution {
  affiliateUserId: string;
  managerUserId: string | null;
  clickId: string | null;
  /** The customer's phone is the influenceuse's (or her manager's): the commissions are created on hold. */
  selfReferral: boolean;
}
