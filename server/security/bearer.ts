import { createHash, timingSafeEqual } from 'node:crypto';

// Bearer-token check for machine calls (hPanel cron + curl). Both sides are hashed first so the comparison is
// constant-time whatever the lengths are.

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** The token of an `Authorization: Bearer <token>` header (one token, one space), or null. */
export function bearerTokenOf(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^bearer ([^\s]+)$/i.exec(header);
  return m ? m[1]! : null;
}

export function bearerMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}
