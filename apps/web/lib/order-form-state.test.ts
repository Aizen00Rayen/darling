import { describe, expect, it } from 'vitest';
import { clampQuantity, deskAvailable, resolveMode, summary, wrapIndex } from './order-form-state';

const norm = (s: string) => s.replace(/\s/g, ' ');

describe('delivery mode rules', () => {
  it('forces home delivery where there is no desk service', () => {
    expect(resolveMode(37, 'desk')).toBe('home');
    expect(resolveMode(37, 'home')).toBe('home');
  });

  it('keeps the chosen mode otherwise', () => {
    expect(resolveMode(16, 'desk')).toBe('desk');
    expect(resolveMode(16, 'home')).toBe('home');
    expect(resolveMode(null, 'desk')).toBe('desk');
  });

  it('reports desk availability, defaulting to available before a wilaya is chosen', () => {
    expect(deskAvailable(37)).toBe(false);
    expect(deskAvailable(16)).toBe(true);
    expect(deskAvailable(null)).toBe(true);
  });
});

describe('steppers', () => {
  it('clamps quantity between 1 and the maximum', () => {
    expect(clampQuantity(0, 20)).toBe(1);
    expect(clampQuantity(21, 20)).toBe(20);
    expect(clampQuantity(7, 20)).toBe(7);
  });

  it('wraps gallery indexes in both directions', () => {
    expect(wrapIndex(-1, 8)).toBe(7);
    expect(wrapIndex(8, 8)).toBe(0);
    expect(wrapIndex(3, 8)).toBe(3);
  });
});

describe('summary', () => {
  it('asks for a wilaya and shows the subtotal until one is chosen', () => {
    const s = summary({ price: 3000, quantity: 1, wilayaCode: null, mode: 'desk' });
    expect(s.delivery).toBe('Choisissez une wilaya');
    expect(norm(s.total)).toBe('3 000 DA');
  });

  it('shows the fee and total once a wilaya is chosen', () => {
    const s = summary({ price: 3000, quantity: 2, wilayaCode: 16, mode: 'home' });
    expect(norm(s.delivery)).toBe('450 DA');
    expect(norm(s.total)).toBe('6 450 DA');
  });
});
