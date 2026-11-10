import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone';

describe('normalizePhone', () => {
  it('normalises +213 numbers to the local 0 form', () => {
    expect(normalizePhone('+213 6 12 34 56 78')).toBe('0612345678');
    expect(normalizePhone('+213512345678')).toBe('0512345678');
  });

  it('strips whitespace from local numbers', () => {
    expect(normalizePhone('06 12 34 56 78')).toBe('0612345678');
    expect(normalizePhone(' 0712345678 ')).toBe('0712345678');
  });

  it.each(['0812345678', '061234567', '+21361234567', '00213612345678', 'abc', ''])('rejects %j', (value) => {
    expect(normalizePhone(value)).toBeNull();
  });
});
