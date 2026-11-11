import { getProduct } from '@/data/products';
import type { OrderInput } from '@/lib/order-schema';
import type { OrderDto } from '@/shared';
import { MAX_BODY_BYTES } from '../http';
import { algiersYear2 } from '../util/algiers';
import { priceOrder } from './pricing';

/** What the storefront receives on success: the validated fields, the server's amounts and the order number. */
export function successBody(order: OrderInput, amounts: { unitPrice: number; deliveryFee: number; total: number }, number: string) {
  return { ok: true as const, order: { ...order, unitPrice: amounts.unitPrice, deliveryFee: amounts.deliveryFee, total: amounts.total, number } };
}

export const successFromOrder = (input: OrderInput, order: OrderDto) =>
  successBody(input, { unitPrice: order.unitPrice, deliveryFee: order.deliveryFee, total: order.total }, order.number);

/**
 * What a bot that filled the honeypot gets: the same shape as a real success, and nothing stored. The number is
 * random and unrelated to any real order. If the rest of the body is not even a valid order, a bare success.
 */
export function fakeSuccess(input: OrderInput | null, year: string): ReturnType<typeof successBody> | { ok: true; order: { number: string } } {
  const number = `DL-${year}-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
  if (input) {
    const priced = priceOrder(input);
    if (priced.ok && getProduct(input.productSlug)) return successBody(input, priced.priced, number);
  }
  return { ok: true, order: { number } };
}

/** True for any non-empty value of the honeypot field (whitespace-only text counts as empty). */
export function honeypotFilled(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const value = (body as Record<string, unknown>).website;
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

export type JsonRead = { ok: true; data: unknown } | { ok: false; status: 400 | 413 };

/** Reads a JSON body for the storefront route, whose failure shape is its own (`{ ok: false, errors }`). */
export async function readJson(request: Request): Promise<JsonRead> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, status: 413 };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400 };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { ok: false, status: 413 };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}

export const yearOf = (nowMs: number): string => algiersYear2(nowMs);
