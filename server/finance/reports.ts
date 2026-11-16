import type { BreakdownRow, DayPoint, MoneyBlock, MonthReport } from '@/shared/finance';
import type { Db } from '../db/sqlite';
import { algiersDateString, algiersDayBounds } from '../util/algiers';

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const empty = (): MoneyBlock => ({ count: 0, sales: 0, cost: 0, margin: 0, commissions: 0, profit: 0 });

/** [start, end) of an Algiers calendar month, in epoch ms, or null for a malformed month. */
export function monthBounds(month: string): { start: number; end: number } | null {
  if (!MONTH_PATTERN.test(month)) return null;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const a = algiersDayBounds(`${month}-01`);
  const b = algiersDayBounds(`${next}-01`);
  return a && b ? { start: a.start, end: b.start } : null;
}

export interface OrderLine {
  id: string;
  number: string;
  createdAt: number;
  status: string;
  source: string;
  customerName: string;
  phone: string;
  wilayaName: string;
  productName: string;
  shadeCode: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  deliveryFee: number;
  total: number;
  commissions: number;
}

/** Orders created in the month (deleted ones excluded) with their live commission total. */
export function monthOrders(db: Db, month: string): OrderLine[] {
  const b = monthBounds(month);
  if (!b) return [];
  return db
    .all<{
      id: string; number: string; created_at: number; status: string; source: string; customer_name: string; phone: string; wilaya_name: string;
      product_name: string; shade_code: string; quantity: number; unit_price: number; unit_cost: number; delivery_fee: number; total: number; com: number;
    }>(
      `SELECT o.id, o.number, o.created_at, o.status, o.source, o.customer_name, o.phone, o.wilaya_name, o.product_name, o.shade_code, o.quantity,
              o.unit_price, o.unit_cost, o.delivery_fee, o.total,
              COALESCE((SELECT SUM(c.amount) FROM commissions c WHERE c.order_id = o.id AND c.status <> 'cancelled'), 0) AS com
         FROM orders o WHERE o.deleted_at IS NULL AND o.created_at >= ? AND o.created_at < ? ORDER BY o.created_at, o.seq`,
      b.start,
      b.end,
    )
    .map((r) => ({
      id: r.id, number: r.number, createdAt: r.created_at, status: r.status, source: r.source, customerName: r.customer_name, phone: r.phone,
      wilayaName: r.wilaya_name, productName: r.product_name, shadeCode: r.shade_code, quantity: r.quantity, unitPrice: r.unit_price,
      unitCost: r.unit_cost, deliveryFee: r.delivery_fee, total: r.total, commissions: r.com,
    }));
}

export interface OffsiteSale {
  id: number;
  at: number;
  productName: string;
  shadeCode: string;
  channel: string | null;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  note: string | null;
}

/** Off-site sales (recorded in the stock ledger without an order) in the month. */
export function monthOffsiteSales(db: Db, month: string): OffsiteSale[] {
  const b = monthBounds(month);
  if (!b) return [];
  return db
    .all<{ id: number; at: number; name: string; shade_code: string; channel: string | null; delta: number; unit_price: number | null; price: number; cost: number; unit_cost: number | null; note: string | null }>(
      `SELECT m.id, m.at, p.name, m.shade_code, m.channel, m.delta, m.unit_price, p.price, p.cost_price AS cost, NULLIF(m.unit_cost, 0) AS unit_cost, m.note
         FROM stock_movements m JOIN products p ON p.id = m.product_id
        WHERE m.reason = 'sale_offsite' AND m.order_id IS NULL AND m.at >= ? AND m.at < ? ORDER BY m.at, m.id`,
      b.start,
      b.end,
    )
    .map((r) => ({ id: r.id, at: r.at, productName: r.name, shadeCode: r.shade_code, channel: r.channel, quantity: -r.delta, unitPrice: r.unit_price ?? r.price, unitCost: r.unit_cost ?? r.cost, note: r.note }));
}

const SOURCE_LABELS: Record<string, string> = {
  website: 'Site web', affiliate: 'Influenceuses', instagram: 'Instagram', whatsapp: 'WhatsApp', facebook: 'Facebook', direct: 'Direct', other: 'Autre',
};

function add(map: Map<string, BreakdownRow>, key: string, label: string, sales: number, profit: number) {
  const row = map.get(key) ?? { key, label, count: 0, sales: 0, profit: 0 };
  row.count += 1;
  row.sales += sales;
  row.profit += profit;
  map.set(key, row);
}

