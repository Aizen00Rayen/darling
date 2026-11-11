import { ORDER_NUMBER_PATTERN } from '@/shared/orders';
import type { FieldErrors, OrderInput } from './order-schema';

export type SubmitResult =
  | { kind: 'ok'; /** The order number the server assigned, when it came back in the expected shape. */ number?: string }
  /** The server rejected specific fields. */
  | { kind: 'invalid'; errors: FieldErrors }
  /** Too many orders from this connection or for this number (HTTP 429). */
  | { kind: 'rate_limited' }
  /** No answer within the time limit; the order may or may not have been received. */
  | { kind: 'timeout' }
  /** Network error, server error or an unreadable response. */
  | { kind: 'failed' };

type Options = {
  fetch: typeof fetch;
  timeoutMs: number;
  /** Text typed into the hidden honeypot field (a person never types there). Sent as `website`, only when not empty. */
  honeypot?: string;
  /** Idempotency-Key generator (tests). */
  newKey?: () => string;
};

/**
 * A fresh random UUID (v4 shape). `crypto.randomUUID` only exists in secure contexts (https, localhost), so a page
 * served over plain http falls back to `getRandomValues`, which every browser has.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function submitOrder(order: OrderInput, { fetch, timeoutMs, honeypot, newKey = newIdempotencyKey }: Options): Promise<SubmitResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'fetch',
        // One key per submit attempt: the server makes a repeated key (double click, replay) one order.
        'Idempotency-Key': newKey(),
      },
      body: JSON.stringify(honeypot ? { ...order, website: honeypot } : order),
      signal: controller.signal,
    });
    if (response.status === 429) return { kind: 'rate_limited' };
    const data: { ok?: boolean; errors?: FieldErrors; order?: { number?: unknown } } | null = await response.json();
    if (response.status === 400 && data?.errors && Object.keys(data.errors).length > 0) {
      return { kind: 'invalid', errors: data.errors };
    }
    if (!(response.ok && data?.ok)) return { kind: 'failed' };
    const number = data.order?.number;
    return typeof number === 'string' && ORDER_NUMBER_PATTERN.test(number) ? { kind: 'ok', number } : { kind: 'ok' };
  } catch (error) {
    return error instanceof Error && error.name === 'AbortError' ? { kind: 'timeout' } : { kind: 'failed' };
  } finally {
    clearTimeout(timeout);
  }
}

/** True when some error belongs to a field the form has no place to show. */
export function hasHiddenErrors(errors: FieldErrors, shownFields: readonly (keyof OrderInput)[]): boolean {
  return (Object.keys(errors) as (keyof OrderInput)[]).some((field) => !shownFields.includes(field));
}
