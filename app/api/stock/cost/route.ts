import { z } from 'zod';
import { respond } from '@/server/admin/errors';
import { setCostPrice } from '@/server/inventory/stock';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'finance.read' } as const;

const body = z.object({ productId: z.string().min(1), costPrice: z.number().int().min(0).max(100_000_000) });

/** Sets a product's real purchase cost (finance only: it is never shown to other roles). */
export const POST = withAccess(access, ({ request, ctx, auth, ip, requestId }) =>
  respond(async () => {
    const parsed = await parseBody(request, body);
    if (!parsed.ok) return parsed.response;
    setCostPrice(ctx.db, { userId: auth.userId, ip, requestId }, parsed.data.productId, parsed.data.costPrice, ctx.clock.now());
    return json(200, { ok: true });
  }),
);
