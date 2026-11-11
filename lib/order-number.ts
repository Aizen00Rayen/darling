import { ORDER_NUMBER_PATTERN } from '@/shared/orders';

/**
 * The order number carried by `/merci?n=...`, or null. Only the exact `DL-YY-NNNNNN` shape is ever shown: anything
 * else (markup, a repeated param, extra text) is dropped, so the page cannot be used to print arbitrary text.
 */
export function validOrderNumber(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && ORDER_NUMBER_PATTERN.test(value) ? value : null;
}
