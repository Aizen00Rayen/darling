import { describe, expect, it } from 'vitest';
import { isOwnerOnlySetting, SETTINGS, SETTING_DEFAULTS } from './settings';

describe('settings registry', () => {
  it('validates boolean and string settings', () => {
    expect(SETTINGS['security.require_2fa_super_managers'].safeParse('yes').success).toBe(false);
    expect(SETTINGS['security.require_2fa_super_managers'].safeParse(false).success).toBe(true);
    expect(SETTINGS['company.name'].safeParse('').success).toBe(false);
    expect(SETTINGS['company.name'].safeParse('DARLING*').success).toBe(true);
  });

  it('has defaults that satisfy their own schema', () => {
    expect(SETTING_DEFAULTS).toEqual({
      'security.require_2fa_super_managers': true,
      'company.name': 'DARLING*',
      'commission.affiliate_amount': 300,
      'commission.manager_amount': 200,
      'attribution.window_days': 30,
    });
    for (const key of Object.keys(SETTINGS) as (keyof typeof SETTINGS)[]) expect(SETTINGS[key].safeParse(SETTING_DEFAULTS[key]).success, key).toBe(true);
  });

  it.each(['commission.affiliate_amount', 'commission.manager_amount'] as const)('%s: whole dinars from 0 to 100 000', (key) => {
    for (const ok of [0, 1, 300, 100_000]) expect(SETTINGS[key].safeParse(ok).success, String(ok)).toBe(true);
    for (const bad of [-1, 300.5, 100_001, '300', null, NaN, Infinity, true, undefined]) expect(SETTINGS[key].safeParse(bad).success, String(bad)).toBe(false);
  });

  it('attribution.window_days: whole days from 1 to 365', () => {
    const s = SETTINGS['attribution.window_days'];
    for (const ok of [1, 30, 365]) expect(s.safeParse(ok).success).toBe(true);
    for (const bad of [0, -5, 366, 1.5, '30', null, NaN]) expect(s.safeParse(bad).success, String(bad)).toBe(false);
  });

  it('marks security, commission and attribution keys as owner-only', () => {
    expect(Object.keys(SETTINGS).filter(isOwnerOnlySetting).sort()).toEqual([
      'attribution.window_days',
      'commission.affiliate_amount',
      'commission.manager_amount',
      'security.require_2fa_super_managers',
    ]);
    expect(isOwnerOnlySetting('company.name')).toBe(false);
  });
});
