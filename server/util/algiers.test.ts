import { describe, expect, it } from 'vitest';
import { algiersDayBounds } from './algiers';

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

describe('algiersDayBounds', () => {
  it('maps an Algiers calendar day to UTC epoch bounds (UTC+1, no DST)', () => {
    const b = algiersDayBounds('2026-11-10');
    expect(iso(b?.start)).toBe('2026-11-09T23:00:00.000Z');
    expect(iso(b?.endExclusive)).toBe('2026-11-10T23:00:00.000Z');
  });

  it('is the same offset in summer and across month and year ends', () => {
    expect(iso(algiersDayBounds('2026-07-01')?.start)).toBe('2026-06-30T23:00:00.000Z');
    expect(iso(algiersDayBounds('2026-12-31')?.endExclusive)).toBe('2026-12-31T23:00:00.000Z');
    expect(iso(algiersDayBounds('2027-01-01')?.start)).toBe('2026-12-31T23:00:00.000Z');
  });

  it('every day is exactly 24 hours long (no daylight saving anywhere in the year)', () => {
    for (const day of ['2026-03-29', '2026-03-30', '2026-10-25', '2026-10-26']) {
      const b = algiersDayBounds(day);
      expect((b?.endExclusive ?? 0) - (b?.start ?? 0)).toBe(86_400_000);
    }
  });

  it('accepts 29 February only in leap years (century rules included)', () => {
    expect(algiersDayBounds('2028-02-29')).not.toBeNull();
    expect(algiersDayBounds('2000-02-29')).not.toBeNull();
    expect(algiersDayBounds('2026-02-29')).toBeNull();
    expect(algiersDayBounds('1900-02-29')).toBeNull();
    expect(algiersDayBounds('2100-02-29')).toBeNull();
    expect(iso(algiersDayBounds('2028-02-29')?.endExclusive)).toBe('2028-02-29T23:00:00.000Z');
  });

  it.each([
    '2026-02-30',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-11-00',
    '2026-11-32',
    '2026-4-5',
    '10/11/2026',
    '2026-11-10T00:00',
    ' 2026-11-10',
    '2026-11-10 ',
    '2026-11-10\n',
    '0099-01-01',
    '+2026-11-10',
    '２０２６-11-10',
    '',
    'tomorrow',
  ])('refuses %j', (value) => {
    expect(algiersDayBounds(value)).toBeNull();
  });
});
