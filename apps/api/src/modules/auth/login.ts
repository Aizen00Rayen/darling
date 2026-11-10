import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
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

export type LoginDeps = { db: Db; config: Pick<Config, 'encryptionKey'>; clock: () => Date };

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

/**
 * Counts one failed attempt, atomically (one UPDATE, so parallel guesses cannot undercount) and
 * locks the account when the count reaches the limit. A lock that has already lapsed starts a fresh
 * count: the user gets a full set of attempts again, not a one-strike relock.
 */
async function countFailure(tx: DbTx, userId: string, now: Date): Promise<void> {
  const lapsed = sql`(${users.lockedUntil} is not null and ${users.lockedUntil} <= ${now}::timestamptz)`;
  const next = sql`(case when ${lapsed} then 1 else ${users.failedLogins} + 1 end)`;
  const lockUntil = new Date(now.getTime() + LOCK_MS);
  await tx
    .update(users)
    .set({
      failedLogins: next,
      lockedUntil: sql`case
        when ${next} >= ${MAX_FAILED_LOGINS} then ${lockUntil}::timestamptz
        when ${lapsed} then null
        else ${users.lockedUntil}
      end`,
    })
    .where(eq(users.id, userId));
}

/**
 * Every wrong-credentials answer is the same to the caller (the route sends one body for all of
 * them); `reason` tells them apart only in login_events. Password verification runs for every known
 * or unknown email, in every state, so response time does not reveal whether an account exists,
 * is locked or is suspended.
 */
export async function attemptLogin(deps: LoginDeps, a: LoginAttempt): Promise<LoginOutcome> {
  const { db, config, clock } = deps;

  const [user] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      status: users.status,
      lockedUntil: users.lockedUntil,
      totpEnabled: users.totpEnabled,
      totpSecretEnc: users.totpSecretEnc,
      totpLastStep: users.totpLastStep,
    })
    .from(users)
    .where(eq(users.email, a.email))
    .limit(1);

  const passwordOk = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, a.password);
  const now = clock();

  const reject = async (reason: Reason, userId: string | null, countAsFailure: boolean) => {
    await db.transaction(async (tx) => {
      if (countAsFailure && userId !== null) await countFailure(tx, userId, now);
      await recordEvent(tx, a, userId, reason, now);
    });
    return { kind: 'invalid_credentials' } as const;
  };

  if (!user) return reject('unknown_email', null, false);
  if (user.status !== 'active' || user.passwordHash === null) return reject('inactive', user.id, false);
  if (user.lockedUntil !== null && user.lockedUntil > now) return reject('locked', user.id, false);
  if (!passwordOk) return reject('bad_password', user.id, true);

  const rejectTotp = async (): Promise<LoginOutcome> => {
    await db.transaction(async (tx) => {
      await countFailure(tx, user.id, now);
      await recordEvent(tx, a, user.id, 'totp_invalid', now);
    });
    return { kind: 'totp_invalid' };
  };

  let totpStep: number | null = null;
  if (user.totpEnabled) {
    if (a.totpCode === undefined) {
      // The password was right; asking for the code is not a failed attempt.
      await db.transaction((tx) => recordEvent(tx, a, user.id, 'totp_required', now));
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

  const token = await db.transaction(async (tx): Promise<string | null> => {
    const reset = { failedLogins: 0, lockedUntil: null, lastLoginAt: now };
    if (totpStep !== null) {
      // The step must advance, in the same statement that logs the user in: of two parallel logins
      // carrying the same code only one UPDATE matches, the other updates nothing and is refused.
      const step = totpStep;
      const claimed = await tx
        .update(users)
        .set({ ...reset, totpLastStep: step })
        .where(and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
        .returning({ id: users.id });
      if (claimed.length === 0) return null;
    } else {
      await tx.update(users).set(reset).where(eq(users.id, user.id));
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
    return session.token;
  });
  if (token === null) return rejectTotp();

  const principal = await loadPrincipal(db, user.id);
  if (!principal) return { kind: 'invalid_credentials' };
  return { kind: 'ok', me: toMe(principal), token, remember: a.remember };
}
