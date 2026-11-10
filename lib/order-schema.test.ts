import { describe, expect, it } from 'vitest';
import { parseOrder, type OrderInput } from './order-schema';

const valid: OrderInput = {
  productSlug: 'wet-kiss',
  shadeCode: '*02',
  quantity: 2,
  fullName: 'Amel B',
  phone: '0612345678',
  wilayaCode: 16,
  commune: 'Hydra',
  mode: 'desk',
};

function expectError(data: unknown, field: keyof OrderInput) {
  const result = parseOrder(data);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(typeof result.errors[field]).toBe('string');
    expect(result.errors[field]).not.toBe('');
  }
}

describe('parseOrder', () => {
  it('accepts a valid desk order unchanged', () => {
    expect(parseOrder(valid)).toEqual({ ok: true, order: valid });
  });

  it('normalises phone numbers typed with spaces', () => {
    expect(parseOrder({ ...valid, phone: '06 12 34 56 78' })).toMatchObject({
      ok: true,
      order: { phone: '0612345678' },
    });
  });

  it('accepts the +213 form', () => {
    expect(parseOrder({ ...valid, phone: '+213612345678' }).ok).toBe(true);
  });

  it.each(['061234567', '0812345678', '+21361234567', 'abc', ''])('rejects phone %j', (phone) => {
    expectError({ ...valid, phone }, 'phone');
  });

  it('uses the live site phone message', () => {
    const result = parseOrder({ ...valid, phone: 'abc' });
    expect(result.ok === false && result.errors.phone).toBe(
      'Saisissez un numéro algérien valide (10 chiffres ou +213).',
    );
  });

  it.each([0, 21, 1.5, '2', null])('rejects quantity %j', (quantity) => {
    expectError({ ...valid, quantity }, 'quantity');
  });

  it('rejects whitespace-only and over-long text', () => {
    expectError({ ...valid, fullName: '   ' }, 'fullName');
    expectError({ ...valid, commune: 'x'.repeat(121) }, 'commune');
  });

  it('trims text fields', () => {
    expect(parseOrder({ ...valid, fullName: '  Amel B  ' })).toMatchObject({ ok: true, order: { fullName: 'Amel B' } });
  });

  it('rejects unknown product, shade and wilaya', () => {
    expectError({ ...valid, productSlug: 'nope' }, 'productSlug');
    expectError({ ...valid, shadeCode: '*09' }, 'shadeCode');
    expectError({ ...valid, wilayaCode: 59 }, 'wilayaCode');
  });

  it('requires an address for home delivery only', () => {
    expectError({ ...valid, mode: 'home' }, 'address');
    expectError({ ...valid, mode: 'home', address: '    ' }, 'address');
    expectError({ ...valid, mode: 'home', address: 'x'.repeat(201) }, 'address');
    expect(parseOrder({ ...valid, mode: 'home', address: '12 rue Didouche' }).ok).toBe(true);
  });

  it('rejects Stop Desk where the wilaya has no desk service', () => {
    expectError({ ...valid, wilayaCode: 37, mode: 'desk' }, 'mode');
    expect(parseOrder({ ...valid, wilayaCode: 37, mode: 'home', address: 'Cité 5 juillet' }).ok).toBe(true);
  });

  it.each([null, 'text', 42, []])('rejects non-object input %j', (data) => {
    expect(parseOrder(data).ok).toBe(false);
  });
});
