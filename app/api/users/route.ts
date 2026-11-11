import { z } from 'zod';
import { createUserInput, ROLES, USER_STATUSES } from '@/shared';
import { respond } from '@/server/admin/errors';
import { parseQuery } from '@/server/admin/query';
import { createUser, listUsers } from '@/server/admin/users';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'users.manage' } as const;

const listQuery = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  q: z.string().max(100, 'Recherche trop longue.').optional(),
  page: z
    .string()
    .regex(/^\d{1,6}$/, 'Numéro de page invalide.')
    .transform(Number)
    .pipe(z.number().min(1, 'Numéro de page invalide.').max(100_000, 'Numéro de page invalide.'))
    .default(1),
});

export const GET = withAccess(access, ({ request, ctx }) =>
  respond(() => {
    const query = parseQuery(request, listQuery);
    if (!query.ok) return query.response;
    return json(200, listUsers(ctx.db, query.data));
  }),
);

export const POST = withAccess(access, ({ request, ctx, auth, ip, requestId }) =>
  respond(async () => {
    const body = await parseBody(request, createUserInput);
    if (!body.ok) return body.response;
    return json(201, createUser(ctx, { userId: auth.userId, ip, requestId }, body.data));
  }),
);
