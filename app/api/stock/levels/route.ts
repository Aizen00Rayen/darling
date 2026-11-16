import { respond } from '@/server/admin/errors';
import { setStockLevels } from '@/server/inventory/stock';
import { json, parseBody, withAccess } from '@/server/security/access';
import { stockLevelsSchema } from '@/shared/stock';

export const access = { kind: 'permission', permission: 'stock.write' } as const;

/** Sets the exact stock per shade (and the low-stock alert level); differences are recorded as correction movements. */
export const POST = withAccess(access, ({ request, ctx, auth, ip, requestId }) =>
  respond(async () => {
    const body = await parseBody(request, stockLevelsSchema);
    if (!body.ok) return body.response;
    return json(200, setStockLevels(ctx.db, { userId: auth.userId, ip, requestId }, body.data, ctx.clock.now()));
  }),
);
