import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessions } from '../../db/schema';
import { hashToken } from '../../lib/crypto';
import { createTestContext, csrfHeaders, login, seedUser, type TestContext } from '../../../test/context';
import {
  ABSOLUTE_MS,
  IDLE_MS,
  REMEMBER_MS,
  createSession,
  resolveSession,
  revokeSession,
  revokeUserSessions,
} from './sessions';

const HOUR = 3_600_000;
const MINUTE = 60_000;

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

async function newSession(opts: { remember?: boolean; userAgent?: string } = {}) {
  const user = await seedUser(ctx, { role: 'affiliate' });
  const created = await createSession(ctx.db, {
    userId: user.id,
    remember: opts.remember ?? false,
    ip: '203.0.113.1',
    userAgent: opts.userAgent ?? 'Vitest/1',
    now: ctx.clock.now,
  });
  return { user, ...created };
}

async function row(token: string) {
  const [found] = await ctx.db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  if (!found) throw new Error('session row not found');
  return found;
}

describe('constants', () => {
  it('are 12 h, 24 h and 30 d', () => {
    expect(IDLE_MS).toBe(12 * HOUR);
    expect(ABSOLUTE_MS).toBe(24 * HOUR);
    expect(REMEMBER_MS).toBe(30 * 24 * HOUR);
  });
});

