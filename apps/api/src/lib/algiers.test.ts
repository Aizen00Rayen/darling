import { describe, expect, it } from 'vitest';
import { algiersDayBounds } from './algiers';

describe('algiersDayBounds', () => {
  it('maps an Algiers calendar day to UTC bounds (UTC+1, no DST)', () => {
    const bounds = algiersDayBounds('2026-11-10');
    expect(bounds?.start.toISOString()).toBe('2026-11-09T23:00:00.000Z');
    expect(bounds?.endExclusive.toISOString()).toBe('2026-11-10T23:00:00.000Z');
  });

  it('is the same offset in summer', () => {
    expect(algiersDayBounds('2026-07-01')?.start.toISOString()).toBe('2026-06-30T23:00:00.000Z');
  });

  it('crosses month and year ends', () => {
    expect(algiersDayBounds('2026-12-31')?.endExclusive.toISOString()).toBe('2026-12-31T23:00:00.000Z');
    expect(algiersDayBounds('2027-01-01')?.start.toISOString()).toBe('2026-12-31T23:00:00.000Z');
  });

  it('accepts 29 February only in a leap year', () => {
    expect(algiersDayBounds('2028-02-29')).not.toBeNull();
    expect(algiersDayBounds('2026-02-29')).toBeNull();
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-11-00', '2026-4-5', '10/11/2026', '2026-11-10T00:00', ' 2026-11-10', '', 'tomorrow'])(
    'refuses %j',
    (value) => {
      expect(algiersDayBounds(value)).toBeNull();
    },
  );
});
