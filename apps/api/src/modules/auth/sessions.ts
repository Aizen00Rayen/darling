import { and, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../db/client';
import { sessions } from '../../db/schema';
import { hashToken, newToken } from '../../lib/crypto';

export const IDLE_MS = 12 * 3600_000;
export const ABSOLUTE_MS = 24 * 3600_000;
export const REMEMBER_MS = 30 * 24 * 3600_000;

/** A session's last_seen_at is refreshed at most this often, so reads do not become writes. */
const TOUCH_INTERVAL_MS = 60_000;
const USER_AGENT_MAX = 255;

export type NewSession = { userId: string; remember: boolean; ip: string; userAgent: string; now: Date };

/**
 * Starts a session and returns the raw token (for the cookie; it is shown once and never stored)
 * with its absolute expiry. Only the sha256 of the token reaches the database.
 */
export async function createSession(
  db: DbExecutor,
  p: NewSession,
): Promise<{ token: string; expiresAt: Date }> {
  const { token, hash } = newToken();
  const expiresAt = new Date(p.now.getTime() + (p.remember ? REMEMBER_MS : ABSOLUTE_MS));
  await db.insert(sessions).values({
    tokenHash: hash,
    userId: p.userId,
    ip: p.ip,
    userAgent: p.userAgent.slice(0, USER_AGENT_MAX),
    remember: p.remember,
    createdAt: p.now,
    lastSeenAt: p.now,
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * The live session for a cookie token, or null when it is unknown, revoked, past its absolute
 * expiry or idle for 12 h. Activity extends only the idle window, never the absolute expiry. A
 * session that is no longer valid is never touched, so it cannot be revived.
 */
export async function resolveSession(
  db: DbExecutor,
  token: string,
  now: Date,
): Promise<{ sessionId: string; userId: string } | null> {
  if (token === '') return null;
  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);
  if (!row || row.revokedAt !== null) return null;

  const at = now.getTime();
  if (at >= row.expiresAt.getTime()) return null;
  const idleFor = at - row.lastSeenAt.getTime();
  if (idleFor >= IDLE_MS) return null;

  if (idleFor >= TOUCH_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(and(eq(sessions.id, row.id), lt(sessions.lastSeenAt, now)));
  }
  return { sessionId: row.id, userId: row.userId };
}

/**
 * Ends one session. An already revoked session keeps its first revocation time. Callers pass the
 * injected clock's `now`; without it the database clock stamps the row.
 */
export async function revokeSession(db: DbExecutor, sessionId: string, now?: Date): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now ?? sql`now()` })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Ends every session of a user, optionally sparing the one the caller is using. */
export async function revokeUserSessions(
  db: DbExecutor,
  userId: string,
  exceptSessionId?: string,
  now?: Date,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now ?? sql`now()` })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        ...(exceptSessionId === undefined ? [] : [ne(sessions.id, exceptSessionId)]),
      ),
    );
}
