import { respond } from '@/server/admin/errors';
import { listMovements, recordManualMovement } from '@/server/inventory/stock';
import { json, parseBody, withAccess } from '@/server/security/access';
import { movementInputSchema } from '@/shared/stock';

export const access = {
  GET: { kind: 'permission', permission: 'stock.write' },
  POST: { kind: 'permission', permission: 'stock.write' },
} as const;

export const GET = withAccess(access.GET, ({ request, ctx }) =>
  respond(() => {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const productId = url.searchParams.get('productId') ?? undefined;
    return json(200, listMovements(ctx.db, { ...(productId ? { productId } : {}), limit: Number.isFinite(limit) ? limit : 100 }));
  }),
);

export const POST = withAccess(access.POST, ({ request, ctx, auth, ip, requestId }) =>
  respond(async () => {
    const body = await parseBody(request, movementInputSchema);
    if (!body.ok) return body.response;
    const stock = recordManualMovement(ctx.db, { userId: auth.userId, ip, requestId }, body.data, ctx.clock.now());
    return json(201, stock);
  }),
);
