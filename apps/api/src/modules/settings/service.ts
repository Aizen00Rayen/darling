import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { SETTING_DEFAULTS, SETTINGS, type SettingKey } from '@darling/shared';
import type { AppDeps } from '../../app';
import type { DbExecutor, DbTx } from '../../db/client';
import { settings, userPermissions, users } from '../../db/schema';
import { apiError, validationError } from '../../plugins/errors';
import { recordAudit } from '../audit/service';

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

/** Every setting of the registry with its effective value: stored when valid, the default otherwise. */
export async function getAllSettings(db: DbExecutor): Promise<{ [K in SettingKey]: z.infer<(typeof SETTINGS)[K]> }> {
  const keys = Object.keys(SETTINGS) as SettingKey[];
  const entries = await Promise.all(keys.map(async (key) => [key, await getSetting(db, key)] as const));
  return Object.fromEntries(entries) as { [K in SettingKey]: z.infer<(typeof SETTINGS)[K]> };
}

export function isSettingKey(key: string): key is SettingKey {
  // Own keys only: `constructor` and `__proto__` exist on every object but are not settings.
  return Object.hasOwn(SETTINGS, key);
}

/** The caller as the access plugin resolved them at the start of the request. */
export type SettingsActor = { userId: string; ip: string; requestId: string };

/**
 * Changes one setting and records `setting.updated` in the same transaction.
 *
 * - 404 for a key that is not in the registry; 400 `validation` (`errors.value`) when the value does
 *   not satisfy that key's schema. The stored (and returned) value is the schema's output, so a
 *   trimmed string is stored trimmed.
 * - The caller is checked again inside the transaction (`FOR SHARE` on their row, then their grant):
 *   the request may have waited while their access was removed.
 * - A transaction-scoped advisory lock per key orders concurrent updates of the same key, so each
 *   audit entry's `before` is the value its update really replaced.
 */
export async function updateSetting(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  actor: SettingsActor,
  key: string,
  value: unknown,
): Promise<{ key: SettingKey; value: unknown }> {
  if (!isSettingKey(key)) throw apiError(404, 'not_found');
  const parsed = SETTINGS[key].safeParse(value);
  if (!parsed.success) {
    throw validationError({ value: parsed.error.issues[0]?.message ?? 'Valeur invalide.' });
  }
  const next = parsed.data;
  const now = deps.clock();
  // JSON text cast to jsonb: the string "false" stays a string, and nothing is encoded twice.
  const json = sql`${JSON.stringify(next)}::jsonb`;

  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`setting:${key}`}))`);
    await assertMayManageSettings(tx, actor.userId);
    const previous = await getSetting(tx, key);
    await tx
      .insert(settings)
      .values({ key, value: json, updatedBy: actor.userId, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: json, updatedBy: actor.userId, updatedAt: now },
      });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'setting.updated',
      entityType: 'setting',
      entityId: key,
      before: previous,
      after: next,
      ip: actor.ip,
      requestId: actor.requestId,
    });
  });

  return { key, value: next };
}

async function assertMayManageSettings(tx: DbTx, userId: string): Promise<void> {
  const [self] = await tx
    .select({ status: users.status, role: users.role, isOwner: users.isOwner })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for('share');
  if (self?.status !== 'active' || self.role !== 'super_manager') throw apiError(403, 'forbidden');
  if (self.isOwner) return; // an owner holds every permission
  const [grant] = await tx
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(and(eq(userPermissions.userId, userId), eq(userPermissions.permission, 'settings.manage')))
    .limit(1);
  if (!grant) throw apiError(403, 'forbidden');
}
