/** Injectable time source: every timestamp in the database is epoch milliseconds (UTC) taken from a Clock. */
export interface Clock {
  now(): number;
}

// Next.js (cacheComponents) wraps Date.now() and, in `next dev`, reports it as an error whenever the portal's
// request-time auth lookup runs inside its prerender-validation pass, although the page is dynamic. In development
// only, read the wall clock through performance.timeOrigin (the sanctioned API for that), which cannot drift
// noticeably in a dev session; production and tests use Date.now() directly.
const devNow = () => Math.floor(performance.timeOrigin + performance.now());
export const systemClock: Clock = { now: process.env.NODE_ENV === 'development' ? devNow : () => Date.now() };

export interface FixedClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/** A clock that only moves when told to (tests). */
export function fixedClock(start = 1_700_000_000_000): FixedClock {
  const check = (n: number) => {
    if (!Number.isFinite(n)) throw new TypeError('clock value must be a finite number');
    return n;
  };
  let current = check(start);
  return {
    now: () => current,
    advance(ms) {
      current += check(ms);
    },
    set(ms) {
      current = check(ms);
    },
  };
}
