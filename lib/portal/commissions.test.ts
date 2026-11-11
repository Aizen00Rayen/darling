import { describe, expect, it } from 'vitest';
import { algiersToday, commissionKindLabel, commissionStatusLabel, commissionStatusTone, formatSignedMoney, payoutFormErrors, payoutMethodLabel } from './commissions';

describe('commission labels', () => {
  it('labels every status, marks held commissions for staff and falls back for unknown values', () => {
    expect(['pending', 'validated', 'paid', 'cancelled'].map((s) => commissionStatusLabel(s))).toEqual(['En attente', 'Validée', 'Payée', 'Annulée']);
    expect(commissionStatusLabel('pending', true)).toBe('En attente (retenue)');
    expect(commissionStatusLabel('validated', true)).toBe('Validée');
    expect(commissionStatusLabel('constructor')).toBe('constructor');
    expect(commissionStatusTone('paid')).toBe('success');
    expect(commissionStatusTone('toString')).toBe('neutral');
  });
  it('labels kinds and payout methods', () => {
    expect(commissionKindLabel('affiliate')).toBe('Influenceuse');
    expect(commissionKindLabel('manager')).toBe('Sous-manager');
    expect(['cash', 'ccp', 'baridimob', 'bank', 'other'].map(payoutMethodLabel)).toEqual(['Espèces', 'CCP', 'BaridiMob', 'Virement bancaire', 'Autre']);
    expect(payoutMethodLabel('__proto__')).toBe('__proto__');
  });
  it('formats clawbacks with a minus sign', () => {
    expect(formatSignedMoney(-300)).toMatch(/^−300\s?DA$/);
    expect(formatSignedMoney(1200)).toMatch(/^1.200\s?DA$/);
    expect(formatSignedMoney(0)).toMatch(/^0\s?DA$/);
  });
});

describe('algiersToday', () => {
  it('is the Algiers calendar day (UTC+1): 23:30 UTC is already tomorrow', () => {
    expect(algiersToday(new Date('2026-11-11T22:59:59Z'))).toBe('2026-11-11');
    expect(algiersToday(new Date('2026-11-11T23:00:00Z'))).toBe('2026-11-12');
    expect(algiersToday(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });
});

describe('payoutFormErrors', () => {
  const ok = { method: 'ccp', reference: 'x', paidAt: '2026-11-11', note: '' };
  it('accepts a good form', () => expect(payoutFormErrors(ok, '2026-11-11')).toEqual({}));
  it('refuses a missing method, a bad or future date and over-long texts', () => {
    expect(payoutFormErrors({ ...ok, method: '' }, '2026-11-11').method).toBeTruthy();
    expect(payoutFormErrors({ ...ok, paidAt: '' }, '2026-11-11').paidAt).toBe('Date invalide.');
    expect(payoutFormErrors({ ...ok, paidAt: '11/11/2026' }, '2026-11-11').paidAt).toBe('Date invalide.');
    expect(payoutFormErrors({ ...ok, paidAt: '2026-11-12' }, '2026-11-11').paidAt).toMatch(/futur/);
    expect(payoutFormErrors({ ...ok, reference: 'x'.repeat(101) }, '2026-11-11').reference).toBeTruthy();
    expect(payoutFormErrors({ ...ok, note: 'x'.repeat(501) }, '2026-11-11').note).toBeTruthy();
  });
});
