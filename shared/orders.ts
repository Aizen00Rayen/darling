// Order vocabulary shared by the server, the storefront and the portal: statuses, sources, the status machine and
// the shapes the API returns. Everything here is plain data (no imports from server/).

export const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refused', 'returned'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_SOURCES = ['website', 'affiliate', 'instagram', 'whatsapp', 'facebook', 'direct', 'other'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/** Sources a staff member may pick when entering an order by hand (`website` and `affiliate` are automatic). */
export const MANUAL_ORDER_SOURCES = ['instagram', 'whatsapp', 'facebook', 'direct', 'other'] as const satisfies readonly OrderSource[];

/**
 * The status machine, written out. Anything not listed is illegal, including staying on the same status:
 * `new -> confirmed -> shipped -> delivered`, `new | confirmed | shipped -> cancelled`, `shipped -> refused`,
 * `delivered -> returned`. `cancelled`, `refused` and `returned` are final.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'cancelled', 'refused'],
  delivered: ['returned'],
  cancelled: [],
  refused: [],
  returned: [],
};

export const isOrderStatus = (value: unknown): value is OrderStatus =>
  typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);

export const isOrderSource = (value: unknown): value is OrderSource =>
  typeof value === 'string' && (ORDER_SOURCES as readonly string[]).includes(value);

export function nextStatuses(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_TRANSITIONS[from];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** `DL-26-000123`: what the storefront shows and the thank-you page accepts. */
export const ORDER_NUMBER_PATTERN = /^DL-\d{2}-\d{6}$/;

export const INTERNAL_NOTES_MAX = 2000;
export const STATUS_NOTE_MAX = 500;

/** One row of the orders list. */
export interface OrderListItem {
  id: string;
  number: string;
  status: OrderStatus;
  source: OrderSource;
  customerName: string;
  phone: string;
  wilayaName: string;
  total: number;
  /** ISO 8601 (UTC). */
  createdAt: string;
}

export interface OrderDto {
  id: string;
  number: string;
  status: OrderStatus;
  source: OrderSource;
  customerName: string;
  phone: string;
  wilayaCode: number;
  wilayaName: string;
  commune: string;
  address: string | null;
  deliveryMode: 'desk' | 'home';
  productSlug: string;
  productName: string;
  shadeCode: string;
  quantity: number;
  unitPrice: number;
  deliveryFee: number;
  total: number;
  internalNotes: string | null;
  createdBy: { id: string; fullName: string } | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  closedAt: string | null;
}

export interface OrderHistoryEntry {
  id: number;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actor: { id: string; fullName: string } | null;
  note: string | null;
  at: string;
}

export interface OrderDetail extends OrderDto {
  history: OrderHistoryEntry[];
}

export interface OrderStats {
  byStatus: Record<OrderStatus, number>;
  total: number;
  /** Orders created during the current Algiers calendar day. */
  today: number;
  /** Orders still `new`. */
  toProcess: number;
}
