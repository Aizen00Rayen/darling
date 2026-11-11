import type { Clock } from '../clock';
import { json } from '../http';

// In-memory fixed-window rate limiter (spec section 6: one process, so memory is enough; counters reset on
// restart). A "bucket" is a name shared by every route that must draw on the same budget; the key says whose
// budget it is (client address, user id). Memory is bounded: expired entries are pruned and, if a flood of
// distinct keys still fills the table, the oldest entries are dropped.

export interface LimitOptions {
  max: number;
  windowMs: number;
}

export interface LimitResult {
  ok: boolean;
  /** Whole seconds until the window ends; 0 when the request is allowed. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  limit(bucket: string, key: string, options: LimitOptions): LimitResult;
  size(): number;
  reset(): void;
}

interface Entry {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const PRUNE_EVERY = 256;

export function createRateLimiter(clock: Clock, options: { maxEntries?: number } = {}): RateLimiter {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, Entry>();
  let sincePrune = 0;

  const prune = (now: number) => {
    for (const [k, e] of entries) if (e.resetAt <= now) entries.delete(k);
    // Still too many live entries: drop the oldest ones (Map keeps insertion order).
    for (const k of entries.keys()) {
      if (entries.size < maxEntries) break;
      entries.delete(k);
    }
  };

  return {
    limit(bucket, key, { max, windowMs }) {
      const now = clock.now();
      sincePrune += 1;
      if (sincePrune >= PRUNE_EVERY || entries.size >= maxEntries) {
        sincePrune = 0;
        prune(now);
      }
      const id = `${bucket}\u0000${key}`;
      let entry = entries.get(id);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        entries.delete(id); // re-insert so the table stays ordered by window start
        entries.set(id, entry);
      }
      entry.count += 1;
      if (entry.count <= max) return { ok: true, retryAfterSeconds: 0 };
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    },
    size: () => entries.size,
    reset: () => entries.clear(),
  };
}

/** 429 `{ code: 'too_many_attempts' }` with Retry-After. */
export function tooManyAttemptsResponse(retryAfterSeconds: number): Response {
  return json(429, { code: 'too_many_attempts' }, { 'Retry-After': String(retryAfterSeconds) });
}

/** Budgets of the authentication routes (spec section 5.1). One name per budget, shared by every route that draws on it. */
export const LIMITS = {
  /** 5 login attempts a minute per client address. */
  login: { bucket: 'auth.login', max: 5, windowMs: 60_000 },
  /** Invitation lookup + acceptance + password reset: 10 per 15 minutes per client address, together. */
  token: { bucket: 'auth.token', max: 10, windowMs: 15 * 60_000 },
  /** "Forgot password": 5 per 15 minutes per client address. */
  forgot: { bucket: 'auth.forgot', max: 5, windowMs: 15 * 60_000 },
  /** 2FA enable, 2FA disable and password change: 5 a minute per authenticated USER, together. */
  passwordVerify: { bucket: 'auth.password-verify', max: 5, windowMs: 60_000 },
} as const;

/** Counts one request against a budget; returns the 429 response when it is spent, null otherwise. */
export function rateLimited(
  ctx: { limiter: RateLimiter },
  budget: { bucket: string; max: number; windowMs: number },
  key: string,
): Response | null {
  const r = ctx.limiter.limit(budget.bucket, key, { max: budget.max, windowMs: budget.windowMs });
  return r.ok ? null : tooManyAttemptsResponse(r.retryAfterSeconds);
}
