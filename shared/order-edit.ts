import { z } from 'zod';
import { PHONE_ERROR, normalizePhone } from './index';

const text = (label: string, min: number, max: number) =>
  z.string({ error: `${label} est requis.` }).trim().min(min, `${label} est requis.`).max(max, `${label} est trop long.`);

/** What staff may change on an existing order. Amounts are optional overrides in whole dinars. */
export const orderEditSchema = z.object({
  customerName: text('Le nom', 2, 120),
  phone: z
    .string({ error: PHONE_ERROR })
    .refine((v) => normalizePhone(v) !== null, PHONE_ERROR)
    .transform((v) => normalizePhone(v) as string),
  wilayaCode: z.number().int().min(1).max(99),
  commune: text('La commune', 2, 120),
  mode: z.enum(['desk', 'home']),
  address: z.string().trim().max(200).optional(),
  shadeCode: z.string().min(1, 'Choisissez une teinte.').max(20),
  quantity: z.number().int('Quantité invalide.').min(1, 'Quantité invalide.').max(1000),
  unitPrice: z.number().int().min(0).max(10_000_000).optional(),
  deliveryFee: z.number().int().min(0).max(1_000_000).optional(),
});
export type OrderEditInput = z.infer<typeof orderEditSchema>;

export const orderDeleteSchema = z.object({ reason: z.string().trim().max(300).optional() });
