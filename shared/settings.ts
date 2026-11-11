import { z } from 'zod';

const dinars = z.number({ error: 'Saisissez un montant en dinars.' }).int('Saisissez un montant entier.').min(0, 'Le montant ne peut pas être négatif.').max(100_000, 'Montant trop élevé (100 000 DA maximum).');

/** Registry of editable settings: key to value schema. */
export const SETTINGS = {
  'security.require_2fa_super_managers': z.boolean(),
  'company.name': z.string().trim().min(1).max(100),
  'commission.affiliate_amount': dinars,
  'commission.manager_amount': dinars,
  'attribution.window_days': z.number({ error: 'Saisissez un nombre de jours.' }).int('Saisissez un nombre entier de jours.').min(1, 'Au moins 1 jour.').max(365, '365 jours au maximum.'),
} satisfies Record<string, z.ZodType>;

export const SETTING_DEFAULTS = {
  'security.require_2fa_super_managers': true,
  'company.name': 'DARLING*',
  'commission.affiliate_amount': 300,
  'commission.manager_amount': 200,
  'attribution.window_days': 30,
} as const satisfies { [K in keyof typeof SETTINGS]: z.infer<(typeof SETTINGS)[K]> };

export type SettingKey = keyof typeof SETTINGS;

/** Keys only an owner may change: they decide how everyone signs in, or what money is owed. */
export const OWNER_ONLY_SETTING_PREFIXES = ['security.', 'commission.', 'attribution.'] as const;

export const isOwnerOnlySetting = (key: string): boolean => OWNER_ONLY_SETTING_PREFIXES.some((p) => key.startsWith(p));
