import { passwordProblem } from '@/shared';
import type { Clock } from '../clock';
import type { Db } from '../db/sqlite';
import { recordAudit } from '../audit';
import { hashPassword } from '../security/crypto';
import { revokeUserSessions } from './sessions';
import { consumeToken, invalidateTokens, peekToken } from './tokens';

interface Service {
  db: Db;
  clock: Clock;
  /** Test seam: runs once the token and the password have been checked, just before the transaction. */
  afterChecks?: () => Promise<void>;
}

interface Request {
  token: string;
  password: string;
  ip: string;
  requestId: string;
}

export type RecoveryOutcome = { kind: 'ok' } | { kind: 'invalid_token' } | { kind: 'validation'; errors: Record<string, string> };

/** Thrown inside a transaction to roll it back, token consumption included. */
class Refused extends Error {}

/**
 * Sets the first password of an invited user. The token is checked without being spent, then the password
 * policy, so a weak password does not burn the link. The token is finally spent in the same transaction that
 * activates the account, and only an `invited` user can be activated: if anything refuses, the whole transaction
 * rolls back and the token stays usable.
 */
export async function acceptInvite(deps: Service, req: Request): Promise<RecoveryOutcome> {
  const { db, clock } = deps;
  const now = clock.now();
  const found = peekToken(db, { token: req.token, type: 'invite', now });
  if (!found || found.status !== 'invited') return { kind: 'invalid_token' };

  const problem = passwordProblem(req.password);
  if (problem !== null) return { kind: 'validation', errors: { password: problem } };
  const passwordHash = await hashPassword(req.password);
  await deps.afterChecks?.();

  try {
    db.transaction((tx) => {
      const consumed = consumeToken(tx, { token: req.token, type: 'invite', now });
      if (!consumed) throw new Refused();
      const activated = tx.get<{ id: string }>(
        `UPDATE users SET password_hash = :hash, status = 'active', failed_logins = 0, locked_until = NULL, updated_at = :now
         WHERE id = :id AND status = 'invited' RETURNING id`,
        { hash: passwordHash, now, id: consumed.userId },
      );
      if (!activated) throw new Refused();
      recordAudit(tx, {
        actorUserId: activated.id,
        action: 'auth.invite_accepted',
        entityType: 'user',
        entityId: activated.id,
        before: { status: 'invited' },
        after: { status: 'active' },
        ip: req.ip,
        requestId: req.requestId,
        at: now,
      });
    });
  } catch (err) {
    if (err instanceof Refused) return { kind: 'invalid_token' };
    throw err;
  }
  return { kind: 'ok' };
}

/**
 * Replaces the password of an ACTIVE user from a reset link, ends all their sessions and clears a lockout. Same
 * shape as `acceptInvite`; a user suspended after the mail was sent is refused and stays suspended. Two-factor is
 * left exactly as it was.
 */
export async function resetPassword(deps: Service, req: Request): Promise<RecoveryOutcome> {
  const { db, clock } = deps;
  const now = clock.now();
  const found = peekToken(db, { token: req.token, type: 'password_reset', now });
  if (!found || found.status !== 'active') return { kind: 'invalid_token' };

  const problem = passwordProblem(req.password);
  if (problem !== null) return { kind: 'validation', errors: { password: problem } };
  const passwordHash = await hashPassword(req.password);
  await deps.afterChecks?.();

  try {
    db.transaction((tx) => {
      const consumed = consumeToken(tx, { token: req.token, type: 'password_reset', now });
      if (!consumed) throw new Refused();
      const updated = tx.get<{ id: string }>(
        `UPDATE users SET password_hash = :hash, failed_logins = 0, locked_until = NULL, updated_at = :now
         WHERE id = :id AND status = 'active' RETURNING id`,
        { hash: passwordHash, now, id: consumed.userId },
      );
      if (!updated) throw new Refused();
      revokeUserSessions(tx, updated.id, undefined, now);
      invalidateTokens(tx, { userId: updated.id, type: 'password_reset', now });
      recordAudit(tx, {
        actorUserId: updated.id,
        action: 'auth.password_reset',
        entityType: 'user',
        entityId: updated.id,
        after: { passwordReset: true },
        ip: req.ip,
        requestId: req.requestId,
        at: now,
      });
    });
  } catch (err) {
    if (err instanceof Refused) return { kind: 'invalid_token' };
    throw err;
  }
  return { kind: 'ok' };
}

/** The name and email an invitation link belongs to, if the link is currently valid. Does not consume it. */
export function lookupInvitation(deps: { db: Db; clock: Clock }, token: string): { email: string; fullName: string } | null {
  const found = peekToken(deps.db, { token, type: 'invite', now: deps.clock.now() });
  if (!found || found.status !== 'invited') return null;
  return { email: found.email, fullName: found.fullName };
}
