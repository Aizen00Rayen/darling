import { respond } from '@/server/admin/errors';
import { getOrder } from '@/server/orders/read';
import { notesBody } from '@/server/orders/schemas';
import { updateNotes } from '@/server/orders/status';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = {
  GET: { kind: 'permission', permission: 'orders.read' },
  PATCH: { kind: 'permission', permission: 'orders.write' },
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
