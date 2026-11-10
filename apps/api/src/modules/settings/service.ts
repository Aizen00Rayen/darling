import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { SETTING_DEFAULTS, SETTINGS, type SettingKey } from '@darling/shared';
import type { DbExecutor } from '../../db/client';
import { settings } from '../../db/schema';

/**
 * The stored value of a setting, validated through its registry schema. With no row, or a stored
 * value that no longer satisfies the schema, the default applies: a corrupt row must never switch
 * off a safeguard (for example the 2FA requirement), so it fails to the default, not to "off".
 */
export async function getSetting<K extends SettingKey>(
  db: DbExecutor,
  key: K,
): Promise<z.infer<(typeof SETTINGS)[K]>> {
  // Read the JSON as text and parse it once here. Selecting the jsonb column through drizzle would
  // decode it twice (the driver already parses it), so the string "false" would come back as the
  // boolean false and "2026" as the number 2026.
  const [row] = await db
    .select({ json: sql<string>`${settings.value}::text` })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  if (row) {
    try {
      const parsed = SETTINGS[key].safeParse(JSON.parse(row.json));
      if (parsed.success) return parsed.data as z.infer<(typeof SETTINGS)[K]>;
    } catch {
      // Not valid JSON: fall through to the default.
    }
  }
  return SETTING_DEFAULTS[key] as z.infer<(typeof SETTINGS)[K]>;
}
