// Affiliation vocabulary shared by the server, the portal and the storefront: codes and links, the privacy mask for
// customer names, commission and payout enumerations and the shapes the API returns. Plain data and pure functions.

/** `AYA001`: three capital letters and a sequence of at least three digits. */
export const AFFILIATE_CODE_PATTERN = /^[A-Z]{3}\d{3,}$/;

const FOLD: Readonly<Record<string, string>> = { 'æ': 'AE', 'œ': 'OE', 'ø': 'O', 'ß': 'SS', 'đ': 'D', 'ð': 'D', 'ł': 'L', 'ı': 'I', 'þ': 'TH' };

/**
 * The three-letter prefix of a code: the first three letters of the full name, upper-case and ASCII-folded
 * (accents dropped, `æ`/`ß` spelled out), everything else dropped, padded with `X`.
 */
export function affiliateCodePrefix(fullName: string): string {
  let letters = '';
  for (const ch of fullName.normalize('NFD').replace(/\p{M}/gu, '')) {
    const lower = ch.toLowerCase();
    const folded = FOLD[lower];
    if (folded !== undefined) letters += folded;
    else if (/^[a-z]$/.test(lower)) letters += lower.toUpperCase();
    if (letters.length >= 3) break;
  }
  return letters.slice(0, 3).padEnd(3, 'X');
}

/** `https://shop.example/?ref=AYA001` (a trailing slash on the origin is tolerated). */
export function affiliateLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/?ref=${code}`;
}

const MAX_FIRST_NAME = 30;

/**
 * What an influenceuse or a sous-manager may see of a customer: the first name and the initial of the LAST word
 * ("Amel B.", "Nour B." for "Nour El Houda Benali"), nothing else. Words that contain a digit or an `@` are skipped (customers sometimes type their phone
 * number or e-mail into the name field), characters other than letters, marks, hyphens and apostrophes are dropped,
 * the first name is capped. A single name stays as is; an empty or unusable name gives 'Client'.
 */
export function maskCustomerName(fullName: string): string {
  const words = fullName
    .split(/[\s\u00a0]+/u)
    .filter((w) => w !== '' && !/[\d@]/u.test(w))
    .join(' ')
    // Any other separator (dot, comma, underscore, slash, emoji...) also ends a word: "Amel.Benali" is two words.
    .split(/[^\p{L}\p{M}'’-]+/u)
    .map((w) => w.replace(/^[^\p{L}]+/u, ''))
    .filter((w) => /\p{L}/u.test(w));
  const first = words[0];
  if (first === undefined) return 'Client';
  const name = Array.from(first).slice(0, MAX_FIRST_NAME).join('');
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const initial = last === undefined ? undefined : Array.from(last)[0];
  return initial === undefined ? name : `${name} ${initial.toLocaleUpperCase('fr')}.`;
}

export const COMMISSION_STATUSES = ['pending', 'validated', 'paid', 'cancelled'] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];
export const COMMISSION_KINDS = ['affiliate', 'manager'] as const;
export type CommissionKind = (typeof COMMISSION_KINDS)[number];
export const PAYOUT_METHODS = ['cash', 'ccp', 'baridimob', 'bank', 'other'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const HOLD_REASON_SELF_REFERRAL = 'auto-référence';
/** The influenceuse has no phone on file, so self-referral cannot be ruled out. */
export const HOLD_REASON_NO_PHONE = 'téléphone manquant';

/** Roles that must have a phone number (it is how self-referral is detected). */
export const PHONE_REQUIRED_ROLES = ['affiliate', 'sub_manager'] as const;
export const PHONE_REQUIRED_MESSAGE = 'Téléphone obligatoire pour ce rôle.';

export const isCommissionStatus = (v: unknown): v is CommissionStatus => typeof v === 'string' && (COMMISSION_STATUSES as readonly string[]).includes(v);

/** Sum of commissions per status, in whole dinars. */
export interface OwnTotals {
  pending: number;
  validated: number;
  paid: number;
  cancelled: number;
}

/** Staff view: `onHold` is the part of `pending` that is held back (never shown to the people who earn it). */
export interface CommissionTotals extends OwnTotals {
  onHold: number;
}

/** An order as an influenceuse or sous-manager sees it: the customer is a masked name, nothing else personal. */
export interface MaskedOrder {
  /** A per-person display label (`#1`, `#2`...), never the shop's global order number. */
  ref: string;
  createdAt: string;
  status: string;
  productName: string;
  quantity: number;
  total: number;
  wilayaName: string;
  customer: string;
  /** Sous-manager view only: the influenceuse of the order. */
  affiliate?: { code: string; name: string };
}

export interface OwnCommission {
  id: string;
  orderRef: string;
  orderDate: string;
  kind: CommissionKind;
  amount: number;
  status: CommissionStatus;
}

export interface OwnPayout {
  id: string;
  amount: number;
  method: PayoutMethod;
  reference: string | null;
  paidAt: string;
}

export interface OwnAdjustment {
  id: string;
  amount: number;
  reason: string;
  orderRef: string | null;
  createdAt: string;
  /** True once a payout has netted it. */
  settled: boolean;
}

export interface MeAffiliate {
  code: string;
  link: string;
  clicks: number;
  orderCount: number;
  deliveredCount: number;
  orders: MaskedOrder[];
  commissions: OwnCommission[];
  totals: OwnTotals;
  /** Clawbacks not yet netted by a payout (negative or zero). */
  unsettledAdjustments: number;
  adjustments: OwnAdjustment[];
  payouts: OwnPayout[];
  paidTotal: number;
}

export interface TeamMember {
  userId: string;
  code: string;
  name: string;
  status: string;
  clicks: number;
  orderCount: number;
  deliveredCount: number;
  totals: OwnTotals;
}

export interface MeTeam {
  members: TeamMember[];
  orders: MaskedOrder[];
  orderCount: number;
  commissions: OwnCommission[];
  totals: OwnTotals;
  unsettledAdjustments: number;
  adjustments: OwnAdjustment[];
  payouts: OwnPayout[];
}

/** Affiliate attribution of an order as staff see it. */
export interface OrderAttribution {
  affiliate: { userId: string; code: string; name: string };
  manager: { userId: string; name: string } | null;
  selfReferral: boolean;
  viaClick: boolean;
}

export interface AdminAffiliateRow {
  userId: string;
  code: string;
  name: string;
  status: string;
  manager: { userId: string; name: string } | null;
  clicks: number;
  orders: number;
  delivered: number;
  totals: CommissionTotals;
  link: string;
}

export interface AdminCommissionRow {
  id: string;
  orderId: string;
  orderNumber: string;
  orderDate: string;
  orderStatus: string;
  customer: string;
  beneficiary: { userId: string; name: string };
  kind: CommissionKind;
  amount: number;
  status: CommissionStatus;
  onHold: boolean;
  holdReason: string | null;
  validatedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

export interface AdminPayoutRow {
  id: string;
  beneficiary: { userId: string; name: string };
  amount: number;
  method: PayoutMethod;
  reference: string | null;
  paidAt: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  commissionCount: number;
}
