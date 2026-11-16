import type { OrderEditInput } from '@/shared/order-edit';
import type { OrderDetail, OrderStatus } from '@/shared';
import { HttpFailure, notFound, validation } from '../admin/errors';
import { recordAudit } from '../audit';
import { applyOrderStatus } from '../commissions/lifecycle';
import { consumeForOrder, restockForOrder } from '../inventory/stock';
import { authoriseOrdersWrite } from './authorise';
import { priceOrder } from './pricing';
import { assertOrderId, readDetail } from './read';
import type { OrderActor, OrderDeps } from './types';

interface Row {
  id: string;
  status: OrderStatus;
  source: string;
  customer_name: string;
  phone: string;
  wilaya_code: number;
  commune: string;
  delivery_mode: 'desk' | 'home';
  address: string | null;
  product_slug: string;
  shade_code: string;
  quantity: number;
  unit_price: number;
  delivery_fee: number;
  created_by: string | null;
}

const OPEN: readonly OrderStatus[] = ['new', 'confirmed', 'shipped', 'delivered'];

function liveRow(tx: OrderDeps['db'], id: string): Row {
  const row = tx.get<Row>('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL', id);
  if (!row) throw notFound();
  return row;
}

/**
 * Staff edit of an order: customer details, delivery, shade, quantity and (optionally) the unit price and delivery fee.
 * Stock follows in the same transaction: the order's old stock is returned and the new quantity taken. Quantity cannot
 * change once commissions exist, because those were computed per item.
 */
export function updateOrder(deps: OrderDeps, actor: OrderActor, id: string, input: OrderEditInput): OrderDetail {
  assertOrderId(id);
  return deps.db.transaction((tx) => {
    authoriseOrdersWrite(tx, actor.userId);
    const row = liveRow(tx, id);
    const mode = input.mode;
    if (mode === 'home' && !input.address) throw validation({ address: 'Adresse requise pour la livraison à domicile.' });

    const priced = priceOrder(
      { productSlug: row.product_slug, shadeCode: input.shadeCode, quantity: input.quantity, fullName: input.customerName, phone: input.phone, wilayaCode: input.wilayaCode, commune: input.commune, mode, ...(input.address ? { address: input.address } : {}) },
      tx,
    );
    if (!priced.ok) throw new HttpFailure(400, 'validation', priced.errors);

    const placeChanged = input.wilayaCode !== row.wilaya_code || mode !== row.delivery_mode;
    const unitPrice = input.unitPrice ?? row.unit_price;
    const fee = input.deliveryFee ?? (placeChanged ? priced.priced.deliveryFee : row.delivery_fee);
    const total = unitPrice * input.quantity + fee;
    const stockChanged = input.quantity !== row.quantity || input.shadeCode !== row.shade_code;

    if (input.quantity !== row.quantity && tx.get('SELECT 1 AS x FROM commissions WHERE order_id = ?', id)) {
      throw validation({ quantity: 'Quantité non modifiable : des commissions ont déjà été calculées pour cette commande.' });
    }

    const now = deps.clock.now();
    tx.run(
      `UPDATE orders SET customer_name = :name, phone = :phone, wilaya_code = :wc, wilaya_name = :wn, commune = :commune, delivery_mode = :mode,
              address = :address, shade_code = :shade, quantity = :qty, unit_price = :price, delivery_fee = :fee, total = :total, updated_at = :now
        WHERE id = :id`,
      { name: input.customerName, phone: input.phone, wc: input.wilayaCode, wn: priced.priced.wilayaName, commune: input.commune, mode, address: mode === 'home' ? (input.address ?? null) : null, shade: input.shadeCode, qty: input.quantity, price: unitPrice, fee, total, now, id },
    );
    if (stockChanged && OPEN.includes(row.status)) {
      restockForOrder(tx, id, actor.userId, now, 'Commande modifiée');
      consumeForOrder(tx, {
        orderId: id,
        productSlug: row.product_slug,
        shadeCode: input.shadeCode,
        quantity: input.quantity,
        reason: row.created_by !== null ? 'sale_offsite' : 'sale_website',
        channel: row.source,
        unitPrice,
        actorUserId: actor.userId,
        at: now,
      });
    }
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'order.edited',
      entityType: 'order',
      entityId: id,
      before: { quantity: row.quantity, shadeCode: row.shade_code, unitPrice: row.unit_price, deliveryFee: row.delivery_fee },
      after: { quantity: input.quantity, shadeCode: input.shadeCode, unitPrice, deliveryFee: fee, total },
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    const detail = readDetail(tx, id);
    if (!detail) throw notFound();
    return detail;
  }, 'immediate');
}

/**
 * Deletes an order from every list and total. Nothing is physically removed (history and audit are append-only):
 * the order is closed (cancelled, or returned when it had been delivered), its stock goes back, its commissions are
 * cancelled or clawed back, and it is marked deleted.
 */
export function deleteOrder(deps: OrderDeps, actor: OrderActor, id: string, reason?: string): void {
  assertOrderId(id);
  deps.db.transaction((tx) => {
    authoriseOrdersWrite(tx, actor.userId);
    const row = liveRow(tx, id);
    const now = deps.clock.now();
    const to: OrderStatus = row.status === 'delivered' ? 'returned' : ['new', 'confirmed', 'shipped'].includes(row.status) ? 'cancelled' : row.status;
    if (to !== row.status) {
      tx.run('UPDATE orders SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?', to, now, now, id);
      tx.run('INSERT INTO order_status_history (order_id, from_status, to_status, actor_user_id, note, at) VALUES (?, ?, ?, ?, ?, ?)', id, row.status, to, actor.userId, 'Commande supprimée', now);
      applyOrderStatus(tx, deps.clock, id, to, { userId: actor.userId, ip: actor.ip, requestId: actor.requestId }, now);
    }
    restockForOrder(tx, id, actor.userId, now);
    tx.run('UPDATE orders SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, id);
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'order.deleted',
      entityType: 'order',
      entityId: id,
      before: { status: row.status },
      ...(reason ? { reason } : {}),
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
  }, 'immediate');
}
