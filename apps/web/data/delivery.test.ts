import { describe, expect, it } from 'vitest';
import { getWilaya, wilayas } from './delivery';

describe('delivery data', () => {
  it('lists the 58 wilayas in code order', () => {
    expect(wilayas).toHaveLength(58);
    expect(wilayas.map((w) => w.code)).toEqual(Array.from({ length: 58 }, (_, i) => i + 1));
  });

  it('carries the live home and desk rates', () => {
    expect(getWilaya(16)).toEqual({ code: 16, name: 'Alger', home: 450, desk: 300 });
    expect(getWilaya(1)).toMatchObject({ name: 'Adrar', home: 1650, desk: 850 });
  });

  it('marks wilayas without Stop Desk service as null, never free', () => {
    expect(wilayas.filter((w) => w.desk === null).map((w) => w.name)).toEqual([
      'Tindouf',
      'Bordj Badji Mokhtar',
      'Beni Abbes',
      'In Guezzam',
    ]);
    expect(wilayas.every((w) => w.home > 0 && (w.desk === null || w.desk > 0))).toBe(true);
  });

  it('returns undefined for an unknown code', () => {
    expect(getWilaya(59)).toBeUndefined();
    expect(getWilaya(0)).toBeUndefined();
  });
});
