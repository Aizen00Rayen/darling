import type { MovementInput, ShadeLevel, StockMovementDto, StockProduct, StockReason } from '@/shared/stock';
import { ADDING_REASONS, REMOVING_REASONS } from '@/shared/stock';
import { HttpFailure, forbidden, notFound, validation } from '../admin/errors';
import { recordAudit } from '../audit';
import type { Db } from '../db/sqlite';
import { ensureDefaultProduct } from '../products/db';

export interface StockActor {
  userId: string;
  ip: string;
  requestId: string;
}

interface Movement {
  productId: string;
  shadeCode: string;
  delta: number;
  reason: StockReason;
  channel?: string | null;
  orderId?: string | null;
  unitPrice?: number | null;
  note?: string | null;
  actorUserId?: string | null;
  at: number;
}

/** Re-checks, inside the caller's transaction, that the actor is an active super manager who is an owner or holds `stock.write`. */
export function authoriseStockWrite(tx: Db, userId: string): void {
  const self = tx.get<{ status: string; role: string; is_owner: number }>('SELECT status, role, is_owner FROM users WHERE id = ?', userId);
  if (!self || self.status !== 'active' || self.role !== 'super_manager') throw forbidden();
  if (self.is_owner === 1) return;
  const grant = tx.get("SELECT 1 AS ok FROM user_permissions WHERE user_id = ? AND permission = 'stock.write'", userId);
  if (!grant) throw forbidden();
}

