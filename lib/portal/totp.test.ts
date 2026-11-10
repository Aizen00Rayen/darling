import { describe, expect, it } from 'vitest';
import { groupSecret } from './totp';

describe('groupSecret', () => {
  it('splits a base32 secret into groups of four', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });
  it('keeps a short last group and ignores spaces, case and padding', () => {
    expect(groupSecret('jbsw y3dpe==')).toBe('JBSW Y3DP E');
  });
  it('returns an empty string for an empty secret', () => {
    expect(groupSecret('')).toBe('');
  });
});
