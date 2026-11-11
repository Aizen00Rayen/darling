import type { Me } from '@/shared';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/sqlite';
import { decryptSecret, DUMMY_HASH, verifyPassword } from '../security/crypto';
import { verifyTotp } from '../security/totp';
import { loadPrincipal, toMe } from './principal';
import { createSession, revokeSession } from './sessions';

export const MAX_FAILED_LOGINS = 10;
export const LOCK_MS = 15 * 60_000;
const USER_AGENT_MAX = 255;

type Reason = 'ok' | 'unknown_email' | 'bad_password' | 'locked' | 'inactive' | 'totp_required' | 'totp_invalid';

export interface LoginAttempt {
  /** Already trimmed and lower-cased by the request schema. */
  email: string;
  password: string;
  remember: boolean;
  totpCode: string | undefined;
  ip: string;
  userAgent: string | undefined;
  /** The session the client presented, if it was a live one: ended when this login succeeds. */
  presentedSessionId: string | undefined;
}

export type LoginOutcome =
  | { kind: 'ok'; me: Me; token: string; remember: boolean }
  | { kind: 'invalid_credentials' | 'totp_required' | 'totp_invalid' };

export interface LoginDeps {
  db: Db;
  clock: Clock;
  config: Pick<Config, 'encryptionKey'>;
  /** Test seam: runs right after the password has been verified. Never set in production. */
  onVerified?: () => Promise<void>;
}

function recordEvent(db: Db, a: LoginAttempt, userId: string | null, reason: Reason, at: number): void {
  db.run(
    `INSERT INTO login_events (user_id, email_tried, ip, user_agent, success, reason, at)
     VALUES (:userId, :email, :ip, :ua, :success, :reason, :at)`,
    {
      userId,
      email: a.email,
      ip: a.ip,
      ua: a.userAgent === undefined ? null : a.userAgent.slice(0, USER_AGENT_MAX),
      success: reason === 'ok',
      reason,
      at,
    },
  );
}

interface Reservation {
  /** The count including this attempt. */
  count: number;
  /** Set when this attempt was the tenth of its window: the lock it put in place itself. */
  ownLock: number | null;
}

/**
 * Claims one of the ten attempts an account gets per window, in ONE atomic statement and before the password
 * is looked at, so parallel guesses cannot all slip past a stale "not locked" read. Nothing is locked while the
 * password hash runs (the write lock is only held for this statement). A lapsed lock restarts the count from
 * zero. The tenth reservation puts the 15-minute lock in place straight away. Returns null when the account is
 * locked (nothing is changed then).
 */
function reserveAttempt(db: Db, userId: string, now: number): Reservation | null {
  const row = db.get<{ failed_logins: number; locked_until: number | null }>(
    `UPDATE users SET
       failed_logins = (CASE WHEN locked_until IS NOT NULL AND locked_until <= :now THEN 0 ELSE failed_logins END) + 1,
       locked_until = CASE
         WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= :now THEN 0 ELSE failed_logins END) + 1 >= :max THEN :lockUntil
         WHEN locked_until IS NOT NULL AND locked_until <= :now THEN NULL
         ELSE locked_until
       END
     WHERE id = :id AND (locked_until IS NULL OR locked_until <= :now)
     RETURNING failed_logins, locked_until`,
    { id: userId, now, max: MAX_FAILED_LOGINS, lockUntil: now + LOCK_MS },
  );
  if (!row) return null;
  return { count: row.failed_logins, ownLock: row.failed_logins >= MAX_FAILED_LOGINS ? row.locked_until : null };
}

/**
 * Gives back a reservation for an attempt that is not a failure (the right password, waiting for the 2FA code).
 * If this attempt had taken the tenth slot, the lock it set goes with it; a lock that someone else put in place
 * meanwhile is left alone.
 */
function releaseReservation(db: Db, userId: string, ownLock: number | null): void {
  db.run(
    `UPDATE users SET failed_logins = max(failed_logins - 1, 0), locked_until = NULL
     WHERE id = :id AND (locked_until IS NULL OR locked_until = :ownLock)`,
    { id: userId, ownLock },
  );
}

/**
 * Every wrong-credentials answer is the same to the caller (the route sends one body for all of them); `reason`
 * tells them apart only in login_events. Password verification runs for every known or unknown email, in every
 * state, so response time does not reveal whether an account exists, is locked or is suspended.
 *
 * Order for an active account: reserve an attempt (atomic, see reserveAttempt), verify, then settle. A wrong
 * password or wrong code keeps the reservation as the failed attempt. A missing code releases it. Success clears
 * the counters, but only if the account is not locked by then.
 */
