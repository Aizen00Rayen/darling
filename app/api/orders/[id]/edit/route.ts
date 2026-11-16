import { respond } from '@/server/admin/errors';
import { updateOrder } from '@/server/orders/manage';
import { json, parseBody, withAccess } from '@/server/security/access';
import { orderEditSchema } from '@/shared/order-edit';

export const access = { kind: 'permission', permission: 'orders.write' } as const;

/** Staff edit of an order's customer, delivery, shade, quantity and amounts. Stock follows in the same transaction. */
export const PATCH = withAccess<typeof access, { id: string }>(access, ({ request, ctx, auth, ip, requestId, params }) =>
  respond(async () => {
    const body = await parseBody(request, orderEditSchema);
    if (!body.ok) return body.response;
    return json(200, updateOrder(ctx, { userId: auth.userId, ip, requestId }, params.id, body.data));
  }),
);
