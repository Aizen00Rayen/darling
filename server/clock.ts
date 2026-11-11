/** Injectable time source: every timestamp in the database is epoch milliseconds (UTC) taken from a Clock. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

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
