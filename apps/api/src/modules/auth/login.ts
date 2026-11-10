import { and, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Me } from '@darling/shared';
import type { Config } from '../../config';
import type { Db, DbTx } from '../../db/client';
import { loginEvents, users } from '../../db/schema';
import { decryptSecret, DUMMY_HASH, verifyPassword } from '../../lib/crypto';
import { verifyTotp } from '../../lib/totp';
import { loadPrincipal, toMe } from './principal';
import { createSession, revokeSession } from './sessions';

export const MAX_FAILED_LOGINS = 10;
export const LOCK_MS = 15 * 60_000;
const USER_AGENT_MAX = 255;

type Reason =
  | 'ok'
  | 'unknown_email'
  | 'bad_password'
  | 'locked'
  | 'inactive'
  | 'totp_required'
  | 'totp_invalid';

export type LoginAttempt = {
  /** Already trimmed and lower-cased by the request schema. */
  email: string;
  password: string;
  remember: boolean;
  totpCode: string | undefined;
  ip: string;
  userAgent: string | undefined;
  /** The session cookie the client presented, if it was a live one: ended when this login succeeds. */
  presentedSessionId: string | undefined;
};

export type LoginOutcome =
  | { kind: 'ok'; me: Me; token: string; remember: boolean }
  | { kind: 'invalid_credentials' | 'totp_required' | 'totp_invalid' };

export type LoginDeps = {
  db: Db;
  config: Pick<Config, 'encryptionKey'>;
  clock: () => Date;
  /** Test seam: runs right after the password has been verified. Never set in production. */
  onVerified?: () => Promise<void>;
};

async function recordEvent(
  tx: DbTx,
  a: LoginAttempt,
  userId: string | null,
  reason: Reason,
  at: Date,
): Promise<void> {
  await tx.insert(loginEvents).values({
    userId,
    emailTried: a.email,
    ip: a.ip,
    userAgent: a.userAgent === undefined ? null : a.userAgent.slice(0, USER_AGENT_MAX),
    success: reason === 'ok',
    reason,
    at,
  });
}

type Reservation = {
  /** The count including this attempt. */
  count: number;
  /** Set when this attempt was the tenth of its window: the lock it put in place itself. */
  ownLock: Date | null;
};

/**
 * Claims one of the ten attempts an account gets per window, in ONE atomic statement and before
 * the password is looked at, so parallel guesses cannot all slip past a stale "not locked" read.
 * No lock is held while argon2 runs. A lapsed lock restarts the count from zero. The tenth
 * reservation puts the 15-minute lock in place straight away. Returns null when the account is
 * locked (nothing is changed then).
 */
async function reserveAttempt(db: Db, userId: string, now: Date): Promise<Reservation | null> {
  const lapsed = sql`(${users.lockedUntil} is not null and ${users.lockedUntil} <= ${now}::timestamptz)`;
  const base = sql`(case when ${lapsed} then 0 else ${users.failedLogins} end)`;
  const lockUntil = new Date(now.getTime() + LOCK_MS);
  const [row] = await db
    .update(users)
    .set({
      failedLogins: sql`${base} + 1`,
      lockedUntil: sql`case
        when ${base} + 1 >= ${MAX_FAILED_LOGINS} then ${lockUntil}::timestamptz
        when ${lapsed} then null
        else ${users.lockedUntil}
      end`,
    })
    .where(and(eq(users.id, userId), or(isNull(users.lockedUntil), lte(users.lockedUntil, now))))
    .returning({ failedLogins: users.failedLogins, lockedUntil: users.lockedUntil });
  if (!row) return null;
  return {
    count: row.failedLogins,
    ownLock: row.failedLogins >= MAX_FAILED_LOGINS ? row.lockedUntil : null,
  };
}

/**
 * Gives back a reservation for an attempt that is not a failure (the right password, waiting for
 * the 2FA code). If this attempt had taken the tenth slot, the lock it set goes with it; a lock
 * that someone else put in place meanwhile is left alone.
 */
async function releaseReservation(tx: DbTx, userId: string, ownLock: Date | null): Promise<void> {
  await tx
    .update(users)
    .set({ failedLogins: sql`greatest(${users.failedLogins} - 1, 0)`, lockedUntil: null })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.lockedUntil), ownLock ? eq(users.lockedUntil, ownLock) : undefined),
      ),
    );
}

/**
 * Every wrong-credentials answer is the same to the caller (the route sends one body for all of
 * them); `reason` tells them apart only in login_events. Password verification runs for every known
 * or unknown email, in every state, so response time does not reveal whether an account exists,
 * is locked or is suspended.
 *
 * Order for an active account: reserve an attempt (atomic, see reserveAttempt), verify, then
 * settle. A wrong password or wrong code keeps the reservation as the failed attempt. A missing
 * code releases it. Success clears the counters, but only if the account is not locked by then.
 */
