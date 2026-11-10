import { getWilaya, type DeliveryMode } from '@/data/delivery';

export function formatMoney(n: number): string {
  return `${n.toLocaleString('fr-FR')} DA`;
}

/** Delivery fee in DA, or null when the wilaya is unknown or the mode is not offered there. */
export function deliveryFee(wilayaCode: number, mode: DeliveryMode): number | null {
  const wilaya = getWilaya(wilayaCode);
  if (!wilaya) return null;
  return mode === 'home' ? wilaya.home : wilaya.desk;
}

/** Price times quantity plus a single delivery fee, or null when delivery is unavailable. */
export function orderTotal(input: {
  price: number;
  quantity: number;
  wilayaCode: number;
  mode: DeliveryMode;
}): number | null {
  const fee = deliveryFee(input.wilayaCode, input.mode);
  if (fee === null) return null;
  return input.price * input.quantity + fee;
}
