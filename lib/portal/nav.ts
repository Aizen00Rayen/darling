import type { NavItem } from '@/ui';
import type { Permission, Role } from '@/shared';
import { homePathFor } from '@/shared';

const ACCOUNT: NavItem = { href: '/compte/securite', label: 'Mon compte' };

const ADMIN_PAGES: { item: NavItem; permission: Permission }[] = [
  { item: { href: '/admin/utilisateurs', label: 'Utilisateurs' }, permission: 'users.manage' },
  { item: { href: '/admin/journal', label: 'Journal' }, permission: 'audit.read' },
  { item: { href: '/admin/parametres', label: 'Paramètres' }, permission: 'settings.manage' },
];

/** Navigation for a role; super manager pages are filtered by permission. No links while enrolling in 2FA. */
export function navFor(role: Role, permissions: readonly Permission[], options: { enrolling?: boolean } = {}): NavItem[] {
  if (options.enrolling) return [];
  const home: NavItem = { href: homePathFor(role), label: 'Tableau de bord' };
  if (role !== 'super_manager') return [home, ACCOUNT];
  return [home, ...ADMIN_PAGES.filter((p) => permissions.includes(p.permission)).map((p) => p.item), ACCOUNT];
}
