import type { Attribution } from './types';

/**
 * THE single hook through which an order gets attributed to an affiliate (M5). The storefront intake calls it with
 * the incoming request and stores the order with `source: 'affiliate'` when it returns something. Today nothing is
 * attributed: there are no affiliate links yet, so it always returns null and every storefront order is `website`.
 */
export function resolveAttribution(request: Request): Attribution | null {
  void request;
  return null;
}
