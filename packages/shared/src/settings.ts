import { z } from 'zod';

/** Registry of editable settings: key to value schema. */
export const SETTINGS = {
  'security.require_2fa_super_managers': z.boolean(),
  'company.name': z.string().trim().min(1).max(100),
} satisfies Record<string, z.ZodType>;

export const SETTING_DEFAULTS = {
  'security.require_2fa_super_managers': true,
  'company.name': 'DARLING*',
} as const satisfies { [K in keyof typeof SETTINGS]: z.infer<(typeof SETTINGS)[K]> };

export type SettingKey = keyof typeof SETTINGS;
