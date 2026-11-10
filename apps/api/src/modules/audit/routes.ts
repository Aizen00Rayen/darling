import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { emailSchema } from '@darling/shared';
import type { AppDeps } from '../../app';
import { algiersDayBounds } from '../../lib/algiers';
import { listAuditLog, listLoginEvents } from './service';

const ACCESS = { kind: 'permission', permission: 'audit.read' } as const;

const DATE_ERROR = 'Date invalide (format AAAA-MM-JJ).';

/** A `YYYY-MM-DD` calendar day (Algiers) that really exists. */
const dayParam = z
  .string()
  .refine((value) => algiersDayBounds(value) !== null, DATE_ERROR);

/** Whole number from 1 to 10 000, digits only (so `1.5`, `-1`, `abc`, `1e3` and `` are refused). */
const pageParam = z
  .string()
  .regex(/^\d{1,5}$/, 'Numéro de page invalide.')
  .transform(Number)
  .pipe(z.number().min(1, 'Numéro de page invalide.').max(10_000, 'Numéro de page invalide.'))
  .default(1);

/** The window both logs accept. The route turns it into UTC bounds with `bounds`. */
const windowShape = { from: dayParam.optional(), to: dayParam.optional(), page: pageParam };

function windowRules(value: { from?: string | undefined; to?: string | undefined }, ctx: z.RefinementCtx) {
  // ISO dates compare correctly as text; both are known to be real dates at this point.
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'La date de fin précède la date de début.' });
  }
}

function bounds(query: { from?: string | undefined; to?: string | undefined }) {
  const from = query.from === undefined ? undefined : algiersDayBounds(query.from)?.start;
  const toExclusive = query.to === undefined ? undefined : algiersDayBounds(query.to)?.endExclusive;
  return {
    ...(from === undefined ? {} : { from }),
    ...(toExclusive === undefined ? {} : { toExclusive }),
  };
}

const auditQuery = z
  .object({
    entityType: z.string().trim().min(1, 'Type requis.').max(100, 'Type trop long.').optional(),
    actorId: z.guid('Identifiant invalide.').optional(),
    ...windowShape,
  })
  .superRefine(windowRules);

const loginQuery = z
  .object({
    email: emailSchema.optional(),
    success: z.enum(['true', 'false'], { error: 'Valeur attendue : true ou false.' }).optional(),
    ...windowShape,
  })
  .superRefine(windowRules);

const auditResponse = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      at: z.string(),
      actor: z.object({ id: z.string(), fullName: z.string() }).nullable(),
      action: z.string(),
      entityType: z.string(),
      entityId: z.string(),
      before: z.unknown(),
      after: z.unknown(),
      reason: z.string().nullable(),
    }),
  ),
  total: z.number(),
});

const loginResponse = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      at: z.string(),
      email: z.string(),
      success: z.boolean(),
      reason: z.string().nullable(),
      ip: z.string().nullable(),
    }),
  ),
  total: z.number(),
});

/** The audit log and the login log: read-only, both behind `audit.read`. */
export async function auditRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/audit-log',
    { config: { access: ACCESS }, schema: { querystring: auditQuery, response: { 200: auditResponse } } },
    async (request) => {
      const { entityType, actorId, page } = request.query;
      return listAuditLog(deps.db, {
        page,
        ...(entityType === undefined ? {} : { entityType }),
        ...(actorId === undefined ? {} : { actorId }),
        ...bounds(request.query),
      });
    },
  );

  typed.get(
    '/api/login-events',
    { config: { access: ACCESS }, schema: { querystring: loginQuery, response: { 200: loginResponse } } },
    async (request) => {
      const { email, success, page } = request.query;
      return listLoginEvents(deps.db, {
        page,
        ...(email === undefined ? {} : { email }),
        ...(success === undefined ? {} : { success: success === 'true' }),
        ...bounds(request.query),
      });
    },
  );
}
