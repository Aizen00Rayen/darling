import type { Db } from '../db/sqlite';
import { forbidden } from '../admin/errors';

/**
 * Re-checks, from the database and inside the caller's transaction, that the actor is an ACTIVE super manager
 * who is an owner or holds `orders.write`. The decision taken when the request arrived may be stale by now
 * (suspension, demotion, a revoked grant): a refused actor gets 403 and nothing is changed.
 */
export function authoriseOrdersWrite(tx: Db, userId: string): void {
  const self = tx.get<{ status: string; role: string; is_owner: number }>('SELECT status, role, is_owner FROM users WHERE id = ?', userId);
  if (!self || self.status !== 'active' || self.role !== 'super_manager') throw forbidden();
  if (self.is_owner === 1) return;
  const grant = tx.get("SELECT 1 AS ok FROM user_permissions WHERE user_id = ? AND permission = 'orders.write'", userId);
  if (!grant) throw forbidden();
}
