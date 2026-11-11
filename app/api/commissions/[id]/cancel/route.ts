import { respond } from '@/server/admin/errors';
import { cancelCommission } from '@/server/commissions/admin';
import { cancelBody } from '@/server/commissions/schemas';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'commissions.manage' } as const;

/** `{ reason }`: cancels a pending or validated commission. 409 `commission_paid` / `commission_cancelled`. */
export const POST = withAccess<typeof access, { id: string }>(access, ({ request, ctx, auth, ip, requestId, params }) =>
  respond(async () => {
    const body = await parseBody(request, cancelBody);
    if (!body.ok) return body.response;
    return json(200, cancelCommission(ctx, { userId: auth.userId, ip, requestId }, params.id, body.data.reason));
  }),
);
