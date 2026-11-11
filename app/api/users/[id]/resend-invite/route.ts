import { readReason } from '@/server/admin/actions';
import { respond } from '@/server/admin/errors';
import { resendInvite } from '@/server/admin/users';
import { json, noContent, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'users.manage' } as const;

export const POST = withAccess<typeof access, { id: string }>(access, ({ request, ctx, auth, ip, requestId, params }) =>
  respond(async () => {
    const reason = await readReason(request);
    if (!reason.ok) return reason.response;
    const sent = await resendInvite(ctx, { userId: auth.userId, ip, requestId }, params.id, { reason: reason.data });
    // The mail transport refused: the invitation link was renewed but nobody received it.
    if (!sent) return json(502, { code: 'mail_failed' });
    return noContent();
  }),
);
