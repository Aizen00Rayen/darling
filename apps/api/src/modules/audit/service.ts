import type { DbExecutor } from '../../db/client';
import { auditLog } from '../../db/schema';

export type AuditEntry = {
  /** Null for actions the system takes by itself. */
  actorUserId: string | null;
  /** Dotted verb such as `user.update`. */
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
  requestId?: string;
};

/**
 * Appends one audit entry. Pass the transaction that makes the change so the entry commits, or
 * rolls back, with it. The table is append-only at the database level.
 */
export async function recordAudit(tx: DbExecutor, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    ip: entry.ip ?? null,
    requestId: entry.requestId ?? null,
  });
}
