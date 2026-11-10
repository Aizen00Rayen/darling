import { describe, expect, it } from 'vitest';
import { navFor } from './nav';

const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe('navFor', () => {
  it('gives an owner-like super manager every admin entry', () => {
    const nav = navFor('super_manager', ['users.manage', 'audit.read', 'settings.manage']);
    expect(labels(nav)).toEqual(['Tableau de bord', 'Utilisateurs', 'Journal', 'Paramètres', 'Mon compte']);
    expect(nav.map((i) => i.href)).toEqual([
      '/admin',
      '/admin/utilisateurs',
      '/admin/journal',
      '/admin/parametres',
      '/compte/securite',
    ]);
  });

  it('hides entries the super manager has no permission for', () => {
    expect(labels(navFor('super_manager', []))).toEqual(['Tableau de bord', 'Mon compte']);
    expect(labels(navFor('super_manager', ['audit.read']))).toEqual(['Tableau de bord', 'Journal', 'Mon compte']);
  });

  it('gives sub managers and affiliates their dashboard and account only', () => {
    expect(navFor('sub_manager', [])).toEqual([
      { href: '/manager', label: 'Tableau de bord' },
      { href: '/compte/securite', label: 'Mon compte' },
    ]);
    expect(navFor('affiliate', ['users.manage'])).toEqual([
      { href: '/affiliate', label: 'Tableau de bord' },
      { href: '/compte/securite', label: 'Mon compte' },
    ]);
  });

  it('gives no links while 2FA enrolment is pending', () => {
    expect(navFor('super_manager', ['users.manage'], { enrolling: true })).toEqual([]);
  });
});
