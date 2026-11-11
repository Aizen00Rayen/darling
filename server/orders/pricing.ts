import { getWilaya } from '@/data/delivery';
import { getProduct } from '@/data/products';
import type { OrderInput } from '@/lib/order-schema';
import { deliveryFee, orderTotal } from '@/lib/pricing';

export interface PricedOrder {
  productName: string;
  wilayaName: string;
  unitPrice: number;
  deliveryFee: number;
  total: number;
}

export type PriceResult = { ok: true; priced: PricedOrder } | { ok: false; errors: Record<string, string> };

/**
 * The ONLY place an order's amounts are decided: product price from data/products, delivery fee from
 * data/delivery, arithmetic from lib/pricing. Whatever a client sent is never looked at.
 * Not ok when the product, shade or wilaya is unknown or the wilaya has no service for the chosen mode.
 */
export function priceOrder(input: OrderInput): PriceResult {
  const product = getProduct(input.productSlug);
  if (!product) return { ok: false, errors: { productSlug: 'Produit inconnu.' } };
  if (!product.shades.some((s) => s.code === input.shadeCode)) return { ok: false, errors: { shadeCode: 'Choisissez une teinte.' } };
  const wilaya = getWilaya(input.wilayaCode);
  if (!wilaya) return { ok: false, errors: { wilayaCode: 'Choisissez votre wilaya.' } };
  const fee = deliveryFee(input.wilayaCode, input.mode);
  const total = orderTotal({ price: product.price, quantity: input.quantity, wilayaCode: input.wilayaCode, mode: input.mode });
  if (fee === null || total === null) return { ok: false, errors: { mode: 'Livraison indisponible.' } };
  return { ok: true, priced: { productName: product.name, wilayaName: wilaya.name, unitPrice: product.price, deliveryFee: fee, total } };
}
