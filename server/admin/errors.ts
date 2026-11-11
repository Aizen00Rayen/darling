import { json } from '../http';

/**
 * A refusal a service raises on purpose (404, 403 owner_required, 409 last_owner...). Services throw it from
 * inside a transaction, which rolls the transaction back; routes turn it into the response with `respond`.
 * The message is the code, never data from the request.
 */
export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly errors?: Record<string, string>,
  ) {
    super(code);
    this.name = 'HttpFailure';
  }
}

export const notFound = () => new HttpFailure(404, 'not_found');
export const forbidden = () => new HttpFailure(403, 'forbidden');
export const ownerRequired = () => new HttpFailure(403, 'owner_required');
export const validation = (errors: Record<string, string>) => new HttpFailure(400, 'validation', errors);

/** Runs a handler body; an `HttpFailure` becomes its response, anything else propagates (withAccess logs it as 500). */
export async function respond(run: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpFailure) return json(err.status, err.errors ? { code: err.code, errors: err.errors } : { code: err.code });
    throw err;
  }
}

/** True for a SQLite UNIQUE violation, seen through any wrapping `cause` (both drivers put it in the message). */
export function isUniqueViolation(err: unknown, column?: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const { message, cause } = current as { message?: unknown; cause?: unknown };
    if (typeof message === 'string' && /UNIQUE constraint failed/i.test(message) && (column === undefined || message.includes(column))) return true;
    current = cause;
  }
  return false;
}
