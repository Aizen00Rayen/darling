import { productInputSchema } from '@/shared/products';
import { respond } from '@/server/admin/errors';
import { createProduct, listProducts } from '@/server/products/db';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = {
  GET: { kind: 'public' },
  POST: { kind: 'permission', permission: 'catalog.write' },
} as const;

export const GET = withAccess(access.GET, ({ ctx }) =>
  respond(() => {
    return json(200, listProducts(ctx.db));
  }),
);

export const POST = withAccess(access.POST, ({ request, ctx, auth, ip, requestId }) =>
  respond(async () => {
    const body = await parseBody(request, productInputSchema);
    if (!body.ok) return body.response;

    const actor = { userId: auth.userId, ip, requestId };
    const created = createProduct(ctx.db, actor, body.data, ctx.clock.now());
    return json(201, created);
  }),
);
