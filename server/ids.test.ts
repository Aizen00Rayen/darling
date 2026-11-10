import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { newId } from './ids';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function timestampOf(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}

describe('newId', () => {
  it('has the UUIDv7 shape (version 7, RFC 4122 variant)', () => {
    for (let i = 0; i < 50; i += 1) expect(newId()).toMatch(UUID_V7);
  });

  it('encodes the clock time in the first 48 bits', () => {
    const clock = fixedClock(1_700_000_123_456);
    expect(timestampOf(newId(clock))).toBe(1_700_000_123_456);
  });

  it('is strictly increasing as a string, even within one millisecond', () => {
    const clock = fixedClock(1_700_000_000_000);
    const ids = Array.from({ length: 20_000 }, () => newId(clock));
    for (let i = 1; i < ids.length; i += 1) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts by time across milliseconds', () => {
    const clock = fixedClock(1_700_000_000_000);
    const a = newId(clock);
    clock.advance(1);
    const b = newId(clock);
    clock.advance(1_000);
    const c = newId(clock);
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  it('stays monotonic if the clock moves backwards', () => {
    const clock = fixedClock(1_700_000_000_000);
    const a = newId(clock);
    clock.set(1_699_999_990_000);
    const b = newId(clock);
    expect(b > a).toBe(true);
  });

  it('is unique and ordered with the default system clock', () => {
    const ids = Array.from({ length: 5_000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
