import type { Clock } from '../clock';
import type { Db } from '../db/sqlite';
import { newId } from '../ids';
import { hashToken, newToken } from '../security/crypto';

export const IDLE_MS = 12 * 3_600_000;
export const ABSOLUTE_MS = 24 * 3_600_000;
export const REMEMBER_MS = 30 * 24 * 3_600_000;

/** A session's last_seen_at is refreshed at most this often, so reads do not become writes. */
const TOUCH_INTERVAL_MS = 60_000;
const USER_AGENT_MAX = 255;

export interface NewSession {
  userId: string;
  remember: boolean;
  ip: string;
  userAgent: string;
  now: number;
}

/**
 * Starts a session and returns the raw token (for the cookie; shown once, never stored) with its absolute
 * expiry. Only the sha256 of the token reaches the database. The token is always freshly generated: nothing a
 * client sent is ever adopted as a session (fixation).
 */
export function createSession(db: Db, clock: Clock, p: NewSession): { token: string; expiresAt: number } {
  const { token, hash } = newToken();
  const expiresAt = p.now + (p.remember ? REMEMBER_MS : ABSOLUTE_MS);
  db.run(
    `INSERT INTO sessions (id, token_hash, user_id, ip, user_agent, remember, created_at, last_seen_at, expires_at)
     VALUES (:id, :hash, :userId, :ip, :ua, :remember, :now, :now, :expiresAt)`,
    {
      id: newId(clock),
      hash,
      userId: p.userId,
      ip: p.ip,
      ua: p.userAgent.slice(0, USER_AGENT_MAX),
      remember: p.remember,
      now: p.now,
      expiresAt,
    },
  );
  return { token, expiresAt };
}

/**
 * The live session for a cookie token, or null when it is unknown, revoked, past its absolute expiry or idle
 * for 12 h. Activity extends only the idle window, never the absolute expiry. A session that is no longer
 * valid is never touched, so it cannot be revived.
 */
export function resolveSession(db: Db, token: string, now: number): { sessionId: string; userId: string } | null {
  if (token === '') return null;
  const row = db.get<{ id: string; user_id: string; last_seen_at: number; expires_at: number; revoked_at: number | null }>(
    'SELECT id, user_id, last_seen_at, expires_at, revoked_at FROM sessions WHERE token_hash = ?',
    hashToken(token),
  );
  if (!row || row.revoked_at !== null) return null;
  if (now >= row.expires_at) return null;
  const idleFor = now - row.last_seen_at;
  if (idleFor >= IDLE_MS) return null;
  if (idleFor >= TOUCH_INTERVAL_MS) {
    db.run('UPDATE sessions SET last_seen_at = :now WHERE id = :id AND last_seen_at < :now AND revoked_at IS NULL', { now, id: row.id });
  }
  return { sessionId: row.id, userId: row.user_id };
}

/** Ends one session. An already revoked session keeps its first revocation time. */
export function revokeSession(db: Db, sessionId: string, now: number): void {
  db.run('UPDATE sessions SET revoked_at = :now WHERE id = :id AND revoked_at IS NULL', { now, id: sessionId });
}

/** Ends every session of a user, optionally sparing the one the caller is using. */
export function revokeUserSessions(db: Db, userId: string, exceptSessionId: string | undefined, now: number): void {
  db.run(
    `UPDATE sessions SET revoked_at = :now
     WHERE user_id = :userId AND revoked_at IS NULL AND (:except IS NULL OR id <> :except)`,
    { now, userId, except: exceptSessionId ?? null },
  );
}
