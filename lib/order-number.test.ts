import { describe, expect, it } from 'vitest';
import { validOrderNumber } from './order-number';

describe('validOrderNumber', () => {
  it('accepts DL-YY-NNNNNN', () => {
    expect(validOrderNumber('DL-26-000123')).toBe('DL-26-000123');
  });

  it.each([undefined, '', 'DL-26-123', 'dl-26-000123', 'DL-2026-000123', 'DL-26-000123 ', 'DL-26-000123\n', '<script>alert(1)</script>', 'DL-26-000123<b>', ['DL-26-000123'], ['DL-26-000123', 'DL-26-000124'], 'DL-26-00012a'])(
    'rejects %j',
    (value) => {
      expect(validOrderNumber(value as string | string[] | undefined)).toBeNull();
    },
  );
});