export async function attemptLogin(deps: LoginDeps, a: LoginAttempt): Promise<LoginOutcome> {
  const { db, config, clock, onVerified } = deps;
  const now = clock();

  const [user] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      status: users.status,
      totpEnabled: users.totpEnabled,
      totpSecretEnc: users.totpSecretEnc,
      totpLastStep: users.totpLastStep,
    })
    .from(users)
    .where(eq(users.email, a.email))
    .limit(1);

  const reject = async (reason: Reason, userId: string | null) => {
    await db.transaction((tx) => recordEvent(tx, a, userId, reason, now));
    return { kind: 'invalid_credentials' } as const;
  };

  // Unknown, suspended and password-less accounts never touch a counter.
  if (!user || user.status !== 'active' || user.passwordHash === null) {
    await verifyPassword(user?.passwordHash ?? DUMMY_HASH, a.password);
    await onVerified?.();
    return reject(user ? 'inactive' : 'unknown_email', user?.id ?? null);
  }

  const reservation = await reserveAttempt(db, user.id, now);
  const passwordOk = await verifyPassword(user.passwordHash, a.password);
  await onVerified?.();

  if (!reservation) return reject('locked', user.id);
  // The reservation already counted this attempt as a failure; nothing more to change.
  if (!passwordOk) return reject('bad_password', user.id);

  const { ownLock } = reservation;
  const rejectTotp = async (): Promise<LoginOutcome> => {
    await db.transaction((tx) => recordEvent(tx, a, user.id, 'totp_invalid', now));
    return { kind: 'totp_invalid' };
  };

  let totpStep: number | null = null;
  if (user.totpEnabled) {
    if (a.totpCode === undefined) {
      // The password was right; asking for the code is not a failed attempt.
      await db.transaction(async (tx) => {
        await releaseReservation(tx, user.id, ownLock);
        await recordEvent(tx, a, user.id, 'totp_required', now);
      });
      return { kind: 'totp_required' };
    }
    let secret: string | null = null;
    try {
      secret = user.totpSecretEnc === null ? null : decryptSecret(user.totpSecretEnc, config.encryptionKey);
    } catch {
      secret = null; // unreadable secret: fail closed
    }
    totpStep = secret === null ? null : verifyTotp(secret, a.totpCode, now, user.totpLastStep);
    if (totpStep === null) return rejectTotp();
  }

  type Settled = { token: string } | 'locked' | 'totp_invalid';
  const settled = await db.transaction(async (tx): Promise<Settled> => {
    // One statement does all the gating: not locked (apart from the lock this very attempt set when
    // it took the tenth slot), and, with 2FA, the step still ahead of the last one used. Of two
    // parallel logins with the same code only one matches. Zero rows means we lost a race.
    const step = totpStep;
    const claimed = await tx
      .update(users)
      .set({
        failedLogins: 0,
        lockedUntil: null,
        lastLoginAt: now,
        ...(step === null ? {} : { totpLastStep: step }),
      })
      .where(
        and(
          eq(users.id, user.id),
          or(isNull(users.lockedUntil), lte(users.lockedUntil, now), ownLock ? eq(users.lockedUntil, ownLock) : undefined),
          step === null ? undefined : or(isNull(users.totpLastStep), lt(users.totpLastStep, step)),
        ),
      )
      .returning({ id: users.id });

    if (claimed.length === 0) {
      if (step === null) return 'locked';
      const [current] = await tx.select({ lockedUntil: users.lockedUntil }).from(users).where(eq(users.id, user.id));
      const lockedNow =
        current?.lockedUntil != null &&
        current.lockedUntil > now &&
        current.lockedUntil.getTime() !== ownLock?.getTime();
      return lockedNow ? 'locked' : 'totp_invalid';
    }

    // Always a brand-new token: nothing the client sent is ever adopted as a session.
    const session = await createSession(tx, {
      userId: user.id,
      remember: a.remember,
      ip: a.ip,
      userAgent: a.userAgent ?? '',
      now,
    });
    if (a.presentedSessionId !== undefined) await revokeSession(tx, a.presentedSessionId, now);
    await recordEvent(tx, a, user.id, 'ok', now);
    return { token: session.token };
  });
  if (settled === 'locked') return reject('locked', user.id);
  if (settled === 'totp_invalid') return rejectTotp();

  const principal = await loadPrincipal(db, user.id);
  if (!principal) return { kind: 'invalid_credentials' };
  return { kind: 'ok', me: toMe(principal), token: settled.token, remember: a.remember };
}
