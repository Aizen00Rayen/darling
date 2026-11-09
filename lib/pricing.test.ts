import { describe, expect, it } from 'vitest';
import { deliveryFee, formatMoney, orderTotal } from './pricing';

const norm = (s: string) => s.replace(/\s/g, ' ');

describe('formatMoney', () => {
  it('groups thousands the French way and appends DA', () => {
    expect(norm(formatMoney(3000))).toBe('3 000 DA');
    expect(norm(formatMoney(450))).toBe('450 DA');
  });
});

describe('deliveryFee', () => {
  it('returns the rate for the chosen mode', () => {
    expect(deliveryFee(16, 'home')).toBe(450);
    expect(deliveryFee(16, 'desk')).toBe(300);
    expect(deliveryFee(56, 'home')).toBe(2000);
  });

  it('returns null when the wilaya has no desk service', () => {
    expect(deliveryFee(37, 'desk')).toBeNull();
    expect(deliveryFee(37, 'home')).toBe(1650);
  });

  it('returns null for an unknown wilaya', () => {
    expect(deliveryFee(99, 'home')).toBeNull();
  });
});

describe('orderTotal', () => {
  it('adds one delivery fee to price times quantity', () => {
    expect(orderTotal({ price: 3000, quantity: 1, wilayaCode: 16, mode: 'desk' })).toBe(3300);
    expect(orderTotal({ price: 3000, quantity: 3, wilayaCode: 16, mode: 'home' })).toBe(9450);
  });

  it('returns null when delivery is unavailable', () => {
    expect(orderTotal({ price: 3000, quantity: 1, wilayaCode: 37, mode: 'desk' })).toBeNull();
  });
});
