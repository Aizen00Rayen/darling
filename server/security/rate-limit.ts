import { isIP } from 'node:net';
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
const SWEEP_INTERVAL_MS = 60_000;

export function createRateLimiter(clock: Clock, options: { maxEntries?: number } = {}): RateLimiter {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, Entry>();
  let lastSweep = clock.now();

  // Expired entries are removed in one pass, lazily, at most once per SWEEP_INTERVAL_MS (an O(n) walk that
  // happens once a minute, never per request).
  const sweep = (now: number) => {
    lastSweep = now;
    for (const [k, e] of entries) if (e.resetAt <= now) entries.delete(k);
  };

  return {
    limit(bucket, key, { max, windowMs }) {
      const now = clock.now();
      if (now - lastSweep >= SWEEP_INTERVAL_MS) sweep(now);
      const id = `${bucket}\u0000${key}`;
      let entry = entries.get(id);
      if (!entry || entry.resetAt <= now) {
        entries.delete(id); // re-insert so the table stays ordered by window start
        // Full: drop the oldest entry in O(1) (Map keeps insertion order).
        if (entries.size >= maxEntries) {
          const oldest = entries.keys().next();
          if (!oldest.done) entries.delete(oldest.value);
        }
        entry = { count: 0, resetAt: now + windowMs };
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
  login: { bucket: 'auth.login', max: 5, windowMs: 60_000, scaleUnknown: true },
  /** Invitation lookup + acceptance + password reset: 10 per 15 minutes per client address, together. */
  token: { bucket: 'auth.token', max: 10, windowMs: 15 * 60_000, scaleUnknown: true },
  /** "Forgot password": 5 per 15 minutes per client address. */
  forgot: { bucket: 'auth.forgot', max: 5, windowMs: 15 * 60_000, scaleUnknown: true },
  /** 2FA enable, 2FA disable and password change: 5 a minute per authenticated USER, together. */
  passwordVerify: { bucket: 'auth.password-verify', max: 5, windowMs: 60_000 },
} as const;

/** How many times larger the budget of the shared "unknown" bucket is (see rateLimited). */
export const UNKNOWN_BUDGET_FACTOR = 4;

function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const p = tail[1]!.split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    text = text.slice(0, -tail[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The rate-limit key for a client address: IPv4 as is, IPv4-mapped IPv6 as the IPv4 address, any other IPv6 by
 * its /64 prefix (one subscriber controls a whole /64, so per-address keys would be free to rotate).
 * Other keys (`unknown`, `user:...`) pass through.
 */
export function rateLimitKey(key: string): string {
  if (isIP(key) !== 6) return key;
  const g = expandIpv6(key);
  if (!g) return key;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * Counts one request against a budget; returns the 429 response when it is spent, null otherwise.
 * Trade-off for the unidentifiable client ('unknown': the proxy passes no usable address): all such requests
 * share ONE bucket, so a budget that sets `scaleUnknown` is 4x larger there. An attacker can still exhaust it
 * (denying login for everyone in that state), but not with a handful of requests; the per-account lockout
 * remains the real brute-force defence. The startup/first-request warning (client-ip.ts) tells the owner to fix
 * the proxy headers.
 */
export function rateLimited(
  ctx: { limiter: RateLimiter },
  budget: { bucket: string; max: number; windowMs: number; scaleUnknown?: boolean },
  key: string,
): Response | null {
  const max = budget.scaleUnknown && key === 'unknown' ? budget.max * UNKNOWN_BUDGET_FACTOR : budget.max;
  const r = ctx.limiter.limit(budget.bucket, rateLimitKey(key), { max, windowMs: budget.windowMs });
  return r.ok ? null : tooManyAttemptsResponse(r.retryAfterSeconds);
}
