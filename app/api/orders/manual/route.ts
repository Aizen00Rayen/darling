import { parseOrder } from '@/lib/order-schema';
import { respond } from '@/server/admin/errors';
import { createOrder } from '@/server/orders/create';
import { getOrder } from '@/server/orders/read';
import { jsonObject, manualSource } from '@/server/orders/schemas';
import { json, parseBody, validationFailed, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'orders.write' } as const;

/**
 * An order entered by staff (Instagram, WhatsApp, ...): same validation and server-side pricing as the storefront,
 * plus a required `source` from the manual list. `created_by` is the actor, the audit row is `order.created_manual`.
 */
export const POST = withAccess(access, ({ request, ctx, auth, ip, requestId }) =>
  respond(async () => {
    const body = await parseBody(request, jsonObject);
    if (!body.ok) return body.response;
    const { source, ...fields } = body.data;

    const errors: Record<string, string> = {};
    const sourceResult = manualSource.safeParse(source);
    if (!sourceResult.success) errors.source = sourceResult.error.issues[0]?.message ?? 'Provenance invalide.';
    const order = parseOrder(fields);
    if (!order.ok) Object.assign(errors, order.errors);
    if (!sourceResult.success || !order.ok) return validationFailed(errors);

    const { order: created } = createOrder(ctx, order.order, { source: sourceResult.data, createdBy: auth.userId, ip, requestId });
    return json(201, getOrder(ctx.db, created.id));
  }),
);
