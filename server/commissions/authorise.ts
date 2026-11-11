import type { Permission } from '@/shared';
import type { Db } from '../db/sqlite';
import { forbidden } from '../admin/errors';

/**
 * Re-checks, from the database and inside the caller's transaction, that the actor is an ACTIVE super manager who is
 * an owner or holds `permission`. The decision taken when the request arrived may be stale (suspension, demotion,
 * a revoked grant): a refused actor gets 403 and nothing is changed.
 */
export function authorisePermission(tx: Db, userId: string, permission: Permission): void {
  const self = tx.get<{ status: string; role: string; is_owner: number }>('SELECT status, role, is_owner FROM users WHERE id = ?', userId);
  if (!self || self.status !== 'active' || self.role !== 'super_manager') throw forbidden();
  if (self.is_owner === 1) return;
  if (!tx.get('SELECT 1 AS ok FROM user_permissions WHERE user_id = ? AND permission = ?', userId, permission)) throw forbidden();
}
