import type { BadgeTone } from '@/ui';
import type { OrderSource, OrderStatus } from '@/shared';

// French vocabulary of the orders screens. Lookups use own-property checks so values such as `constructor` are
// never mistaken for a known key.

const STATUS_LABELS: Record<OrderStatus, string> = {
  new: 'Nouvelle',
  confirmed: 'Confirmée',
  shipped: 'Expédiée',
  delivered: 'Livrée',
  cancelled: 'Annulée',
  refused: 'Refusée',
  returned: 'Retournée',
};

const STATUS_TONES: Record<OrderStatus, BadgeTone> = {
  new: 'warning',
  confirmed: 'pink',
  shipped: 'neutral',
  delivered: 'success',
  cancelled: 'danger',
  refused: 'danger',
  returned: 'danger',
};

const SOURCE_LABELS: Record<OrderSource, string> = {
  website: 'Site web',
  affiliate: 'Influenceuse',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  direct: 'Direct',
  other: 'Autre',
};

const SOURCE_TONES: Record<OrderSource, BadgeTone> = {
  website: 'neutral',
  affiliate: 'pink',
  instagram: 'pink',
  whatsapp: 'success',
  facebook: 'neutral',
  direct: 'neutral',
  other: 'neutral',
};

const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

export const orderStatusLabel = (status: OrderStatus): string => own(STATUS_LABELS, status) ?? status;
export const orderStatusTone = (status: OrderStatus): BadgeTone => own(STATUS_TONES, status) ?? 'neutral';
export const orderSourceLabel = (source: OrderSource): string => own(SOURCE_LABELS, source) ?? source;
export const orderSourceTone = (source: OrderSource): BadgeTone => own(SOURCE_TONES, source) ?? 'neutral';

export interface OrderAction {
  /** Button text. */
  label: string;
  /** Confirmation dialog title. */
  title: string;
  /** Confirmation dialog body. */
  description: string;
  /** Confirm button text. */
  confirm: string;
  tone: 'primary' | 'danger';
  /** Whether the dialog offers an optional note (the unhappy endings). */
  askNote: boolean;
}

const ACTIONS: Record<OrderStatus, OrderAction> = {
  new: { label: 'Remettre à nouvelle', title: 'Remettre cette commande à « nouvelle » ?', description: '', confirm: 'Confirmer', tone: 'primary', askNote: false },
  confirmed: {
    label: 'Confirmer la commande',
    title: 'Confirmer cette commande ?',
    description: 'La cliente a confirmé sa commande par téléphone.',
    confirm: 'Confirmer',
    tone: 'primary',
    askNote: false,
  },
  shipped: {
    label: 'Marquer comme expédiée',
    title: 'Marquer cette commande comme expédiée ?',
    description: 'Le colis est remis au transporteur.',
    confirm: 'Marquer expédiée',
    tone: 'primary',
    askNote: false,
  },
  delivered: {
    label: 'Marquer comme livrée',
    title: 'Marquer cette commande comme livrée ?',
    description: 'Le colis a été remis à la cliente et payé.',
    confirm: 'Marquer livrée',
    tone: 'primary',
    askNote: false,
  },
  cancelled: {
    label: 'Annuler la commande',
    title: 'Annuler cette commande ?',
    description: 'Une commande annulée ne peut plus être modifiée.',
    confirm: 'Annuler la commande',
    tone: 'danger',
    askNote: true,
  },
  refused: {
    label: 'Refusée à la livraison',
    title: 'Marquer cette commande comme refusée ?',
    description: 'La cliente a refusé le colis à la livraison. Cette décision est définitive.',
    confirm: 'Marquer refusée',
    tone: 'danger',
    askNote: true,
  },
  returned: {
    label: 'Marquer comme retournée',
    title: 'Marquer cette commande comme retournée ?',
    description: 'Le colis livré a été retourné. Cette décision est définitive.',
    confirm: 'Marquer retournée',
    tone: 'danger',
    askNote: true,
  },
};

/** How the button, the dialog and the optional note look for a change TO `status`. */
export const orderActionFor = (status: OrderStatus): OrderAction => ACTIONS[status];

/** `06 12 34 56 78` for a normalised phone, the text unchanged for anything else. */
export function formatPhone(phone: string): string {
  return /^\d{10}$/.test(phone) ? phone.replace(/(\d{2})(?=\d)/g, '$1 ') : phone;
}

export const deliveryModeLabel = (mode: 'desk' | 'home'): string => (mode === 'home' ? 'À domicile' : 'Stop Desk (retrait au bureau)');

export const shadeLabel = (code: string): string => `Teinte ${code}`;
