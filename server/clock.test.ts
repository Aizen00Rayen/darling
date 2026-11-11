import { describe, expect, it } from 'vitest';
import { fixedClock, systemClock } from './clock';

describe('clock', () => {
  it('systemClock returns the current epoch milliseconds', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('systemClock tracks Date.now() within 50 ms and never goes backwards', () => {
    let last = systemClock.now();
    for (let i = 0; i < 10_000; i += 1) {
      const n = systemClock.now();
      expect(n).toBeGreaterThanOrEqual(last);
      expect(Math.abs(n - Date.now())).toBeLessThanOrEqual(50);
      last = n;
    }
  });

  it('systemClock is plain Date.now(): it follows a changed wall clock (no monotonic offset)', () => {
    const real = Date.now;
    try {
      Date.now = () => real() + 3_600_000; // an NTP step or a resume from sleep
      expect(Math.abs(systemClock.now() - (real() + 3_600_000))).toBeLessThanOrEqual(50);
    } finally {
      Date.now = real;
    }
  });

  it('fixedClock stands still until advanced or set', () => {
    const clock = fixedClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });

  it('fixedClock has a default start and rejects non-finite values', () => {
    expect(Number.isInteger(fixedClock().now())).toBe(true);
    expect(() => fixedClock(Number.NaN)).toThrow();
    expect(() => fixedClock(0).advance(Number.POSITIVE_INFINITY)).toThrow();
  });
});
