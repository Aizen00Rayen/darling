import { productInputSchema } from '@/shared/products';
import { notFound, respond } from '@/server/admin/errors';
import { readProductById, updateProduct } from '@/server/products/db';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = {
  GET: { kind: 'public' },
  PATCH: { kind: 'permission', permission: 'catalog.write' },
} as const;

export const GET = withAccess(access.GET, async ({ params, ctx }) => {
  const { id } = await params;
  return respond(() => {
    const found = readProductById(ctx.db, id);
    if (!found) throw notFound();
    return json(200, found);
  });
});

export const PATCH = withAccess(access.PATCH, async ({ params, request, ctx, auth, ip, requestId }) => {
  const { id } = await params;
  return respond(async () => {
    const body = await parseBody(request, productInputSchema.partial());
    if (!body.ok) return body.response;

    const actor = { userId: auth.userId, ip, requestId };
    const updated = updateProduct(ctx.db, actor, id, body.data, ctx.clock.now());
    return json(200, updated);
  });
});
