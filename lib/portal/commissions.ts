import type { BadgeTone } from '@/ui';
import type { CommissionKind, CommissionStatus, PayoutMethod } from '@/shared';
import { formatMoney } from '@/lib/pricing';

// French vocabulary of the commission screens (staff, influenceuse and sous-manager portals). Own-property lookups
// only, so that a value such as `constructor` is never mistaken for a known key.

const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

const STATUS_LABELS: Record<CommissionStatus, string> = { pending: 'En attente', validated: 'Validée', paid: 'Payée', cancelled: 'Annulée' };
const STATUS_TONES: Record<CommissionStatus, BadgeTone> = { pending: 'warning', validated: 'pink', paid: 'success', cancelled: 'danger' };

/** `En attente`, or `En attente (retenue)` for a held commission (staff screens only). */
export const commissionStatusLabel = (status: string, onHold = false): string => {
  const base = own(STATUS_LABELS, status) ?? status;
  return status === 'pending' && onHold ? `${base} (retenue)` : base;
};
export const commissionStatusTone = (status: string): BadgeTone => own(STATUS_TONES, status) ?? 'neutral';

const KIND_LABELS: Record<CommissionKind, string> = { affiliate: 'Influenceuse', manager: 'Sous-manager' };
export const commissionKindLabel = (kind: string): string => own(KIND_LABELS, kind) ?? kind;

const METHOD_LABELS: Record<PayoutMethod, string> = { cash: 'Espèces', ccp: 'CCP', baridimob: 'BaridiMob', bank: 'Virement bancaire', other: 'Autre' };
export const payoutMethodLabel = (method: string): string => own(METHOD_LABELS, method) ?? method;

/** `-300 DA` with a real minus sign for clawbacks, `300 DA` otherwise. */
export const formatSignedMoney = (amount: number): string => (amount < 0 ? `−${formatMoney(-amount)}` : formatMoney(amount));

const algiersDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' });
/** `YYYY-MM-DD` of the Algiers calendar day an instant falls in (default value of the payout date). */
export const algiersToday = (now: Date = new Date()): string => algiersDay.format(now);

export interface PayoutFormValues {
  method: string;
  reference: string;
  paidAt: string;
  note: string;
}

/** Client-side checks of the payout dialog (the server judges again): French messages per field. */
export function payoutFormErrors(values: PayoutFormValues, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!['cash', 'ccp', 'baridimob', 'bank', 'other'].includes(values.method)) errors.method = 'Choisissez un mode de paiement.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.paidAt)) errors.paidAt = 'Date invalide.';
  else if (values.paidAt > today) errors.paidAt = 'La date ne peut pas être dans le futur.';
  if (values.reference.trim().length > 100) errors.reference = 'La référence est trop longue (100 caractères maximum).';
  if (values.note.trim().length > 500) errors.note = 'La note est trop longue (500 caractères maximum).';
  return errors;
}
