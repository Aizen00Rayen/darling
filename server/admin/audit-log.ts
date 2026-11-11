import { z } from 'zod';
import { emailSchema } from '@/shared';
import type { Db, Scalar } from '../db/sqlite';
import { algiersDayBounds } from '../util/algiers';

export const AUDIT_PAGE_SIZE = 50;

const DATE_ERROR = 'Date invalide (format AAAA-MM-JJ).';
const PAGE_ERROR = 'Numéro de page invalide.';

/** A `YYYY-MM-DD` calendar day (Algiers) that really exists. */
export const dayParam = z.string().refine((value) => algiersDayBounds(value) !== null, DATE_ERROR);

/** Whole number from 1 to 10 000, digits only (so `1.5`, `-1`, `abc`, `1e3` and `` are refused). */
export const pageParam = z
  .string()
  .regex(/^\d{1,5}$/, PAGE_ERROR)
  .transform(Number)
  .pipe(z.number().min(1, PAGE_ERROR).max(10_000, PAGE_ERROR))
  .default(1);

const windowShape = { from: dayParam.optional(), to: dayParam.optional(), page: pageParam };

export function windowRules(value: { from?: string | undefined; to?: string | undefined }, ctx: z.RefinementCtx) {
  // ISO dates compare correctly as text; both are known to be real dates at this point.
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'La date de fin précède la date de début.' });
  }
}

export const auditQuery = z
  .object({
    entityType: z.string().trim().min(1, 'Type requis.').max(100, 'Type trop long.').optional(),
    actorId: z.guid('Identifiant invalide.').optional(),
    ...windowShape,
  })
  .superRefine(windowRules);

export const loginQuery = z
  .object({
    email: emailSchema.optional(),
    success: z.enum(['true', 'false'], { error: 'Valeur attendue : true ou false.' }).optional(),
    ...windowShape,
  })
  .superRefine(windowRules);

export type AuditQuery = z.infer<typeof auditQuery>;
export type LoginQuery = z.infer<typeof loginQuery>;

/** UTC epoch bounds (from inclusive, to exclusive) of the Algiers calendar days in a validated query. */
function windowOf(query: { from?: string | undefined; to?: string | undefined }): { from?: number; toExclusive?: number } {
  const from = query.from === undefined ? undefined : algiersDayBounds(query.from)?.start;
  const toExclusive = query.to === undefined ? undefined : algiersDayBounds(query.to)?.endExclusive;
  return { ...(from === undefined ? {} : { from }), ...(toExclusive === undefined ? {} : { toExclusive }) };
}

function whereOf(parts: [string, string, Scalar | undefined][]): { clause: string; params: Record<string, Scalar> } {
  const used = parts.filter((p): p is [string, string, Scalar] => p[2] !== undefined);
  return {
    clause: used.length > 0 ? `WHERE ${used.map(([sql]) => sql).join(' AND ')}` : '',
    params: Object.fromEntries(used.map(([, name, value]) => [name, value])),
  };
}

export interface AuditLogItem {
  id: number;
  at: string;
  actor: { id: string; fullName: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface LoginEventItem {
  id: number;
  at: string;
  email: string;
  success: boolean;
  reason: string | null;
  ip: string | null;
}

/** SQL NULL and a JSON null both come back as null; the text is parsed exactly once. */
function parseJson(text: string | null): unknown {
  return text === null ? null : (JSON.parse(text) as unknown);
}

export function listAuditLog(db: Db, query: AuditQuery): { items: AuditLogItem[]; total: number } {
  const w = windowOf(query);
  const { clause, params } = whereOf([
    ['a.entity_type = :entityType', 'entityType', query.entityType],
    ['a.actor_user_id = :actorId', 'actorId', query.actorId],
    ['a.at >= :from', 'from', w.from],
    ['a.at < :toExclusive', 'toExclusive', w.toExclusive],
  ]);
  // audit_log.actor_user_id has no foreign key: a deleted or unknown actor has no users row. ip, user agent and
  // request id are stored for investigations but are not part of what this API returns.
  const rows = db.all<{
    id: number;
    at: number;
    actor_id: string | null;
    actor_name: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    before: string | null;
    after: string | null;
    reason: string | null;
  }>(
    `SELECT a.id, a.at, u.id AS actor_id, u.full_name AS actor_name, a.action, a.entity_type, a.entity_id, a.before, a.after, a.reason
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
     ${clause} ORDER BY a.at DESC, a.id DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit: AUDIT_PAGE_SIZE, offset: (query.page - 1) * AUDIT_PAGE_SIZE },
  );
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM audit_log a ${clause}`, params)?.n ?? 0;
  return {
    items: rows.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      actor: r.actor_id !== null && r.actor_name !== null ? { id: r.actor_id, fullName: r.actor_name } : null,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      before: parseJson(r.before),
      after: parseJson(r.after),
      reason: r.reason,
    })),
    total,
  };
}

export function listLoginEvents(db: Db, query: LoginQuery): { items: LoginEventItem[]; total: number } {
  const w = windowOf(query);
  const { clause, params } = whereOf([
    ['email_tried = :email', 'email', query.email],
    ['success = :success', 'success', query.success === undefined ? undefined : query.success === 'true' ? 1 : 0],
    ['at >= :from', 'from', w.from],
    ['at < :toExclusive', 'toExclusive', w.toExclusive],
  ]);
  const rows = db.all<{ id: number; at: number; email_tried: string; success: number; reason: string | null; ip: string | null }>(
    `SELECT id, at, email_tried, success, reason, ip FROM login_events ${clause} ORDER BY at DESC, id DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit: AUDIT_PAGE_SIZE, offset: (query.page - 1) * AUDIT_PAGE_SIZE },
  );
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM login_events ${clause}`, params)?.n ?? 0;
  return {
    // The user agent is stored for investigations but is not part of what this API returns.
    items: rows.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), email: r.email_tried, success: r.success === 1, reason: r.reason, ip: r.ip })),
    total,
  };
}
