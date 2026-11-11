import type { Db } from './db/sqlite';

export interface AuditEntry {
  /** Null for actions the system takes by itself. */
  actorUserId: string | null;
  /** Dotted verb such as `auth.2fa_enabled`. */
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
  requestId?: string;
  /** Epoch milliseconds from the injected clock. */
  at: number;
}

/**
 * Appends one audit entry. Call it with the transaction that makes the change so the entry commits, or
 * rolls back, with it. before/after are stored as JSON text. The table is append-only at the database level.
 * Callers must never put secrets, passwords, tokens or codes in before/after.
 */
export function recordAudit(db: Db, e: AuditEntry): void {
  db.run(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before, after, reason, ip, request_id, at)
     VALUES (:actor, :action, :entityType, :entityId, :before, :after, :reason, :ip, :requestId, :at)`,
    {
      actor: e.actorUserId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      before: e.before === undefined ? null : JSON.stringify(e.before),
      after: e.after === undefined ? null : JSON.stringify(e.after),
      reason: e.reason ?? null,
      ip: e.ip ?? null,
      requestId: e.requestId ?? null,
      at: e.at,
    },
  );
}
