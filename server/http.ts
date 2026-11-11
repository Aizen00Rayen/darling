import type { z } from 'zod';

// Small response helpers shared by every route handler. API responses are never cacheable.

export function json(status: number, body: unknown, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function noContent(headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('Cache-Control', 'no-store');
  return new Response(null, { status: 204, headers: h });
}

// --- request bodies --------------------------------------------------------------------------------------


/** Largest JSON body any API route reads. */
export const MAX_BODY_BYTES = 64 * 1024;

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: Response };

/** 400 `{ code: 'validation', errors: { field: message } }` with the first message of each field. */
export function validationFailed(errors: Record<string, string>): Response {
  return json(400, { code: 'validation', errors });
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join('.') || '_';
    if (!(field in errors)) errors[field] = issue.message;
  }
  return errors;
}

/**
 * Reads and validates a JSON body. Call it only AFTER the access decision (withAccess guarantees that):
 * refused callers must never see validation details. Malformed JSON is 400 `bad_request`, an oversized body
 * 413 `payload_too_large`; schema failures are 400 `validation` with one message per field (never the value).
 */
export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  options: { allowEmpty?: boolean } = {},
): Promise<ParsedBody<z.infer<S>>> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: json(413, { code: 'payload_too_large' }) };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json(400, { code: 'bad_request' }) };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, response: json(413, { code: 'payload_too_large' }) };
  }
  let raw: unknown;
  if (options.allowEmpty && text.trim() === '') {
    raw = undefined; // a body-less request is judged by the schema as "no body"
  } else {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, response: json(400, { code: 'bad_request' }) };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: validationFailed(fieldErrors(parsed.error)) };
  return { ok: true, data: parsed.data };
}