/** The month's figures. Profit = product sales - real cost - commissions; delivery fees are not counted as income. */
export function monthReport(db: Db, month: string): MonthReport {
  const realised = empty();
  const pipeline = empty();
  const lost = { count: 0, sales: 0 };
  const source = new Map<string, BreakdownRow>();
  const product = new Map<string, BreakdownRow>();
  const wilaya = new Map<string, BreakdownRow>();
  const daily = new Map<string, DayPoint>();
  const orders = monthOrders(db, month);
  let delivered = 0;

  for (const o of orders) {
    const sales = o.unitPrice * o.quantity;
    const cost = o.unitCost * o.quantity;
    const margin = sales - cost;
    const profit = margin - o.commissions;
    if (o.status === 'cancelled' || o.status === 'refused' || o.status === 'returned') {
      lost.count += 1;
      lost.sales += sales;
      continue;
    }
    if (o.status === 'delivered') delivered += 1;
    const block = o.status === 'delivered' ? realised : pipeline;
    block.count += 1;
    block.sales += sales;
    block.cost += cost;
    block.margin += margin;
    block.commissions += o.commissions;
    block.profit += profit;
    add(source, o.source, SOURCE_LABELS[o.source] ?? o.source, sales, profit);
    add(product, o.productName, o.productName, sales, profit);
    add(wilaya, o.wilayaName, o.wilayaName, sales, profit);
    const day = algiersDateString(o.createdAt);
    const d = daily.get(day) ?? { date: day, orders: 0, sales: 0, profit: 0 };
    d.orders += 1;
    d.sales += sales;
    d.profit += profit;
    daily.set(day, d);
  }

  const offsite = { units: 0, sales: 0, cost: 0 };
  for (const s of monthOffsiteSales(db, month)) {
    const sales = s.unitPrice * s.quantity;
    const cost = s.unitCost * s.quantity;
    offsite.units += s.quantity;
    offsite.sales += sales;
    offsite.cost += cost;
    realised.count += 1;
    realised.sales += sales;
    realised.cost += cost;
    realised.margin += sales - cost;
    realised.profit += sales - cost;
    add(source, `offsite:${s.channel ?? 'other'}`, `Hors site · ${SOURCE_LABELS[s.channel ?? 'other'] ?? 'Autre'}`, sales, sales - cost);
    add(product, s.productName, s.productName, sales, sales - cost);
    const day = algiersDateString(s.at);
    const d = daily.get(day) ?? { date: day, orders: 0, sales: 0, profit: 0 };
    d.orders += 1;
    d.sales += sales;
    d.profit += sales - cost;
    daily.set(day, d);
  }

  const closed = delivered + lost.count;
  const live = realised.count + pipeline.count;
  const rank = (m: Map<string, BreakdownRow>, n?: number) => [...m.values()].sort((a, b) => b.profit - a.profit || b.sales - a.sales).slice(0, n ?? 50);
  return {
    month,
    realised,
    pipeline,
    lost,
    offsite,
    orders: orders.length,
    deliveryRate: closed > 0 ? Math.round((delivered / closed) * 100) : null,
    averageBasket: live > 0 ? Math.round((realised.sales + pipeline.sales) / live) : 0,
    bySource: rank(source),
    byProduct: rank(product),
    byWilaya: rank(wilaya, 6),
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** A cell safe for spreadsheets: text starting with = + - @ is prefixed so it cannot run as a formula; quotes and separators are escaped. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const fmtDate = (ms: number) => algiersDateString(ms);

/** The month's orders and off-site sales as CSV (semicolon separated, UTF-8 BOM: opens correctly in Excel in French locale). */
export function ordersCsv(db: Db, month: string): string {
  const head = ['Numéro', 'Date', 'Statut', 'Canal', 'Client', 'Téléphone', 'Wilaya', 'Produit', 'Teinte', 'Quantité', 'Prix unitaire', 'Coût unitaire', 'Livraison', 'Total client', 'Ventes produit', 'Coût total', 'Marge', 'Commissions', 'Profit net'];
  const rows: (string | number)[][] = [];
  for (const o of monthOrders(db, month)) {
    const sales = o.unitPrice * o.quantity;
    const cost = o.unitCost * o.quantity;
    const lost = o.status === 'cancelled' || o.status === 'refused' || o.status === 'returned';
    rows.push([o.number, fmtDate(o.createdAt), o.status, SOURCE_LABELS[o.source] ?? o.source, o.customerName, o.phone, o.wilayaName, o.productName, o.shadeCode, o.quantity, o.unitPrice, o.unitCost, o.deliveryFee, o.total, sales, cost, lost ? 0 : sales - cost, o.commissions, lost ? 0 : sales - cost - o.commissions]);
  }
  for (const s of monthOffsiteSales(db, month)) {
    const sales = s.unitPrice * s.quantity;
    const cost = s.unitCost * s.quantity;
    rows.push([`HORS-SITE-${s.id}`, fmtDate(s.at), 'delivered', `Hors site · ${SOURCE_LABELS[s.channel ?? 'other'] ?? 'Autre'}`, s.note ?? '', '', '', s.productName, s.shadeCode, s.quantity, s.unitPrice, s.unitCost, 0, sales, sales, cost, sales - cost, 0, sales - cost]);
  }
  return `﻿${[head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

/** Day by day totals of the month as CSV. */
export function dailyCsv(db: Db, month: string): string {
  const r = monthReport(db, month);
  const head = ['Date', 'Commandes / ventes', 'Ventes produit', 'Profit'];
  const rows = r.daily.map((d) => [d.date, d.orders, d.sales, d.profit]);
  rows.push(['TOTAL', r.realised.count + r.pipeline.count, r.realised.sales + r.pipeline.sales, r.realised.profit + r.pipeline.profit]);
  return `﻿${[head, ...rows].map((x) => x.map(csvCell).join(';')).join('\r\n')}\r\n`;
}
