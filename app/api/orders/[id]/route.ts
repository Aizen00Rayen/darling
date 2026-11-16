import { respond } from '@/server/admin/errors';
import { getOrder } from '@/server/orders/read';
import { notesBody } from '@/server/orders/schemas';
import { deleteOrder } from '@/server/orders/manage';
import { updateNotes } from '@/server/orders/status';
import { noContent, json, parseBody, withAccess } from '@/server/security/access';

export const access = {
  GET: { kind: 'permission', permission: 'orders.read' },
  PATCH: { kind: 'permission', permission: 'orders.write' },
  DELETE: { kind: 'permission', permission: 'orders.write' },
} as const;

export const GET = withAccess<typeof access.GET, { id: string }>(access.GET, ({ ctx, params }) => respond(() => json(200, getOrder(ctx.db, params.id))));

/** Only the internal notes can be edited; everything else on an order is a snapshot or moves through the status machine. */
export const PATCH = withAccess<typeof access.PATCH, { id: string }>(access.PATCH, ({ request, ctx, auth, ip, requestId, params }) =>
  respond(async () => {
    const body = await parseBody(request, notesBody);
    if (!body.ok) return body.response;
    updateNotes(ctx, { userId: auth.userId, ip, requestId }, params.id, body.data.internalNotes);
    return json(200, getOrder(ctx.db, params.id));
  }),
);

/** Deletes an order from all lists and totals (soft delete: the order is closed, its stock returned, its commissions cancelled). */
export const DELETE = withAccess<typeof access.DELETE, { id: string }>(access.DELETE, ({ ctx, auth, ip, requestId, params }) =>
  respond(() => {
    deleteOrder(ctx, { userId: auth.userId, ip, requestId }, params.id);
    return noContent();
  }),
);
