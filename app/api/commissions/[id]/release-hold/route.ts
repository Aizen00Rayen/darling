import { respond } from '@/server/admin/errors';
import { releaseHold } from '@/server/commissions/admin';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'commissions.manage' } as const;

/** Releases a held commission (validated at once when its order is already delivered). 409 `not_on_hold` / `commission_closed`. */
export const POST = withAccess<typeof access, { id: string }>(access, ({ ctx, auth, ip, requestId, params }) =>
  respond(() => json(200, releaseHold(ctx, { userId: auth.userId, ip, requestId }, params.id))),
);
