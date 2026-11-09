import { getWilaya, type DeliveryMode } from '@/data/delivery';
import { deliveryFee, formatMoney } from './pricing';

/** True until a wilaya without Stop Desk service is chosen. */
export function deskAvailable(wilayaCode: number | null): boolean {
  if (wilayaCode === null) return true;
  return getWilaya(wilayaCode)?.desk != null;
}

/** The mode actually in effect: home is forced where there is no desk service. */
export function resolveMode(wilayaCode: number | null, mode: DeliveryMode): DeliveryMode {
  return deskAvailable(wilayaCode) ? mode : 'home';
}

export function clampQuantity(n: number, max: number): number {
  return Math.min(max, Math.max(1, n));
}

export function wrapIndex(i: number, length: number): number {
  return (i + length) % length;
}

/** Display strings for the delivery and total lines of the order form. */
export function summary(input: {
  price: number;
  quantity: number;
  wilayaCode: number | null;
  mode: DeliveryMode;
}): { delivery: string; total: string } {
  const subtotal = input.price * input.quantity;
  const fee = input.wilayaCode === null ? null : deliveryFee(input.wilayaCode, input.mode);
  return {
    delivery: fee === null ? 'Choisissez une wilaya' : formatMoney(fee),
    total: formatMoney(subtotal + (fee ?? 0)),
  };
}
