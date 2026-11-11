import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/sqlite';
import { recordAudit } from '../audit';
import { decryptSecret, DUMMY_HASH, encryptSecret, verifyPassword } from '../security/crypto';
import { newTotpSecret, totpUri, verifyTotp } from '../security/totp';
import { getSetting } from '../settings';

/** Who is asking, as the audit trail needs it. */
export interface Actor {
  userId: string;
  sessionId: string;
  role: string;
  ip: string;
  requestId: string;
}

export interface SecurityDeps {
  db: Db;
  clock: Clock;
  config: Pick<Config, 'encryptionKey'>;
}

export type Outcome<T extends string> = { kind: 'ok' } | { kind: T };

interface UserSecurity {
  email: string;
  password_hash: string | null;
  totp_enabled: number;
  totp_secret_enc: string | null;
  totp_last_step: number | null;
}

export function loadUserSecurity(db: Db, userId: string): UserSecurity | null {
  return (
    db.get<UserSecurity>('SELECT email, password_hash, totp_enabled, totp_secret_enc, totp_last_step FROM users WHERE id = ?', userId) ?? null
  );
}

function readSecret(enc: string | null, config: Pick<Config, 'encryptionKey'>): string | null {
  if (enc === null) return null;
  try {
    return decryptSecret(enc, config.encryptionKey);
  } catch {
    return null; // unreadable secret: fail closed
  }
}

/**
 * Checks `password` against the user's real hash. A user without a hash (not possible for an authenticated user,
 * but never assumed) is checked against the dummy hash so the cost is the same, and never passes.
 */
export async function passwordMatches(hash: string | null, password: string): Promise<boolean> {
  const ok = await verifyPassword(hash ?? (await DUMMY_HASH), password);
  return hash !== null && ok;
}

function isTotpEnabled(db: Db, userId: string): boolean {
  return db.get<{ totp_enabled: number }>('SELECT totp_enabled FROM users WHERE id = ?', userId)?.totp_enabled === 1;
}

/**
 * Starts (or restarts) enrolment: a fresh secret each time, stored encrypted and not yet active. The plaintext
 * leaves only in this return value. Refused once 2FA is on.
 */
export function startTwoFactorSetup(
  deps: SecurityDeps,
  actor: Actor,
): { kind: 'ok'; secret: string; otpauthUrl: string } | { kind: 'already_enabled' } | { kind: 'unauthenticated' } {
  const { db, config, clock } = deps;
  const user = loadUserSecurity(db, actor.userId);
  if (!user) return { kind: 'unauthenticated' };
  if (user.totp_enabled === 1) return { kind: 'already_enabled' };

  const secret = newTotpSecret();
  // The guard keeps a setup that races with a successful enable from replacing the live secret.
  const updated = db.get<{ id: string }>(
    `UPDATE users SET totp_secret_enc = :enc, totp_last_step = NULL, updated_at = :now
     WHERE id = :id AND totp_enabled = 0 RETURNING id`,
    { enc: encryptSecret(secret, config.encryptionKey), now: clock.now(), id: actor.userId },
  );
  if (!updated) return { kind: 'already_enabled' };
  return { kind: 'ok', secret, otpauthUrl: totpUri(secret, user.email) };
}

/**
 * Turns 2FA on when the current password is right and `code` matches the pending secret. The matched step is
 * stored in the same statement, so the code cannot also be used at login; the statement is guarded on the secret
 * that was verified, so a parallel setup or enable cannot make a different secret go live.
 */
export async function enableTwoFactor(
  deps: SecurityDeps,
  actor: Actor,
  input: { password: string; code: string },
): Promise<Outcome<'invalid_credentials' | 'already_enabled' | 'no_pending_setup' | 'totp_invalid' | 'unauthenticated'>> {
  const { db, clock } = deps;
  const now = clock.now();
  const user = loadUserSecurity(db, actor.userId);
  if (!user) return { kind: 'unauthenticated' };

  // Re-authentication comes first: a session cookie alone must not be able to enrol an authenticator.
  if (!(await passwordMatches(user.password_hash, input.password))) return { kind: 'invalid_credentials' };

  if (user.totp_enabled === 1) return { kind: 'already_enabled' };
  if (user.totp_secret_enc === null) return { kind: 'no_pending_setup' };

  const secret = readSecret(user.totp_secret_enc, deps.config);
  const step = secret === null ? null : verifyTotp(secret, input.code, now, user.totp_last_step);
  if (step === null) return { kind: 'totp_invalid' };

  return db.transaction((tx) => {
    const claimed = tx.get<{ id: string }>(
      `UPDATE users SET totp_enabled = 1, totp_last_step = :step, updated_at = :now
       WHERE id = :id AND totp_enabled = 0 AND totp_secret_enc = :enc AND (totp_last_step IS NULL OR totp_last_step < :step)
       RETURNING id`,
      { step, now, id: actor.userId, enc: user.totp_secret_enc },
    );
    if (!claimed) return { kind: isTotpEnabled(tx, actor.userId) ? 'already_enabled' : 'totp_invalid' } as const;
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'auth.2fa_enabled',
      entityType: 'user',
      entityId: actor.userId,
      before: { twoFactorEnabled: false },
      after: { twoFactorEnabled: true },
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    return { kind: 'ok' } as const;
  });
}

/**
 * Turns 2FA off. A Super Manager cannot while the requirement setting is on; that answer comes first, before any
 * credential is looked at, so it does not depend on them. Otherwise both the current password and a code that is
 * newer than the last step used (login or enable) are needed.
 */
export async function disableTwoFactor(
  deps: SecurityDeps,
  actor: Actor,
  input: { password: string; code: string },
): Promise<Outcome<'role_required' | 'not_enabled' | 'invalid_credentials' | 'totp_invalid' | 'unauthenticated'>> {
  const { db, clock } = deps;
  const now = clock.now();

  if (actor.role === 'super_manager' && getSetting(db, 'security.require_2fa_super_managers')) return { kind: 'role_required' };
  const user = loadUserSecurity(db, actor.userId);
  if (!user) return { kind: 'unauthenticated' };
  if (user.totp_enabled !== 1) return { kind: 'not_enabled' };

  if (!(await passwordMatches(user.password_hash, input.password))) return { kind: 'invalid_credentials' };

  const secret = readSecret(user.totp_secret_enc, deps.config);
  const step = secret === null ? null : verifyTotp(secret, input.code, now, user.totp_last_step);
  if (step === null) return { kind: 'totp_invalid' };

  return db.transaction((tx) => {
    const claimed = tx.get<{ id: string }>(
      `UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL, updated_at = :now
       WHERE id = :id AND totp_enabled = 1 AND totp_secret_enc = :enc AND (totp_last_step IS NULL OR totp_last_step < :step)
       RETURNING id`,
      { now, id: actor.userId, enc: user.totp_secret_enc, step },
    );
    if (!claimed) return { kind: isTotpEnabled(tx, actor.userId) ? 'totp_invalid' : 'not_enabled' } as const;
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'auth.2fa_disabled',
      entityType: 'user',
      entityId: actor.userId,
      before: { twoFactorEnabled: true },
      after: { twoFactorEnabled: false },
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    return { kind: 'ok' } as const;
  });
}
