import type { z } from 'zod';
import { fieldErrors, validationFailed } from '../http';

export type ParsedQuery<T> = { ok: true; data: T } | { ok: false; response: Response };

/**
 * Validates the query string of a GET request. A repeated key becomes an array (so `?page=1&page=2` fails the
 * string schemas instead of silently using one of them); unknown keys are ignored. Failures are the usual
 * 400 `validation` with one message per field. Call it only after the access decision (withAccess guarantees it).
 */
export function parseQuery<S extends z.ZodType>(request: Request, schema: S): ParsedQuery<z.infer<S>> {
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const previous = raw[key];
    raw[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: validationFailed(fieldErrors(parsed.error)) };
  return { ok: true, data: parsed.data };
}
