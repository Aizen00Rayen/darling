import { passwordProblem } from '@/shared';
import { recordAudit } from '../audit';
import { hashPassword } from '../security/crypto';
import { revokeUserSessions } from './sessions';
import { invalidateTokens } from './tokens';
import { loadUserSecurity, passwordMatches, type Actor, type Outcome, type SecurityDeps } from './two-factor';

const SAME_PASSWORD_MESSAGE = 'Le nouveau mot de passe doit être différent de l’ancien.';

export type ChangePasswordOutcome = Outcome<'invalid_credentials' | 'conflict' | 'unauthenticated'> | { kind: 'validation'; errors: Record<string, string> };

/**
 * Replaces the password after checking the current one, ends every OTHER session of the user (keeping the
 * caller's) and voids their pending reset links. The hash is swapped only if it is still the one that was
 * verified, so two parallel changes cannot both win.
 */
export async function changePassword(
  deps: SecurityDeps,
  actor: Actor,
  input: { currentPassword: string; newPassword: string },
): Promise<ChangePasswordOutcome> {
  const { db, clock } = deps;
  const now = clock.now();
  const user = loadUserSecurity(db, actor.userId);
  if (!user) return { kind: 'unauthenticated' };

  if (!(await passwordMatches(user.password_hash, input.currentPassword))) return { kind: 'invalid_credentials' };
  const problem = passwordProblem(input.newPassword);
  if (problem !== null) return { kind: 'validation', errors: { newPassword: problem } };
  if (input.newPassword === input.currentPassword) return { kind: 'validation', errors: { newPassword: SAME_PASSWORD_MESSAGE } };

  const newHash = await hashPassword(input.newPassword);
  return db.transaction((tx) => {
    const claimed = tx.get<{ id: string }>(
      'UPDATE users SET password_hash = :hash, updated_at = :now WHERE id = :id AND password_hash = :old RETURNING id',
      { hash: newHash, now, id: actor.userId, old: user.password_hash as string },
    );
    if (!claimed) return { kind: 'conflict' } as const;
    revokeUserSessions(tx, actor.userId, actor.sessionId, now);
    // A reset link requested before this change must not be able to undo it.
    invalidateTokens(tx, { userId: actor.userId, type: 'password_reset', now });
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: actor.userId,
      after: { passwordChanged: true },
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    return { kind: 'ok' } as const;
  });
}
