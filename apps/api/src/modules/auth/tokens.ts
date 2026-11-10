import { and, eq, gt, isNull } from 'drizzle-orm';
import { ROLE_LABELS, type Role } from '@darling/shared';
import type { AppDeps } from '../../app';
import type { DbExecutor } from '../../db/client';
import { authTokens, users } from '../../db/schema';
import { hashToken, newToken } from '../../lib/crypto';
import type { Mail } from '../../mail/mailer';
import { inviteMail, resetMail } from '../../mail/templates';

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
export const RESET_TTL_MS = 30 * 60_000;

export type TokenType = 'invite' | 'password_reset';

const TTL_MS: Record<TokenType, number> = { invite: INVITE_TTL_MS, password_reset: RESET_TTL_MS };

/** Marks every unused token of `type` for the user as used. A token that is already used keeps its first `used_at`. */
export async function invalidateTokens(
  db: DbExecutor,
  p: { userId: string; type: TokenType; now: Date },
): Promise<void> {
  await db
    .update(authTokens)
    .set({ usedAt: p.now })
    .where(and(eq(authTokens.userId, p.userId), eq(authTokens.type, p.type), isNull(authTokens.usedAt)));
}

/**
 * Creates a single-use token and returns the raw value, which exists only in this return value (and,
 * from there, in a mail link): the database keeps its sha256. Earlier unused tokens of the same type
 * for the same user stop working in the same transaction, so only the newest link is ever live.
 */
export async function issueToken(
  db: DbExecutor,
  p: { userId: string; type: TokenType; now: Date },
): Promise<string> {
  const { token, hash } = newToken();
  await db.transaction(async (tx) => {
    await invalidateTokens(tx, p);
    await tx.insert(authTokens).values({
      userId: p.userId,
      type: p.type,
      tokenHash: hash,
      expiresAt: new Date(p.now.getTime() + TTL_MS[p.type]),
      createdAt: p.now,
    });
  });
  return token;
}

/**
 * Uses a token up with ONE conditional statement, so of any number of parallel attempts exactly one
 * wins and the others see nothing. Unknown, wrong type, already used and expired (the instant of
 * expiry included) all give the same `null`.
 */
export async function consumeToken(
  db: DbExecutor,
  p: { token: string; type: TokenType; now: Date },
): Promise<{ userId: string } | null> {
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: p.now })
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(p.token)),
        eq(authTokens.type, p.type),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, p.now),
      ),
    )
    .returning({ userId: authTokens.userId });
  return row ?? null;
}

/**
 * Reads a token WITHOUT using it up: the user it belongs to, if it is currently valid. Callers use
 * this to refuse early (and to check a password before a token is spent); consumption stays
 * `consumeToken`'s single statement.
 */
export async function peekToken(
  db: DbExecutor,
  p: { token: string; type: TokenType; now: Date },
): Promise<{ userId: string; email: string; fullName: string; status: string } | null> {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      fullName: users.fullName,
      status: users.status,
    })
    .from(authTokens)
    .innerJoin(users, eq(users.id, authTokens.userId))
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(p.token)),
        eq(authTokens.type, p.type),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, p.now),
      ),
    )
    .limit(1);
  return row ?? null;
}

type MailDeps = Pick<AppDeps, 'db' | 'mailer' | 'config' | 'clock'>;
type Recipient = { id: string; email: string; fullName: string; role: Role };

function linkFor(deps: Pick<MailDeps, 'config'>, path: string, token: string): string {
  return `${deps.config.appOrigin}${path}?token=${token}`;
}

/**
 * Issues an invitation token (older unused ones stop working) and builds the mail that carries it,
 * without sending it. Lets a caller issue the token inside its own transaction and send after commit.
 */
export async function issueInviteMail(
  deps: Pick<MailDeps, 'config' | 'clock'>,
  db: DbExecutor,
  user: Recipient,
): Promise<Mail> {
  const token = await issueToken(db, { userId: user.id, type: 'invite', now: deps.clock() });
  const mail = inviteMail({
    fullName: user.fullName,
    link: linkFor(deps, '/invitation', token),
    roleLabel: ROLE_LABELS[user.role],
  });
  return { to: user.email, ...mail };
}

/** Issues an invitation token and mails the activation link. Task 10 calls this after creating a user. */
export async function sendInvite(deps: MailDeps, user: Recipient): Promise<void> {
  await deps.mailer.send(await issueInviteMail(deps, deps.db, user));
}

/** Issues a reset token (the user's earlier reset links stop working) and mails the link. */
export async function sendPasswordReset(deps: MailDeps, user: Recipient): Promise<void> {
  const token = await issueToken(deps.db, { userId: user.id, type: 'password_reset', now: deps.clock() });
  const mail = resetMail({ fullName: user.fullName, link: linkFor(deps, '/reinitialiser', token) });
  await deps.mailer.send({ to: user.email, ...mail });
}
