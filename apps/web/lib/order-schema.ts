import { PHONE_ERROR, normalizePhone } from '@darling/shared';
import { z } from 'zod';
import { getWilaya, type DeliveryMode } from '@/data/delivery';
import { getProduct } from '@/data/products';

export type OrderInput = {
  productSlug: string;
  shadeCode: string;
  quantity: number;
  fullName: string;
  /** Normalised by `normalizePhone`: local `0[567]xxxxxxxx` form. */
  phone: string;
  wilayaCode: number;
  commune: string;
  mode: DeliveryMode;
  /** Required for home delivery, dropped for Stop Desk. */
  address?: string;
};

export type FieldErrors = Partial<Record<keyof OrderInput, string>>;

export { PHONE_ERROR };

const text = (label: string, min: number, max: number) =>
  z
    .string({ error: `${label} est requis.` })
    .trim()
    .min(min, `${label} est requis.`)
    .max(max, `${label} est trop long (${max} caractères maximum).`);

export const orderSchema = z
  .object({
    productSlug: z.string({ error: 'Produit inconnu.' }),
    shadeCode: z.string({ error: 'Choisissez une teinte.' }),
    quantity: z
      .number({ error: 'Quantité invalide.' })
      .int('Quantité invalide.')
      .min(1, 'Quantité invalide.'),
    fullName: text('Le nom', 2, 120),
    phone: z
      .string({ error: PHONE_ERROR })
      .refine((value) => normalizePhone(value) !== null, PHONE_ERROR)
      .transform((value) => normalizePhone(value) as string),
    wilayaCode: z.number({ error: 'Choisissez votre wilaya.' }).int('Choisissez votre wilaya.'),
    commune: text('La commune', 2, 120),
    mode: z.enum(['desk', 'home'], { error: 'Choisissez un mode de livraison.' }),
    address: z.string().trim().max(200, 'L’adresse est trop longue (200 caractères maximum).').optional(),
  })
  .superRefine((order, ctx) => {
    const issue = (field: keyof OrderInput, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message });

    const product = getProduct(order.productSlug);
    if (!product) {
      issue('productSlug', 'Produit inconnu.');
    } else {
      if (!product.shades.some((shade) => shade.code === order.shadeCode)) {
        issue('shadeCode', 'Choisissez une teinte.');
      }
      if (order.quantity > product.maxQuantity) {
        issue('quantity', `Quantité maximale : ${product.maxQuantity}.`);
      }
    }

    const wilaya = getWilaya(order.wilayaCode);
    if (!wilaya) {
      issue('wilayaCode', 'Choisissez votre wilaya.');
    } else if (order.mode === 'desk' && wilaya.desk === null) {
      issue('mode', 'Le retrait Stop Desk n’est pas disponible dans cette wilaya.');
    }

    if (order.mode === 'home' && (order.address ?? '').length < 5) {
      issue('address', 'Indiquez votre adresse de livraison.');
    }
  })
  .transform(({ address, ...order }): OrderInput => (order.mode === 'home' ? { ...order, address } : order));

/** Validates untrusted input. Errors carry the first French message per field. */
export function parseOrder(data: unknown): { ok: true; order: OrderInput } | { ok: false; errors: FieldErrors } {
  const result = orderSchema.safeParse(data);
  if (result.success) return { ok: true, order: result.data };

  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as keyof OrderInput | undefined;
    if (field && !(field in errors)) errors[field] = issue.message;
  }
  return { ok: false, errors };
}
