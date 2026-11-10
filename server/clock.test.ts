import { describe, expect, it } from 'vitest';
import { fixedClock, systemClock } from './clock';

describe('clock', () => {
  it('systemClock returns the current epoch milliseconds', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
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
