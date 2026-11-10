import { and, count, desc, eq, gte, lt, sql, type AnyColumn } from 'drizzle-orm';
import type { DbExecutor } from '../../db/client';
import { auditLog, loginEvents, users } from '../../db/schema';

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

export const AUDIT_PAGE_SIZE = 50;

/** The filters both logs share: a window of Algiers calendar days (UTC bounds) and a page. */
type Window = { from?: Date; toExclusive?: Date; page: number };

export type AuditLogFilter = Window & { entityType?: string; actorId?: string };
export type LoginEventFilter = Window & { email?: string; success?: boolean };

export type AuditLogItem = {
  id: number;
  at: string;
  actor: { id: string; fullName: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
};

export type LoginEventItem = {
  id: number;
  at: string;
  email: string;
  success: boolean;
  reason: string | null;
  ip: string | null;
};

/**
 * jsonb is selected as text and parsed once here. Selecting the column through drizzle would decode
 * it twice on node-postgres, turning the JSON string "false" into the boolean false and "2026" into
 * the number 2026. SQL NULL and a JSON null both come back as null.
 */
const jsonText = (column: AnyColumn) => sql<string | null>`${column}::text`;

function parseJson(text: string | null): unknown {
  return text === null ? null : (JSON.parse(text) as unknown);
}

export async function listAuditLog(
  db: DbExecutor,
  filter: AuditLogFilter,
): Promise<{ items: AuditLogItem[]; total: number }> {
  const where = and(
    filter.entityType === undefined ? undefined : eq(auditLog.entityType, filter.entityType),
    filter.actorId === undefined ? undefined : eq(auditLog.actorUserId, filter.actorId),
    filter.from === undefined ? undefined : gte(auditLog.at, filter.from),
    filter.toExclusive === undefined ? undefined : lt(auditLog.at, filter.toExclusive),
  );

  const [rows, [counted]] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        // audit_log.actor_user_id has no foreign key: a deleted or unknown actor has no users row.
        actorId: users.id,
        actorName: users.fullName,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        before: jsonText(auditLog.before),
        after: jsonText(auditLog.after),
        reason: auditLog.reason,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(where)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((filter.page - 1) * AUDIT_PAGE_SIZE),
    db.select({ total: count() }).from(auditLog).where(where),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: r.actorId !== null && r.actorName !== null ? { id: r.actorId, fullName: r.actorName } : null,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      before: parseJson(r.before),
      after: parseJson(r.after),
      reason: r.reason,
    })),
    total: counted?.total ?? 0,
  };
}

export async function listLoginEvents(
  db: DbExecutor,
  filter: LoginEventFilter,
): Promise<{ items: LoginEventItem[]; total: number }> {
  const where = and(
    filter.email === undefined ? undefined : eq(loginEvents.emailTried, filter.email),
    filter.success === undefined ? undefined : eq(loginEvents.success, filter.success),
    filter.from === undefined ? undefined : gte(loginEvents.at, filter.from),
    filter.toExclusive === undefined ? undefined : lt(loginEvents.at, filter.toExclusive),
  );

  // The user agent is stored for investigations but is not part of what this API returns.
  const [rows, [counted]] = await Promise.all([
    db
      .select({
        id: loginEvents.id,
        at: loginEvents.at,
        email: loginEvents.emailTried,
        success: loginEvents.success,
        reason: loginEvents.reason,
        ip: loginEvents.ip,
      })
      .from(loginEvents)
      .where(where)
      .orderBy(desc(loginEvents.at), desc(loginEvents.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((filter.page - 1) * AUDIT_PAGE_SIZE),
    db.select({ total: count() }).from(loginEvents).where(where),
  ]);

  return { items: rows.map((r) => ({ ...r, at: r.at.toISOString() })), total: counted?.total ?? 0 };
}
