import type { Role } from './roles';

/** The 14 permissions of the master design §4.2, in catalogue order. */
export const PERMISSIONS = [
  'users.manage',
  'orders.read',
  'orders.write',
  'orders.override',
  'clients.merge',
  'catalog.write',
  'stock.write',
  'commissions.manage',
  'payouts.manage',
  'finance.read',
  'expenses.write',
  'reports.export',
  'settings.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  'users.manage': 'Gérer les utilisateurs',
  'orders.read': 'Consulter les commandes et les clients',
  'orders.write': 'Créer et modifier les commandes',
  'orders.override': 'Forcer les statuts et l’attribution des commandes',
  'clients.merge': 'Fusionner les fiches clients',
  'catalog.write': 'Gérer le catalogue et les contenus',
  'stock.write': 'Gérer le stock',
  'commissions.manage': 'Gérer les commissions',
  'payouts.manage': 'Gérer les paiements de commissions',
  'finance.read': 'Consulter les finances',
  'expenses.write': 'Gérer les dépenses',
  'reports.export': 'Exporter les rapports',
  'settings.manage': 'Gérer les paramètres',
  'audit.read': 'Consulter le journal d’audit',
};

/**
 * Permissions a user actually holds. Only Super Managers have permissions:
 * owners hold all of them, the others hold what was granted. Sous-managers
 * and influenceuses have fixed capabilities that permissions cannot widen.
 */
export function effectivePermissions(u: { role: Role; isOwner: boolean; granted: Permission[] }): Permission[] {
  if (u.role !== 'super_manager') return [];
  if (u.isOwner) return [...PERMISSIONS];
  return PERMISSIONS.filter((permission) => u.granted.includes(permission));
}
