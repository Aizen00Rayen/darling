import { z } from 'zod';
import { COMMISSION_STATUSES, PAYOUT_METHODS } from '@/shared';
import { dayParam, pageParam, windowRules } from '../admin/audit-log';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = z.string().regex(ID, 'Identifiant invalide.');

export const affiliatesQuery = z.object({
  q: z.string().max(100, 'Recherche trop longue.').optional(),
  status: z.enum(['invited', 'active', 'suspended', 'deactivated'], { error: 'Statut inconnu.' }).optional(),
  manager: idParam.optional(),
  page: pageParam,
});

export const commissionsQuery = z.object({
  status: z.enum(COMMISSION_STATUSES, { error: 'Statut inconnu.' }).optional(),
  beneficiary: idParam.optional(),
  order: z.string().max(30, 'Numéro trop long.').optional(),
  page: pageParam,
});

export const payoutsQuery = z
  .object({ beneficiary: idParam.optional(), from: dayParam.optional(), to: dayParam.optional(), page: pageParam })
  .superRefine(windowRules);

export const cancelBody = z.object({ reason: z.string({ error: 'Indiquez le motif de l’annulation.' }) });

export const payoutBody = z.object({
  beneficiaryUserId: z.string({ error: 'Bénéficiaire requis.' }),
  method: z.enum(PAYOUT_METHODS, { error: 'Choisissez un mode de paiement.' }),
  reference: z.string().nullish(),
  paidAt: z.string({ error: 'Date requise.' }),
  note: z.string().nullish(),
});
