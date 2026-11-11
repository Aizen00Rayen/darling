import type { z } from 'zod';
import { SETTING_DEFAULTS, SETTINGS, type SettingKey } from '@/shared';
import type { Db } from './db/sqlite';

/**
 * The stored value of a setting, validated through its registry schema. With no row, or a stored value that
 * no longer satisfies the schema (or is not JSON), the default applies: a corrupt row must never switch off a
 * safeguard (for example the 2FA requirement), so it fails to the default, not to "off". The JSON text is
 * parsed exactly once here.
 */
export function getSetting<K extends SettingKey>(db: Db, key: K): z.infer<(typeof SETTINGS)[K]> {
  const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (row) {
    try {
      const parsed = SETTINGS[key].safeParse(JSON.parse(row.value));
      if (parsed.success) return parsed.data as z.infer<(typeof SETTINGS)[K]>;
    } catch {
      // not valid JSON: fall through to the default
    }
  }
  return SETTING_DEFAULTS[key] as z.infer<(typeof SETTINGS)[K]>;
}
