import { describe, expect, it } from 'vitest';
import { firstName } from './names';

describe('firstName', () => {
  it('returns the first word', () => {
    expect(firstName('Amel Benali')).toBe('Amel');
    expect(firstName('  Sara  ')).toBe('Sara');
    expect(firstName('Madonna')).toBe('Madonna');
  });
});
