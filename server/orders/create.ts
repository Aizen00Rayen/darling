import type { OrderSource } from '@/shared';
import type { OrderDto } from '@/shared';
import type { OrderInput } from '@/lib/order-schema';
import { HttpFailure, isUniqueViolation, validation } from '../admin/errors';
import { recordAudit } from '../audit';
import type { Db } from '../db/sqlite';
import { newId } from '../ids';
import { algiersYear2 } from '../util/algiers';
import { createCommissions } from '../commissions/lifecycle';
import { authoriseOrdersWrite } from './authorise';
import { attributeByCode, resolveAttribution } from './attribution';
import { idempotencyConflict } from './errors';
import { priceOrder } from './pricing';
import { readOrder, readOrderRow, toOrderDto } from './read';
import type { Attribution, OrderDeps } from './types';

export interface CreateOptions {
  source: OrderSource;
  /** Staff member entering the order by hand: re-authorised (orders.write) inside the transaction and audited. */
  createdBy?: string;
  /** A client-chosen key: a second create with the same key returns the first order instead of a new one. */
  idempotencyKey?: string;
  /** Click id from a VERIFIED `dl_ref` cookie (storefront): attributes the order inside the transaction when still valid. */
  refClickId?: string;
  /** Staff only (with `createdBy`): attributes the order to this influenceuse code without a cookie. */
  affiliateCode?: string;
  ip?: string;
  requestId?: string;
}

export interface CreateResult {
  order: OrderDto;
  /** False when the idempotency key had already been used (the existing order is returned). */
  created: boolean;
}

/** The order that was created with this key, if any. */
export function findByIdempotencyKey(db: Db, key: string): OrderDto | null {
  const row = db.get<{ id: string }>('SELECT id FROM orders WHERE idempotency_key = ?', key);
  return row ? readOrder(db, row.id) : null;
}

function replay(tx: Db, key: string, phone: string): CreateResult | null {
  const row = tx.get<{ id: string }>('SELECT id FROM orders WHERE idempotency_key = ?', key);
  if (!row) return null;
  const order = readOrderRow(tx, row.id);
  if (!order) return null;
  // Someone else's key (or a reused one) must never reveal another customer's order.
  if (order.phone !== phone) throw idempotencyConflict();
  return { order: toOrderDto(order), created: false };
}

/**
 * Creates an order in ONE `BEGIN IMMEDIATE` transaction: price (from data/, never from the caller), number,
 * insert, first history row, and for a manual entry the actor's re-authorisation plus the audit row. Writers are
 * serialised, so the next sequence value read here is the one the insert gets; numbers are unique and gapless
 * (a rolled-back transaction gives its number back).
 */
export function createOrder(deps: OrderDeps, input: OrderInput, options: CreateOptions): CreateResult {
  const priced = priceOrder(input, deps.db);
  if (!priced.ok) throw new HttpFailure(400, 'validation', priced.errors);
  const p = priced.priced;
  const key = options.idempotencyKey;

  try {
    return deps.db.transaction((tx) => {
      if (options.createdBy !== undefined) authoriseOrdersWrite(tx, options.createdBy);
      if (key !== undefined) {
        const existing = replay(tx, key, input.phone);
        if (existing) return existing;
      }

      const now = deps.clock.now();
      let attribution: Attribution | null = null;
      let attributedCode: string | undefined;
      if (options.affiliateCode !== undefined && options.createdBy !== undefined) {
        const byCode = attributeByCode(tx, options.affiliateCode, input.phone);
        if (!byCode) throw validation({ affiliateCode: 'Code influenceuse inconnu ou inactif.' });
        attribution = byCode;
        attributedCode = byCode.code;
      } else if (options.refClickId !== undefined) {
        attribution = resolveAttribution(tx, { clickId: options.refClickId, phone: input.phone, now });
      }
      // A cookie attribution makes the order an "affiliate" order; a staff attribution keeps the source staff chose.
      const source: OrderSource = attribution && attribution.clickId !== null ? 'affiliate' : options.source;
      const id = newId(deps.clock);
      const last = tx.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'orders'");
      const seq = (last?.seq ?? 0) + 1;
      const number = `DL-${algiersYear2(now)}-${String(seq).padStart(6, '0')}`;

      tx.run(
        `INSERT INTO orders (seq, id, number, idempotency_key, status, source, customer_name, phone, wilaya_code, wilaya_name, commune, address,
                             delivery_mode, product_slug, product_name, shade_code, quantity, unit_price, delivery_fee, total,
                             created_by, created_at, updated_at, affiliate_user_id, manager_user_id, attribution_click_id, self_referral)
         VALUES (:seq, :id, :number, :key, 'new', :source, :name, :phone, :wilayaCode, :wilayaName, :commune, :address,
                 :mode, :slug, :productName, :shade, :quantity, :unitPrice, :fee, :total, :createdBy, :now, :now,
                 :affiliate, :manager, :click, :selfReferral)`,
        {
          seq,
          id,
          number,
          key: key ?? null,
          source,
          name: input.fullName,
          phone: input.phone,
          wilayaCode: input.wilayaCode,
          wilayaName: p.wilayaName,
          commune: input.commune,
          address: input.mode === 'home' ? (input.address ?? null) : null,
          mode: input.mode,
          slug: input.productSlug,
          productName: p.productName,
          shade: input.shadeCode,
          quantity: input.quantity,
          unitPrice: p.unitPrice,
          fee: p.deliveryFee,
          total: p.total,
          createdBy: options.createdBy ?? null,
          now,
          affiliate: attribution?.affiliateUserId ?? null,
          manager: attribution?.managerUserId ?? null,
          click: attribution?.clickId ?? null,
          selfReferral: attribution?.selfReferral ?? false,
        },
      );
      if (attribution) {
        if (attribution.clickId !== null) tx.run('UPDATE affiliate_clicks SET order_id = ? WHERE id = ? AND order_id IS NULL', id, attribution.clickId);
        // Commissions are created in THIS transaction: an attributed order never exists without them.
        createCommissions(tx, deps.clock, { id, affiliateUserId: attribution.affiliateUserId, managerUserId: attribution.managerUserId, holdReason: attribution.holdReason }, now);
      }
      tx.run('INSERT INTO order_status_history (order_id, from_status, to_status, actor_user_id, note, at) VALUES (?, NULL, ?, ?, NULL, ?)', id, 'new', options.createdBy ?? null, now);
      if (options.createdBy !== undefined) {
        recordAudit(tx, {
          actorUserId: options.createdBy,
          action: 'order.created_manual',
          entityType: 'order',
          entityId: id,
          // No customer data in the audit log: the order itself holds it.
          after: { number, source, total: p.total, ...(attributedCode === undefined ? {} : { affiliateCode: attributedCode, selfReferral: attribution?.selfReferral ?? false }) },
          ...(options.ip === undefined ? {} : { ip: options.ip }),
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
          at: now,
        });
      }
      const order = readOrder(tx, id);
      if (!order) throw new Error('order vanished inside its own transaction');
      return { order, created: true };
    }, 'immediate');
  } catch (err) {
    // Two requests with the same key cannot interleave inside BEGIN IMMEDIATE, but a UNIQUE violation that still
    // slips through (another process on the same file) is the same situation: hand back the winner.
    if (key !== undefined && isUniqueViolation(err, 'idempotency_key')) {
      const existing = replay(deps.db, key, input.phone);
      if (existing) return existing;
    }
    throw err;
  }
}