describe('createSession', () => {
  it('stores only the hash of a 256-bit token and expires after 24 h', async () => {
    const { token, expiresAt, user } = await newSession();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBe(ctx.clock.now.getTime() + ABSOLUTE_MS);
    const stored = await row(token);
    expect(stored.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored).toMatchObject({ userId: user.id, remember: false, ip: '203.0.113.1', revokedAt: null });
    expect(stored.createdAt.getTime()).toBe(ctx.clock.now.getTime());
    expect(stored.lastSeenAt.getTime()).toBe(ctx.clock.now.getTime());
    expect(stored.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('expires a remembered session after 30 days and gives every session its own token', async () => {
    const a = await newSession({ remember: true });
    const b = await newSession();
    expect(a.expiresAt.getTime()).toBe(ctx.clock.now.getTime() + REMEMBER_MS);
    expect(a.token).not.toBe(b.token);
    expect((await row(a.token)).remember).toBe(true);
  });

  it('truncates the user agent to 255 characters', async () => {
    const { token } = await newSession({ userAgent: 'U'.repeat(400) });
    expect((await row(token)).userAgent).toBe('U'.repeat(255));
  });
});

describe('resolveSession', () => {
  it('resolves a live session and refuses unknown or empty tokens', async () => {
    const { token, user } = await newSession();
    const ok = await resolveSession(ctx.db, token, ctx.clock.now);
    expect(ok).toEqual({ sessionId: (await row(token)).id, userId: user.id });
    expect(await resolveSession(ctx.db, 'x'.repeat(43), ctx.clock.now)).toBeNull();
    expect(await resolveSession(ctx.db, '', ctx.clock.now)).toBeNull();
  });

  it('expires after 12 h without activity', async () => {
    const { token } = await newSession();
    const justBefore = new Date(ctx.clock.now.getTime() + IDLE_MS - 1);
    expect(await resolveSession(ctx.db, token, justBefore)).not.toBeNull();
    // That successful resolve counted as activity; measure from there.
    const idleFrom = (await row(token)).lastSeenAt;
    expect(await resolveSession(ctx.db, token, new Date(idleFrom.getTime() + IDLE_MS))).toBeNull();
  });

  it('expires 24 h after login even when the user stays active', async () => {
    const { token } = await newSession();
    for (let hours = 11; hours <= 22; hours += 11) {
      expect(await resolveSession(ctx.db, token, new Date(ctx.clock.now.getTime() + hours * HOUR))).not.toBeNull();
    }
    expect(await resolveSession(ctx.db, token, new Date(ctx.clock.now.getTime() + 24 * HOUR - 1))).not.toBeNull();
    expect(await resolveSession(ctx.db, token, new Date(ctx.clock.now.getTime() + 24 * HOUR))).toBeNull();
  });

  it('keeps a remembered session for 30 days of activity but still applies the idle limit', async () => {
    const { token } = await newSession({ remember: true });
    const start = ctx.clock.now.getTime();
    for (let hours = 11; hours <= 25; hours += 11) {
      expect(await resolveSession(ctx.db, token, new Date(start + hours * HOUR))).not.toBeNull();
    }
    expect(await resolveSession(ctx.db, token, new Date(start + 25 * HOUR + IDLE_MS))).toBeNull();
    const second = await newSession({ remember: true });
    expect(await resolveSession(ctx.db, second.token, new Date(start + REMEMBER_MS))).toBeNull();
  });

  it('bumps last_seen_at at most once a minute', async () => {
    const { token } = await newSession();
    const start = ctx.clock.now.getTime();
    await resolveSession(ctx.db, token, new Date(start + 59_000));
    expect((await row(token)).lastSeenAt.getTime()).toBe(start);
    await resolveSession(ctx.db, token, new Date(start + MINUTE));
    expect((await row(token)).lastSeenAt.getTime()).toBe(start + MINUTE);
    await resolveSession(ctx.db, token, new Date(start + MINUTE + 59_000));
    expect((await row(token)).lastSeenAt.getTime()).toBe(start + MINUTE);
    await resolveSession(ctx.db, token, new Date(start + 2 * MINUTE));
    expect((await row(token)).lastSeenAt.getTime()).toBe(start + 2 * MINUTE);
  });

  it('does not bump an expired session back to life', async () => {
    const { token } = await newSession();
    const late = new Date(ctx.clock.now.getTime() + IDLE_MS + MINUTE);
    expect(await resolveSession(ctx.db, token, late)).toBeNull();
    expect((await row(token)).lastSeenAt.getTime()).toBe(ctx.clock.now.getTime());
    expect(await resolveSession(ctx.db, token, new Date(ctx.clock.now.getTime() + MINUTE))).not.toBeNull();
  });
});

describe('revokeSession and revokeUserSessions', () => {
  it('revokes one session and leaves the user’s others', async () => {
    const a = await newSession();
    const other = await createSession(ctx.db, {
      userId: a.user.id,
      remember: false,
      ip: '203.0.113.2',
      userAgent: 'Vitest/2',
      now: ctx.clock.now,
    });
    const sessionId = (await row(a.token)).id;
    await revokeSession(ctx.db, sessionId);
    expect(await resolveSession(ctx.db, a.token, ctx.clock.now)).toBeNull();
    expect((await row(a.token)).revokedAt).not.toBeNull();
    expect(await resolveSession(ctx.db, other.token, ctx.clock.now)).not.toBeNull();
  });

  it('revokes all of a user’s sessions except the one named, and no one else’s', async () => {
    const a = await newSession();
    const make = () =>
      createSession(ctx.db, {
        userId: a.user.id,
        remember: false,
        ip: '203.0.113.3',
        userAgent: 'Vitest/3',
        now: ctx.clock.now,
      });
    const b = await make();
    const c = await make();
    const stranger = await newSession();
    await revokeUserSessions(ctx.db, a.user.id, (await row(b.token)).id);
    expect(await resolveSession(ctx.db, a.token, ctx.clock.now)).toBeNull();
    expect(await resolveSession(ctx.db, b.token, ctx.clock.now)).not.toBeNull();
    expect(await resolveSession(ctx.db, c.token, ctx.clock.now)).toBeNull();
    expect(await resolveSession(ctx.db, stranger.token, ctx.clock.now)).not.toBeNull();
    await revokeUserSessions(ctx.db, a.user.id);
    expect(await resolveSession(ctx.db, b.token, ctx.clock.now)).toBeNull();
  });

  it('keeps the first revocation time when revoked twice', async () => {
    const a = await newSession();
    const sessionId = (await row(a.token)).id;
    await revokeSession(ctx.db, sessionId, new Date('2026-01-01T00:00:00.000Z'));
    await revokeSession(ctx.db, sessionId, new Date('2026-06-01T00:00:00.000Z'));
    expect((await row(a.token)).revokedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('sessions over HTTP', () => {
  function me(cookie: string | undefined) {
    return ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      ...(cookie ? { headers: { cookie } } : {}),
    });
  }

  it('GET /me returns the signed-in user, and 401 unauthenticated without a cookie', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, aff.email, aff.password);
    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: aff.id,
      email: aff.email,
      fullName: 'Test User',
      role: 'affiliate',
      isOwner: false,
      permissions: [],
      twoFactorEnabled: false,
      mustEnroll2fa: false,
    });
    expect(JSON.stringify(res.json())).not.toMatch(/password|hash|totp_secret|secret/i);
    const anon = await me(undefined);
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ code: 'unauthenticated' });
  });

  it('expires after 12 h 01 without activity and clears the cookie', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, aff.email, aff.password);
    ctx.clock.advance(12 * HOUR + MINUTE);
    const res = await me(cookie);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated' });
    const cleared = String(res.headers['set-cookie']);
    expect(cleared).toMatch(/^dl_session=;/);
    expect(cleared.toLowerCase()).toContain('max-age=0');
  });

  it('stays valid across 11 h gaps while active, then ends at 24 h unless remembered', async () => {
    const short = await seedUser(ctx, { role: 'affiliate' });
    const long = await seedUser(ctx, { role: 'affiliate' });
    const shortCookie = await login(ctx, short.email, short.password, undefined, { remember: false });
    const longCookie = await login(ctx, long.email, long.password, undefined, { remember: true });

    ctx.clock.advance(11 * HOUR);
    expect((await me(shortCookie)).statusCode).toBe(200);
    expect((await me(longCookie)).statusCode).toBe(200);
    ctx.clock.advance(11 * HOUR);
    expect((await me(shortCookie)).statusCode).toBe(200);
    expect((await me(longCookie)).statusCode).toBe(200);
    ctx.clock.advance(3 * HOUR); // 25 h since login
    const shortAt25 = await me(shortCookie);
    expect(shortAt25.statusCode).toBe(401);
    expect(shortAt25.json()).toEqual({ code: 'unauthenticated' });
    expect((await me(longCookie)).statusCode).toBe(200);
  });

  it('ends a remembered session after 30 days even when active', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, aff.email, aff.password, undefined, { remember: true });
    // Active every 11 h, so the idle limit never applies; only the 30-day cap can end it.
    for (let hours = 11; hours < 30 * 24; hours += 11) {
      ctx.clock.advance(11 * HOUR);
      expect((await me(cookie)).statusCode).toBe(200);
    }
    ctx.clock.advance(11 * HOUR);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('bumps last_seen_at on at most one request a minute', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, aff.email, aff.password);
    const start = ctx.clock.now.getTime();
    const lastSeen = async () => (await ctx.db.select().from(sessions))[0]?.lastSeenAt.getTime();
    ctx.clock.advance(30_000);
    await me(cookie);
    expect(await lastSeen()).toBe(start);
    ctx.clock.advance(31_000);
    await me(cookie);
    expect(await lastSeen()).toBe(start + 61_000);
    ctx.clock.advance(10_000);
    await me(cookie);
    expect(await lastSeen()).toBe(start + 61_000);
  });

  it('rejects malformed session cookies without error', async () => {
    for (const value of ['', 'short', 'a'.repeat(500), '../../etc/passwd', 'x'.repeat(43) + ';', '%00'.repeat(20)]) {
      const res = await me(`dl_session=${value}`);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: 'unauthenticated' });
    }
  });

  it('logout returns 204, revokes the session, clears the cookie and a replay gets 401', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, aff.email, aff.password);
    const out = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...csrfHeaders(ctx), cookie },
    });
    expect(out.statusCode).toBe(204);
    expect(out.body).toBe('');
    expect(String(out.headers['set-cookie'])).toMatch(/^dl_session=;/);
    expect((await me(cookie)).statusCode).toBe(401);
    const [stored] = await ctx.db.select().from(sessions);
    expect(stored?.revokedAt).not.toBeNull();
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...csrfHeaders(ctx), cookie },
    });
    expect(again.statusCode).toBe(401);
  });

  it('logout needs a session and the CSRF headers, and only ends the caller’s own session', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const mine = await login(ctx, aff.email, aff.password);
    const other = await login(ctx, aff.email, aff.password);
    const anon = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: csrfHeaders(ctx) });
    expect(anon.statusCode).toBe(401);
    const noCsrf = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: mine } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await me(mine)).statusCode).toBe(200);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...csrfHeaders(ctx), cookie: mine },
    });
    expect((await me(mine)).statusCode).toBe(401);
    expect((await me(other)).statusCode).toBe(200);
  });
});