/** Appends one ledger row. Does NOT touch products.stock: callers either use `applyMovement` or already changed it. */
export function insertMovement(tx: Db, m: Movement): void {
  tx.run(
    `INSERT INTO stock_movements (product_id, shade_code, delta, reason, channel, order_id, unit_price, note, actor_user_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    m.productId,
    m.shadeCode,
    m.delta,
    m.reason,
    m.channel ?? null,
    m.orderId ?? null,
    m.unitPrice ?? null,
    m.note ?? null,
    m.actorUserId ?? null,
    m.at,
  );
}

/** Appends a ledger row AND moves the cached product total in the same step. */
function applyMovement(tx: Db, m: Movement): void {
  insertMovement(tx, m);
  tx.run('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?', m.delta, m.at, m.productId);
}

function bucketLevel(tx: Db, productId: string, shadeCode: string): number {
  const row = tx.get<{ q: number | null }>('SELECT SUM(delta) AS q FROM stock_movements WHERE product_id = ? AND shade_code = ?', productId, shadeCode);
  return row?.q ?? 0;
}

function productBySlug(tx: Db, slug: string): { id: string; stock: number } | undefined {
  ensureDefaultProduct(tx);
  return tx.get<{ id: string; stock: number }>('SELECT id, stock FROM products WHERE slug = ?', slug);
}

/**
 * Removes stock for an order inside the order's transaction. Takes from the shade's own pool first, then from the
 * unallocated pool. Refuses (409 out_of_stock, rolling the order back) when the product total is not enough.
 * Orders for a slug with no catalogue row are not tracked.
 */
export function consumeForOrder(
  tx: Db,
  o: { orderId: string; productSlug: string; shadeCode: string; quantity: number; reason: 'sale_website' | 'sale_offsite'; channel: string; unitPrice: number; actorUserId: string | null; at: number },
): void {
  const product = productBySlug(tx, o.productSlug);
  if (!product) return;
  if (product.stock < o.quantity) {
    throw new HttpFailure(409, 'out_of_stock', {
      quantity: product.stock > 0 ? `Stock insuffisant : il reste ${product.stock} unité${product.stock > 1 ? 's' : ''}.` : 'Ce produit est épuisé.',
    });
  }
  const own = Math.max(0, Math.min(o.quantity, bucketLevel(tx, product.id, o.shadeCode)));
  const rest = o.quantity - own;
  const base = { productId: product.id, reason: o.reason, channel: o.channel, orderId: o.orderId, unitPrice: o.unitPrice, actorUserId: o.actorUserId, at: o.at };
  if (own > 0) applyMovement(tx, { ...base, shadeCode: o.shadeCode, delta: -own });
  if (rest > 0) {
    // The shade pool could not cover it, so the rest comes from the unallocated pool, which must have it.
    if (bucketLevel(tx, product.id, '') < rest) {
      throw new HttpFailure(409, 'out_of_stock', { quantity: 'Cette teinte est épuisée.' });
    }
    applyMovement(tx, { ...base, shadeCode: '', delta: -rest });
  }
}

/** Puts back whatever an order still holds (cancelled, refused or returned). Idempotent: a settled order nets to zero. */
export function restockForOrder(tx: Db, orderId: string, actorUserId: string | null, at: number): void {
  const rows = tx.all<{ product_id: string; shade_code: string; q: number }>(
    'SELECT product_id, shade_code, SUM(delta) AS q FROM stock_movements WHERE order_id = ? GROUP BY product_id, shade_code HAVING SUM(delta) < 0',
    orderId,
  );
  for (const r of rows) {
    applyMovement(tx, {
      productId: r.product_id,
      shadeCode: r.shade_code,
      delta: -r.q,
      reason: 'return',
      orderId,
      note: 'Commande annulée, refusée ou retournée',
      actorUserId,
      at,
    });
  }
}

/** Records a manual movement (reception, off-site sale, return, damage, correction) in one transaction. */
export function recordManualMovement(db: Db, actor: StockActor, input: MovementInput, now: number): StockProduct {
  return db.transaction((tx) => {
    authoriseStockWrite(tx, actor.userId);
    const product = tx.get<{ id: string; name: string; data: string }>('SELECT id, name, data FROM products WHERE id = ?', input.productId);
    if (!product) throw notFound();

    if (input.shadeCode !== '') {
      let known = false;
      try {
        known = ((JSON.parse(product.data) as { shades?: { code: string }[] }).shades ?? []).some((s) => s.code === input.shadeCode);
      } catch {
        known = false;
      }
      if (!known) throw validation({ shadeCode: 'Teinte inconnue pour ce produit.' });
    }

    const reason = input.reason;
    const sign = REMOVING_REASONS.includes(reason) ? -1 : ADDING_REASONS.includes(reason) ? 1 : input.direction === 'out' ? -1 : 1;
    const delta = sign * input.quantity;
    if (delta < 0 && bucketLevel(tx, product.id, input.shadeCode) + delta < 0) {
      throw validation({ quantity: 'Stock insuffisant dans cette réserve.' });
    }
    applyMovement(tx, {
      productId: product.id,
      shadeCode: input.shadeCode,
      delta,
      reason,
      channel: reason === 'sale_offsite' ? (input.channel ?? null) : null,
      unitPrice: input.unitPrice ?? null,
      note: input.note ? input.note : null,
      actorUserId: actor.userId,
      at: now,
    });
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'stock.movement',
      entityType: 'product',
      entityId: product.id,
      after: { reason, delta, shadeCode: input.shadeCode, ...(input.channel ? { channel: input.channel } : {}) },
      ...(input.note ? { reason: input.note } : {}),
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    const overview = readOverview(tx).find((p) => p.id === product.id);
    if (!overview) throw notFound();
    return overview;
  }, 'immediate');
}

/** Per-product stock with its per-shade breakdown and sales split. */
export function readOverview(db: Db): StockProduct[] {
  ensureDefaultProduct(db);
  const products = db.all<{ id: string; slug: string; name: string; stock: number; low: number; is_active: number; data: string }>(
    'SELECT id, slug, name, stock, low_stock_threshold AS low, is_active, data FROM products ORDER BY is_default DESC, created_at DESC',
  );
  const levels = db.all<{ product_id: string; shade_code: string; q: number }>(
    'SELECT product_id, shade_code, SUM(delta) AS q FROM stock_movements GROUP BY product_id, shade_code',
  );
  const sold = db.all<{ product_id: string; reason: string; q: number }>(
    "SELECT product_id, reason, -SUM(delta) AS q FROM stock_movements WHERE reason IN ('sale_website', 'sale_offsite') OR (reason = 'return' AND order_id IS NOT NULL) GROUP BY product_id, reason",
  );
  return products.map((p) => {
    let codes: string[] = [];
    try {
      codes = ((JSON.parse(p.data) as { shades?: { code: string }[] }).shades ?? []).map((s) => s.code);
    } catch {
      codes = [];
    }
    const byCode = new Map(levels.filter((l) => l.product_id === p.id).map((l) => [l.shade_code, l.q]));
    const shades: ShadeLevel[] = codes.map((c) => ({ shadeCode: c, quantity: byCode.get(c) ?? 0 }));
    shades.push({ shadeCode: '', quantity: byCode.get('') ?? 0 });
    const net = (reason: string) => sold.find((s) => s.product_id === p.id && s.reason === reason)?.q ?? 0;
    const returns = net('return');
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      total: p.stock,
      lowStockThreshold: p.low,
      isActive: p.is_active === 1,
      shades,
      // Returns are netted off the website sales (they come from cancelled website/staff orders).
      soldWebsite: Math.max(0, net('sale_website') + Math.min(0, returns)),
      soldOffsite: net('sale_offsite'),
    };
  });
}

export function listMovements(db: Db, opts: { productId?: string; limit?: number } = {}): StockMovementDto[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = db.all<{
    id: number;
    product_id: string;
    product_name: string;
    shade_code: string;
    delta: number;
    reason: StockReason;
    channel: string | null;
    order_id: string | null;
    unit_price: number | null;
    note: string | null;
    actor_name: string | null;
    at: number;
  }>(
    `SELECT m.id, m.product_id, p.name AS product_name, m.shade_code, m.delta, m.reason, m.channel, m.order_id, m.unit_price, m.note,
            u.full_name AS actor_name, m.at
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.actor_user_id
      WHERE (:pid IS NULL OR m.product_id = :pid)
      ORDER BY m.id DESC LIMIT :limit`,
    { pid: opts.productId ?? null, limit },
  );
  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    productName: r.product_name,
    shadeCode: r.shade_code,
    delta: r.delta,
    reason: r.reason,
    channel: r.channel,
    orderId: r.order_id,
    unitPrice: r.unit_price,
    note: r.note,
    actorName: r.actor_name,
    at: r.at,
  }));
}
