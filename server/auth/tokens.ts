import { ROLE_LABELS, type Role } from '@/shared';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/sqlite';
import { newId } from '../ids';
import type { Mail } from '../mail/mailer';
import { inviteMail, resetMail } from '../mail/templates';
import { hashToken, newToken } from '../security/crypto';

export const INVITE_TTL_MS = 7 * 24 * 3_600_000;
export const RESET_TTL_MS = 30 * 60_000;

export type TokenType = 'invite' | 'password_reset';
const TTL_MS: Record<TokenType, number> = { invite: INVITE_TTL_MS, password_reset: RESET_TTL_MS };

/** Marks every unused token of `type` for the user as used. A token that is already used keeps its first `used_at`. */
export function invalidateTokens(db: Db, p: { userId: string; type: TokenType; now: number }): void {
  db.run('UPDATE auth_tokens SET used_at = :now WHERE user_id = :userId AND type = :type AND used_at IS NULL', p);
}

/**
 * Creates a single-use token and returns the raw value, which exists only in this return value (and, from there,
 * in a mail link): the database keeps its sha256. Earlier unused tokens of the same type for the same user stop
 * working in the same transaction, so only the newest link is ever live.
 */
export function issueToken(db: Db, clock: Clock, p: { userId: string; type: TokenType }): string {
  const now = clock.now();
  const { token, hash } = newToken();
  db.transaction((tx) => {
    invalidateTokens(tx, { userId: p.userId, type: p.type, now });
    tx.run(
      `INSERT INTO auth_tokens (id, user_id, type, token_hash, expires_at, created_at)
       VALUES (:id, :userId, :type, :hash, :expiresAt, :now)`,
      { id: newId(clock), userId: p.userId, type: p.type, hash, expiresAt: now + TTL_MS[p.type], now },
    );
  });
  return token;
}

/**
 * Uses a token up with ONE conditional statement, so of any number of parallel attempts exactly one wins and the
 * others see nothing. Unknown, wrong type, already used and expired (the instant of expiry included) all give the
 * same `null`.
 */
export function consumeToken(db: Db, p: { token: string; type: TokenType; now: number }): { userId: string } | null {
  const row = db.get<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = :now
     WHERE token_hash = :hash AND type = :type AND used_at IS NULL AND expires_at > :now
     RETURNING user_id`,
    { now: p.now, hash: hashToken(p.token), type: p.type },
  );
  return row ? { userId: row.user_id } : null;
}

/**
 * Reads a token WITHOUT using it up: the user it belongs to, if it is currently valid. Callers use this to refuse
 * early (and to check a password before a token is spent); consumption stays `consumeToken`'s single statement.
 */
export function peekToken(
  db: Db,
  p: { token: string; type: TokenType; now: number },
): { userId: string; email: string; fullName: string; status: string } | null {
  const row = db.get<{ id: string; email: string; full_name: string; status: string }>(
    `SELECT u.id, u.email, u.full_name, u.status
     FROM auth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = :hash AND t.type = :type AND t.used_at IS NULL AND t.expires_at > :now`,
    { hash: hashToken(p.token), type: p.type, now: p.now },
  );
  return row ? { userId: row.id, email: row.email, fullName: row.full_name, status: row.status } : null;
}

export interface Recipient {
  id: string;
  email: string;
  fullName: string;
  role: Role;
}

/** The absolute link a mailed token travels in. */
export function linkFor(config: Pick<Config, 'appOrigin'>, path: string, token: string): string {
  return `${config.appOrigin}${path}?token=${token}`;
}

/**
 * Issues an invitation token (older unused ones stop working) and builds the mail that carries it, without
 * sending it, so a caller can issue the token inside its own transaction and send after commit.
 */
export function issueInviteMail(deps: { config: Pick<Config, 'appOrigin'>; clock: Clock }, db: Db, user: Recipient): Mail {
  const token = issueToken(db, deps.clock, { userId: user.id, type: 'invite' });
  return { to: user.email, ...inviteMail({ fullName: user.fullName, link: linkFor(deps.config, '/invitation', token), roleLabel: ROLE_LABELS[user.role] }) };
}

/** Issues a reset token (the user's earlier reset links stop working) and builds the mail, without sending it. */
export function issueResetMail(deps: { config: Pick<Config, 'appOrigin'>; clock: Clock }, db: Db, user: Recipient): Mail {
  const token = issueToken(db, deps.clock, { userId: user.id, type: 'password_reset' });
  return { to: user.email, ...resetMail({ fullName: user.fullName, link: linkFor(deps.config, '/reinitialiser', token) }) };
}
