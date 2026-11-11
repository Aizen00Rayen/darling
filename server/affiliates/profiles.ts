import { affiliateCodePrefix } from '@/shared';
import type { Db } from '../db/sqlite';
import { validation } from '../admin/errors';
import { recordAudit } from '../audit';

// Influenceuse profiles. A profile is created in the SAME transaction that makes (or re-roles) the user, gets a code
// that is never reused (profiles are never deleted, the sequence only grows) and keeps existing when the person
// changes role (history stays; attribution looks at the user's current role and status, not at the profile alone).

export interface AffiliateInfo {
  code: string;
  managerUserId: string | null;
  managerName: string | null;
}

interface ProfileRow {
  user_id: string;
  code: string;
  manager_user_id: string | null;
}

export function readProfile(db: Db, userId: string): ProfileRow | undefined {
  return db.get<ProfileRow>('SELECT user_id, code, manager_user_id FROM affiliate_profiles WHERE user_id = ?', userId);
}

/** The profile as shown on the user's page: code and manager. Null when the user never was an influenceuse. */
export function readAffiliateInfo(db: Db, userId: string): AffiliateInfo | null {
  const row = db.get<{ code: string; manager_user_id: string | null; manager_name: string | null }>(
    `SELECT p.code, p.manager_user_id, m.full_name AS manager_name
     FROM affiliate_profiles p LEFT JOIN users m ON m.id = p.manager_user_id WHERE p.user_id = ?`,
    userId,
  );
  return row ? { code: row.code, managerUserId: row.manager_user_id, managerName: row.manager_name } : null;
}

/**
 * The next free code for a name: the three-letter prefix and the next three-digit sequence of THAT prefix
 * (`AYA001`, `AYA002`, ...). Call it inside a BEGIN IMMEDIATE transaction: writers are serialised, so the
 * maximum read here is the maximum the insert sees, and the UNIQUE index is the backstop.
 */
export function nextAffiliateCode(tx: Db, fullName: string): string {
  const prefix = affiliateCodePrefix(fullName);
  const row = tx.get<{ n: number | null }>("SELECT max(CAST(substr(code, 4) AS INTEGER)) AS n FROM affiliate_profiles WHERE substr(code, 1, 3) = ?", prefix);
  const next = (row?.n ?? 0) + 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}

/** 400 `validation` (`managerUserId`) unless the id is an ACTIVE sous-manager. */
export function assertActiveSubManager(tx: Db, id: string): void {
  const row = tx.get("SELECT 1 AS ok FROM users WHERE id = ? AND role = 'sub_manager' AND status = 'active'", id);
  if (!row) throw validation({ managerUserId: 'Choisissez un sous-manager actif.' });
}

export interface ProfileActor {
  userId: string;
  ip: string;
  requestId: string;
}

/** Creates the profile (code included) and its audit row; the manager, when given, must be an active sous-manager. */
export function createProfile(tx: Db, actor: ProfileActor, user: { id: string; fullName: string }, managerUserId: string | null, now: number): string {
  if (managerUserId !== null) assertActiveSubManager(tx, managerUserId);
  const code = nextAffiliateCode(tx, user.fullName);
  tx.run('INSERT INTO affiliate_profiles (user_id, code, manager_user_id, created_at) VALUES (?, ?, ?, ?)', user.id, code, managerUserId, now);
  recordAudit(tx, {
    actorUserId: actor.userId,
    action: 'affiliate.profile_created',
    entityType: 'user',
    entityId: user.id,
    after: { code, managerUserId },
    ip: actor.ip,
    requestId: actor.requestId,
    at: now,
  });
  return code;
}

/** Changes the manager of an existing profile (null removes it). Affects only orders created from now on. */
export function setManager(tx: Db, actor: ProfileActor, userId: string, managerUserId: string | null, now: number): void {
  const current = readProfile(tx, userId);
  if (!current || current.manager_user_id === managerUserId) return;
  if (managerUserId !== null) assertActiveSubManager(tx, managerUserId);
  tx.run('UPDATE affiliate_profiles SET manager_user_id = ? WHERE user_id = ?', managerUserId, userId);
  recordAudit(tx, {
    actorUserId: actor.userId,
    action: 'affiliate.manager_changed',
    entityType: 'user',
    entityId: userId,
    before: { managerUserId: current.manager_user_id },
    after: { managerUserId },
    ip: actor.ip,
    requestId: actor.requestId,
    at: now,
  });
}
