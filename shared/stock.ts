import { z } from 'zod';

export const STOCK_REASONS = ['initial', 'purchase', 'sale_website', 'sale_offsite', 'return', 'damage', 'adjustment'] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export const STOCK_REASON_LABELS: Record<StockReason, string> = {
  initial: 'Stock initial',
  purchase: 'Réception de marchandise',
  sale_website: 'Vente site',
  sale_offsite: 'Vente hors site',
  return: 'Retour / annulation',
  damage: 'Casse / perte',
  adjustment: 'Correction d’inventaire',
};

export const OFFSITE_CHANNELS = ['instagram', 'whatsapp', 'facebook', 'direct', 'other'] as const;
export type OffsiteChannel = (typeof OFFSITE_CHANNELS)[number];
export const OFFSITE_CHANNEL_LABELS: Record<OffsiteChannel, string> = {
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  direct: 'Boutique / main propre',
  other: 'Autre',
};

/** Reasons staff can record by hand. `sale_website` and `initial` are written by the system only. */
export const MANUAL_REASONS = ['purchase', 'sale_offsite', 'return', 'damage', 'adjustment'] as const;

/** Reasons that must remove stock, add stock, or may do either. */
export const REMOVING_REASONS: readonly StockReason[] = ['sale_offsite', 'damage'];
export const ADDING_REASONS: readonly StockReason[] = ['purchase', 'return'];

export const movementInputSchema = z
  .object({
    productId: z.string().min(1, 'Produit requis.'),
    /** '' = unallocated pool. */
    shadeCode: z.string().max(20).default(''),
    reason: z.enum(MANUAL_REASONS),
    /** Positive quantity; the sign comes from the reason (or from `direction` for an adjustment). */
    quantity: z.number().int('Quantité entière requise.').min(1, 'Quantité minimale : 1.').max(100000),
    direction: z.enum(['in', 'out']).optional(),
    channel: z.enum(OFFSITE_CHANNELS).optional(),
    unitPrice: z.number().int().min(0).max(10_000_000).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.reason === 'adjustment' && !v.direction) ctx.addIssue({ code: 'custom', path: ['direction'], message: 'Indiquez ajout ou retrait.' });
    if (v.reason === 'sale_offsite' && !v.channel) ctx.addIssue({ code: 'custom', path: ['channel'], message: 'Indiquez le canal de vente.' });
    if ((v.reason === 'adjustment' || v.reason === 'damage') && !v.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Une raison est obligatoire.' });
  });
export type MovementInput = z.infer<typeof movementInputSchema>;

export interface ShadeLevel {
  /** '' for the unallocated pool. */
  shadeCode: string;
  quantity: number;
}

export interface StockProduct {
  id: string;
  slug: string;
  name: string;
  total: number;
  lowStockThreshold: number;
  isActive: boolean;
  shades: ShadeLevel[];
  soldWebsite: number;
  soldOffsite: number;
}

export interface StockMovementDto {
  id: number;
  productId: string;
  productName: string;
  shadeCode: string;
  delta: number;
  reason: StockReason;
  channel: string | null;
  orderId: string | null;
  unitPrice: number | null;
  note: string | null;
  actorName: string | null;
  at: number;
}
