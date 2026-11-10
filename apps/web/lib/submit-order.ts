import type { FieldErrors, OrderInput } from './order-schema';

export type SubmitResult =
  | { kind: 'ok' }
  /** The server rejected specific fields. */
  | { kind: 'invalid'; errors: FieldErrors }
  /** No answer within the time limit; the order may or may not have been received. */
  | { kind: 'timeout' }
  /** Network error, server error or an unreadable response. */
  | { kind: 'failed' };

type Options = { fetch: typeof fetch; timeoutMs: number };

export async function submitOrder(order: OrderInput, { fetch, timeoutMs }: Options): Promise<SubmitResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(order),
      signal: controller.signal,
    });
    const data: { ok?: boolean; errors?: FieldErrors } | null = await response.json();
    if (response.status === 400 && data?.errors && Object.keys(data.errors).length > 0) {
      return { kind: 'invalid', errors: data.errors };
    }
    return response.ok && data?.ok ? { kind: 'ok' } : { kind: 'failed' };
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
