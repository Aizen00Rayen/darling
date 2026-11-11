import { parseOrder } from '@/lib/order-schema';
import { respond } from '@/server/admin/errors';
import { parseQuery } from '@/server/admin/query';
import { clickIdFromRequest } from '@/server/orders/attribution';
import { createOrder, findByIdempotencyKey } from '@/server/orders/create';
import { fakeSuccess, honeypotFilled, readJson, successFromOrder, yearOf } from '@/server/orders/intake';
import { listOrders } from '@/server/orders/list';
import { IDEMPOTENCY_KEY, orderListQuery } from '@/server/orders/schemas';
import { json, withAccess } from '@/server/security/access';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';

// Two audiences on one path: the storefront form POSTs an order (public, rate-limited, honeypot, idempotent) and
// staff with `orders.read` GET the list. Per-method access; each handler uses its own rule.
export const access = {
  POST: { kind: 'public' },
  GET: { kind: 'permission', permission: 'orders.read' },
} as const;

export const GET = withAccess(access.GET, ({ request, ctx }) =>
  respond(() => {
    const query = parseQuery(request, orderListQuery);
    if (!query.ok) return query.response;
    return json(200, listOrders(ctx.db, query.data));
  }),
);

/**
 * Storefront intake. Order of business: body -> honeypot (a filled `website` field gets a fake success and NOTHING is
 * stored or counted) -> Idempotency-Key shape -> validation (`parseOrder`; client prices are never read) -> per-IP
 * budget -> replay of an already-seen key -> per-phone budget -> one transaction that prices, numbers and stores.
 * Customer names and phone numbers are never logged.
 */
export const POST = withAccess(access.POST, ({ request, ctx, ip }) =>
  respond(async () => {
    const read = await readJson(request);
    if (!read.ok) return json(read.status, read.status === 413 ? { ok: false, code: 'payload_too_large', errors: {} } : { ok: false, errors: {} });

    const parsed = parseOrder(read.data);

    if (honeypotFilled(read.data)) return json(200, fakeSuccess(parsed.ok ? parsed.order : null, yearOf(ctx.clock.now())));

    const key = request.headers.get('idempotency-key');
    if (key !== null && !IDEMPOTENCY_KEY.test(key)) return json(400, { ok: false, code: 'invalid_idempotency_key', errors: {} });

    if (!parsed.ok) return json(400, { ok: false, errors: parsed.errors });
    const { order } = parsed;

    const ipLimited = rateLimited(ctx, LIMITS.orderIp, ip);
    if (ipLimited) return ipLimited;

    // A retry of an order that went through (double click, flaky network) gets that order back and costs nothing.
    if (key !== null) {
      const existing = findByIdempotencyKey(ctx.db, key);
      if (existing && existing.phone === order.phone) return json(200, successFromOrder(order, existing));
    }

    const phoneLimited = rateLimited(ctx, LIMITS.orderPhone, order.phone);
    if (phoneLimited) return phoneLimited;

    // The signed `dl_ref` cookie (a forged or foreign one is ignored) names the click; the attribution itself is decided
    // inside the order's transaction, together with the commissions.
    const clickId = clickIdFromRequest(request, ctx.config);
    const { order: stored } = createOrder(ctx, order, {
      source: 'website',
      ...(clickId === null ? {} : { refClickId: clickId }),
      ...(key === null ? {} : { idempotencyKey: key }),
    });
    return json(200, successFromOrder(order, stored));
  }),
);
