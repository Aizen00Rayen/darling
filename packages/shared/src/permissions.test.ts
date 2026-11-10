import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_LABELS, effectivePermissions } from './permissions';

describe('permissions', () => {
  it('has the 14 permissions in catalogue order', () => {
    expect(PERMISSIONS).toHaveLength(14);
    expect(PERMISSIONS[0]).toBe('users.manage');
    expect(PERMISSIONS[13]).toBe('audit.read');
  });

  it('labels every permission in French', () => {
    expect(Object.keys(PERMISSION_LABELS)).toEqual([...PERMISSIONS]);
    expect(PERMISSION_LABELS['users.manage']).toBe('Gérer les utilisateurs');
    for (const label of Object.values(PERMISSION_LABELS)) expect(label.length).toBeGreaterThan(3);
  });

  it('gives an owner every permission', () => {
    expect(effectivePermissions({ role: 'super_manager', isOwner: true, granted: [] })).toEqual([...PERMISSIONS]);
  });

  it('gives a non-owner super manager only what was granted', () => {
    expect(effectivePermissions({ role: 'super_manager', isOwner: false, granted: ['audit.read'] })).toEqual([
      'audit.read',
    ]);
  });

  it('returns granted permissions in catalogue order without duplicates', () => {
    expect(
      effectivePermissions({
        role: 'super_manager',
        isOwner: false,
        granted: ['audit.read', 'orders.read', 'audit.read'],
      }),
    ).toEqual(['orders.read', 'audit.read']);
  });

  it('never widens other roles, even with grants or the owner flag', () => {
    expect(effectivePermissions({ role: 'sub_manager', isOwner: false, granted: ['audit.read'] })).toEqual([]);
    expect(effectivePermissions({ role: 'affiliate', isOwner: false, granted: ['audit.read'] })).toEqual([]);
    expect(effectivePermissions({ role: 'affiliate', isOwner: true, granted: [] })).toEqual([]);
  });
});
