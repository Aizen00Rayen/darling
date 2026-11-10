import { describe, expect, it } from 'vitest';
import { SETTINGS, SETTING_DEFAULTS } from './settings';

describe('settings registry', () => {
  it('validates boolean and string settings', () => {
    expect(SETTINGS['security.require_2fa_super_managers'].safeParse('yes').success).toBe(false);
    expect(SETTINGS['security.require_2fa_super_managers'].safeParse(false).success).toBe(true);
    expect(SETTINGS['company.name'].safeParse('').success).toBe(false);
    expect(SETTINGS['company.name'].safeParse('DARLING*').success).toBe(true);
  });

  it('has defaults that satisfy their own schema', () => {
    expect(SETTING_DEFAULTS).toEqual({ 'security.require_2fa_super_managers': true, 'company.name': 'DARLING*' });
    expect(SETTINGS['security.require_2fa_super_managers'].safeParse(SETTING_DEFAULTS['security.require_2fa_super_managers']).success).toBe(true);
    expect(SETTINGS['company.name'].safeParse(SETTING_DEFAULTS['company.name']).success).toBe(true);
  });
});
