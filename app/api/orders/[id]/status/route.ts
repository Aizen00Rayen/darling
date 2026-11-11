import { respond } from '@/server/admin/errors';
import { changeStatus } from '@/server/orders/status';
import { statusBody } from '@/server/orders/schemas';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'orders.write' } as const;

/** `{ to, note? }`: 200 with the updated order and its history, 409 `invalid_transition` for a change the machine refuses. */
export const POST = withAccess<typeof access, { id: string }>(access, ({ request, ctx, auth, ip, requestId, params }) =>
  respond(async () => {
    const body = await parseBody(request, statusBody);
    if (!body.ok) return body.response;
    return json(200, changeStatus(ctx, { userId: auth.userId, ip, requestId }, params.id, body.data.to, body.data.note));
  }),
);
