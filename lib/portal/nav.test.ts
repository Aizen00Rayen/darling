import { describe, expect, it } from 'vitest';
import { navFor } from './nav';

const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe('navFor', () => {
  it('gives an owner-like super manager every admin entry', () => {
    const nav = navFor('super_manager', ['users.manage', 'audit.read', 'settings.manage']);
    expect(labels(nav)).toEqual(['Tableau de bord', 'Utilisateurs', 'Journal', 'Paramètres', 'Mon compte']); // no orders.read here
    expect(nav.map((i) => i.href)).toEqual([
      '/admin',
      '/admin/utilisateurs',
      '/admin/journal',
      '/admin/parametres',
      '/compte/securite',
    ]);
  });

  it('shows Commandes after the dashboard to whoever holds orders.read, and only to them', () => {
    expect(labels(navFor('super_manager', ['orders.read']))).toEqual(['Tableau de bord', 'Commandes', 'Mon compte']);
    expect(navFor('super_manager', ['orders.read']).find((i) => i.label === 'Commandes')?.href).toBe('/admin/commandes');
    // orders.write alone gives no list to look at
    expect(labels(navFor('super_manager', ['orders.write']))).toEqual(['Tableau de bord', 'Mon compte']);
    expect(labels(navFor('affiliate', ['orders.read']))).not.toContain('Commandes');
    expect(labels(navFor('sub_manager', ['orders.read']))).not.toContain('Commandes');
  });

  it('shows Influenceuses and Commissions to commissions.manage holders only, between Commandes and Utilisateurs', () => {
    const nav = navFor('super_manager', ['users.manage', 'orders.read', 'commissions.manage']);
    expect(labels(nav)).toEqual(['Tableau de bord', 'Commandes', 'Influenceuses', 'Commissions', 'Utilisateurs', 'Mon compte']);
    expect(nav.find((i) => i.label === 'Influenceuses')?.href).toBe('/admin/influenceuses');
    expect(nav.find((i) => i.label === 'Commissions')?.href).toBe('/admin/commissions');
    expect(labels(navFor('super_manager', ['payouts.manage', 'orders.read']))).not.toContain('Commissions');
    expect(labels(navFor('affiliate', ['commissions.manage']))).toEqual(['Tableau de bord', 'Mon compte']);
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
