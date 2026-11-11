import { z } from 'zod';
import { AFFILIATE_CODE_PATTERN, MANUAL_ORDER_SOURCES, ORDER_SOURCES, ORDER_STATUSES } from '@/shared';
import { dayParam, pageParam, windowRules } from '../admin/audit-log';

/** `GET /api/orders` query string: filters validated here, pages of 50 in the service. */
export const orderListQuery = z
  .object({
    status: z.enum(ORDER_STATUSES, { error: 'Statut inconnu.' }).optional(),
    source: z.enum(ORDER_SOURCES, { error: 'Source inconnue.' }).optional(),
    q: z.string().max(100, 'Recherche trop longue.').optional(),
    from: dayParam.optional(),
    to: dayParam.optional(),
    page: pageParam,
  })
  .superRefine(windowRules);

export const statusBody = z.object({
  to: z.enum(ORDER_STATUSES, { error: 'Statut inconnu.' }),
  note: z.string({ error: 'Note invalide.' }).nullish(),
});

export const notesBody = z.object({
  internalNotes: z.string({ error: 'Notes invalides.' }).nullable(),
});

/** The part of a manual order the storefront schema does not know about. */
export const manualSource = z.enum(MANUAL_ORDER_SOURCES, { error: 'Choisissez la provenance de la commande.' });

/** A JSON object of unknown content (checked field by field afterwards). */
export const jsonObject = z.record(z.string(), z.unknown());

/** Header values accepted as an Idempotency-Key: 8 to 64 URL-safe characters (a UUID fits). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** Optional influenceuse code on a manual order: blank is "none", otherwise `AYA001` (case-insensitive). */
export const affiliateCodeField = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (typeof v === 'string' ? v.trim().toUpperCase() : ''))
  .pipe(z.string().refine((v) => v === '' || AFFILIATE_CODE_PATTERN.test(v), 'Code influenceuse invalide (exemple : AYA001).'))
  .transform((v) => (v === '' ? undefined : v));