export async function attemptLogin(deps: LoginDeps, a: LoginAttempt): Promise<LoginOutcome> {
  const { db, config, clock, onVerified } = deps;
  const now = clock.now();

  const user = db.get<{
    id: string;
    password_hash: string | null;
    status: string;
    totp_enabled: number;
    totp_secret_enc: string | null;
    totp_last_step: number | null;
  }>('SELECT id, password_hash, status, totp_enabled, totp_secret_enc, totp_last_step FROM users WHERE email = ?', a.email);

  const reject = (reason: Reason, userId: string | null) => {
    recordEvent(db, a, userId, reason, now);
    return { kind: 'invalid_credentials' } as const;
  };

  // Unknown, suspended and password-less accounts never touch a counter (but cost the same hash work).
  if (!user || user.status !== 'active' || user.password_hash === null) {
    await verifyPassword(user?.password_hash ?? (await DUMMY_HASH), a.password);
    await onVerified?.();
    return reject(user ? 'inactive' : 'unknown_email', user?.id ?? null);
  }

  const reservation = reserveAttempt(db, user.id, now);
  const passwordOk = await verifyPassword(user.password_hash, a.password);
  await onVerified?.();

  if (!reservation) return reject('locked', user.id);
  // The reservation already counted this attempt as a failure; nothing more to change.
  if (!passwordOk) return reject('bad_password', user.id);

  const { ownLock } = reservation;
  const rejectTotp = (): LoginOutcome => {
    recordEvent(db, a, user.id, 'totp_invalid', now);
    return { kind: 'totp_invalid' };
  };

  let totpStep: number | null = null;
  if (user.totp_enabled === 1) {
    if (a.totpCode === undefined) {
      // The password was right; asking for the code is not a failed attempt.
      db.transaction((tx) => {
        releaseReservation(tx, user.id, ownLock);
        recordEvent(tx, a, user.id, 'totp_required', now);
      });
      return { kind: 'totp_required' };
    }
    let secret: string | null = null;
    try {
      secret = user.totp_secret_enc === null ? null : decryptSecret(user.totp_secret_enc, config.encryptionKey);
    } catch {
      secret = null; // unreadable secret: fail closed
    }
    totpStep = secret === null ? null : verifyTotp(secret, a.totpCode, now, user.totp_last_step);
    if (totpStep === null) return rejectTotp();
  }

  type Settled = { token: string } | 'locked' | 'inactive' | 'totp_invalid';
  const step = totpStep;
  const settled = db.transaction((tx): Settled => {
    // One statement does all the gating: still active, not locked (apart from the lock this very attempt set
    // when it took the tenth slot) and, with 2FA, the step still ahead of the last one used. Of two parallel
    // logins with the same code only one matches. Zero rows means we lost a race.
    const claimed = tx.get<{ id: string }>(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = :now,
         totp_last_step = CASE WHEN :step IS NULL THEN totp_last_step ELSE :step END
       WHERE id = :id AND status = 'active'
         AND (locked_until IS NULL OR locked_until <= :now OR locked_until = :ownLock)
         AND (:step IS NULL OR totp_last_step IS NULL OR totp_last_step < :step)
       RETURNING id`,
      { id: user.id, now, step, ownLock },
    );
    if (!claimed) {
      const current = tx.get<{ status: string; locked_until: number | null }>('SELECT status, locked_until FROM users WHERE id = ?', user.id);
      if (!current || current.status !== 'active') return 'inactive';
      const lockedNow = current.locked_until !== null && current.locked_until > now && current.locked_until !== ownLock;
      if (lockedNow || step === null) return 'locked';
      return 'totp_invalid';
    }

    // Always a brand-new token: nothing the client sent is ever adopted as a session.
    const session = createSession(tx, clock, { userId: user.id, remember: a.remember, ip: a.ip, userAgent: a.userAgent ?? '', now });
    if (a.presentedSessionId !== undefined) revokeSession(tx, a.presentedSessionId, now);
    recordEvent(tx, a, user.id, 'ok', now);
    return { token: session.token };
  });
  if (settled === 'locked') return reject('locked', user.id);
  if (settled === 'inactive') return reject('inactive', user.id);
  if (settled === 'totp_invalid') return rejectTotp();

  const principal = loadPrincipal(db, user.id);
  if (!principal) return { kind: 'invalid_credentials' };
  return { kind: 'ok', me: toMe(principal), token: settled.token, remember: a.remember };
}

