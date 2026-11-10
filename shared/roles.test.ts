import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_LABELS, USER_STATUSES, homePathFor } from './roles';

describe('roles', () => {
  it('lists the three roles and four statuses', () => {
    expect(ROLES).toEqual(['super_manager', 'sub_manager', 'affiliate']);
    expect(USER_STATUSES).toEqual(['invited', 'active', 'suspended', 'deactivated']);
  });

  it('has a French label for every role', () => {
    expect(ROLE_LABELS).toEqual({
      super_manager: 'Super Manager',
      sub_manager: 'Sous-manager',
      affiliate: 'Influenceuse',
    });
  });

  it('maps each role to its home path', () => {
    expect(homePathFor('super_manager')).toBe('/admin');
    expect(homePathFor('sub_manager')).toBe('/manager');
    expect(homePathFor('affiliate')).toBe('/affiliate');
  });
});
