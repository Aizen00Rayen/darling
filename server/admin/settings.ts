import type { z } from 'zod';
import { SETTINGS, type SettingKey } from '@/shared';
import type { Clock } from '../clock';
import type { Db } from '../db/sqlite';
import { recordAudit } from '../audit';
import { getSetting } from '../settings';
import { forbidden, notFound, validation } from './errors';

export type SettingValues = { [K in SettingKey]: z.infer<(typeof SETTINGS)[K]> };

/** Every setting of the registry with its effective value: stored when valid, the default otherwise. */
export function getAllSettings(db: Db): SettingValues {
  const keys = Object.keys(SETTINGS) as SettingKey[];
  return Object.fromEntries(keys.map((key) => [key, getSetting(db, key)])) as SettingValues;
}

export function isSettingKey(key: string): key is SettingKey {
  // Own keys only: `constructor` and `__proto__` exist on every object but are not settings.
  return Object.hasOwn(SETTINGS, key);
}

/** Who acts. Only the id is trusted: authority is re-read inside the transaction. */
export interface SettingsActor {
  userId: string;
  ip: string;
  requestId: string;
}

/**
 * Changes one setting and records `setting.updated` in the same transaction.
 *
 * - 404 for a key that is not in the registry; 400 `validation` (`errors.value`) when the value does not satisfy
 *   that key's schema. The stored (and returned) value is the schema's output, so a trimmed string is stored trimmed.
 * - The caller is judged again inside the transaction (active super manager holding settings.manage, owners hold
 *   every permission): the request may have waited while their access was removed.
 * - One immediate transaction orders concurrent updates, so each audit entry's `before` is the value its update
 *   really replaced. Values are stored as JSON text: the string "false" stays a string.
 */
export function updateSetting(deps: { db: Db; clock: Clock }, actor: SettingsActor, key: string, value: unknown): { key: SettingKey; value: unknown } {
  if (!isSettingKey(key)) throw notFound();
  const parsed = SETTINGS[key].safeParse(value);
  if (!parsed.success) throw validation({ value: parsed.error.issues[0]?.message ?? 'Valeur invalide.' });
  const next = parsed.data;

  deps.db.transaction((tx) => {
    assertMayManageSettings(tx, actor.userId);
    const previous = getSetting(tx, key);
    const now = deps.clock.now();
    tx.run(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (:key, :value, :by, :now)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      { key, value: JSON.stringify(next), by: actor.userId, now },
    );
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'setting.updated',
      entityType: 'setting',
      entityId: key,
      before: previous,
      after: next,
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
  }, 'immediate');
  return { key, value: next };
}

function assertMayManageSettings(tx: Db, userId: string): void {
  const self = tx.get<{ status: string; role: string; is_owner: number }>('SELECT status, role, is_owner FROM users WHERE id = ?', userId);
  if (self?.status !== 'active' || self.role !== 'super_manager') throw forbidden();
  if (self.is_owner === 1) return; // an owner holds every permission
  if (!tx.get("SELECT 1 AS ok FROM user_permissions WHERE user_id = ? AND permission = 'settings.manage'", userId)) throw forbidden();
}

