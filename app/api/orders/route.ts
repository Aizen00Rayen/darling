import { getProduct } from '@/data/products';
import { parseOrder } from '@/lib/order-schema';
import { deliveryFee, orderTotal } from '@/lib/pricing';
import { withAccess } from '@/server/security/access';

// Public (the storefront form), but like every route it goes through withAccess: CSRF headers are required.
export const access = { kind: 'public' } as const;

/**
 * Order intake stub. Validates the order and recomputes every amount on the
 * server; nothing is stored or sent. The backend replaces the marked section.
 */
export const POST = withAccess(access, async ({ request }): Promise<Response> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, errors: {} }, { status: 400 });
  }

  const parsed = parseOrder(body);
  if (!parsed.ok) {
    return Response.json({ ok: false, errors: parsed.errors }, { status: 400 });
  }

  const { order } = parsed;
  const unitPrice = getProduct(order.productSlug)!.price;
  const pricing = { price: unitPrice, quantity: order.quantity, wilayaCode: order.wilayaCode, mode: order.mode };
  const fee = deliveryFee(order.wilayaCode, order.mode);
  const total = orderTotal(pricing);
  if (fee === null || total === null) {
    return Response.json({ ok: false, errors: { mode: 'Livraison indisponible.' } }, { status: 400 });
  }

  // Backend hook: persist the order and attribute it to an affiliate here.

  return Response.json({ ok: true, order: { ...order, unitPrice, deliveryFee: fee, total } });
});
