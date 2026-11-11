import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../security/crypto';
import { createTestApp, login, seedUser, setCookieLine, type TestApp } from '../test/app';
import {
  ABSOLUTE_MS,
  IDLE_MS,
  REMEMBER_MS,
  createSession,
  resolveSession,
  revokeSession,
  revokeUserSessions,
} from './sessions';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => app.close());

const HOUR = 3_600_000;
type SessionRow = { id: string; token_hash: string; user_agent: string | null; created_at: number; last_seen_at: number; expires_at: number; revoked_at: number | null };
const row = (id: string) => app.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id) as SessionRow;
const start = async (remember = false) => {
  const u = await seedUser(app, { role: 'affiliate' });
  const s = createSession(app.db, app.clock, { userId: u.id, remember, ip: '203.0.113.1', userAgent: 'UA', now: app.clock.now() });
  return { u, s };
};

describe('constants', () => {
  it('are 12 h, 24 h and 30 d', () => {
    expect(IDLE_MS).toBe(12 * HOUR);
    expect(ABSOLUTE_MS).toBe(24 * HOUR);
    expect(REMEMBER_MS).toBe(30 * 24 * HOUR);
  });
});

describe('createSession', () => {
  it('stores only the hash of a 256-bit token and expires after 24 h', async () => {
    const { s } = await start();
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.expiresAt).toBe(app.clock.now() + ABSOLUTE_MS);
    const stored = app.db.get<SessionRow>('SELECT * FROM sessions') as SessionRow;
    expect(stored.token_hash).toBe(hashToken(s.token));
    expect(JSON.stringify(app.db.all('SELECT * FROM sessions'))).not.toContain(s.token);
  });

  it('expires a remembered session after 30 days and gives every session its own token', async () => {
    const a = await start(true);
    const b = await start(false);
    expect(a.s.expiresAt).toBe(app.clock.now() + REMEMBER_MS);
    expect(a.s.token).not.toBe(b.s.token);
  });

  it('truncates the user agent to 255 characters', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    createSession(app.db, app.clock, { userId: u.id, remember: false, ip: '1.1.1.1', userAgent: 'x'.repeat(400), now: app.clock.now() });
    expect((app.db.get<SessionRow>('SELECT * FROM sessions') as SessionRow).user_agent).toHaveLength(255);
  });
});

describe('resolveSession', () => {
  it('resolves a live session and refuses unknown or empty tokens', async () => {
    const { u, s } = await start();
    expect(resolveSession(app.db, s.token, app.clock.now())).toMatchObject({ userId: u.id });
    expect(resolveSession(app.db, 'nope', app.clock.now())).toBeNull();
    expect(resolveSession(app.db, '', app.clock.now())).toBeNull();
  });

  it('expires after 12 h without activity (boundary included)', async () => {
    const { s } = await start();
    app.clock.advance(IDLE_MS - 1);
    expect(resolveSession(app.db, s.token, app.clock.now())).not.toBeNull();
    app.clock.advance(IDLE_MS); // 12 h of silence since the last touch
    expect(resolveSession(app.db, s.token, app.clock.now())).toBeNull();
  });

  it('expires 24 h after login even when the user stays active, at the exact boundary', async () => {
    const { s } = await start();
    for (let i = 0; i < 3; i += 1) {
      app.clock.advance(6 * HOUR);
      expect(resolveSession(app.db, s.token, app.clock.now())).not.toBeNull();
    }
    app.clock.advance(6 * HOUR - 1);
    expect(resolveSession(app.db, s.token, app.clock.now())).not.toBeNull();
    app.clock.advance(1);
    expect(resolveSession(app.db, s.token, app.clock.now())).toBeNull();
  });

  it('keeps a remembered session for 30 days of activity but still applies the idle limit', async () => {
    const { s } = await start(true);
    for (let i = 0; i < 59; i += 1) {
      app.clock.advance(12 * HOUR - 1000);
      expect(resolveSession(app.db, s.token, app.clock.now())).not.toBeNull();
    }
    app.clock.advance(IDLE_MS + 1);
    expect(resolveSession(app.db, s.token, app.clock.now())).toBeNull();
  });

  it('bumps last_seen_at at most once a minute', async () => {
    const { s } = await start();
    const id = app.db.get<{ id: string }>('SELECT id FROM sessions')!.id;
    app.clock.advance(30_000);
    resolveSession(app.db, s.token, app.clock.now());
    expect(row(id).last_seen_at).toBe(app.clock.now() - 30_000);
    app.clock.advance(30_000);
    resolveSession(app.db, s.token, app.clock.now());
    expect(row(id).last_seen_at).toBe(app.clock.now());
  });

  it('does not bump an expired or revoked session back to life', async () => {
    const { s } = await start();
    const id = app.db.get<{ id: string }>('SELECT id FROM sessions')!.id;
    const before = row(id).last_seen_at;
    app.clock.advance(IDLE_MS + 1);
    expect(resolveSession(app.db, s.token, app.clock.now())).toBeNull();
    expect(row(id).last_seen_at).toBe(before);
    app.clock.set(before);
    revokeSession(app.db, id, app.clock.now());
    app.clock.advance(120_000);
    expect(resolveSession(app.db, s.token, app.clock.now())).toBeNull();
    expect(row(id).last_seen_at).toBe(before);
  });
});

describe('revokeSession and revokeUserSessions', () => {
  it('revokes one session and leaves the user’s others', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const mk = () => createSession(app.db, app.clock, { userId: u.id, remember: false, ip: '1.1.1.1', userAgent: '', now: app.clock.now() });
    const a = mk();
    const b = mk();
    const ids = app.db.all<{ id: string; token_hash: string }>('SELECT id, token_hash FROM sessions');
    revokeSession(app.db, ids.find((r) => r.token_hash === hashToken(a.token))!.id, app.clock.now());
    expect(resolveSession(app.db, a.token, app.clock.now())).toBeNull();
    expect(resolveSession(app.db, b.token, app.clock.now())).not.toBeNull();
  });

  it('revokes all of a user’s sessions except the one named, and no one else’s', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const other = await seedUser(app, { role: 'affiliate' });
    const mk = (userId: string) => createSession(app.db, app.clock, { userId, remember: false, ip: '1.1.1.1', userAgent: '', now: app.clock.now() });
    const keep = mk(u.id);
    const gone = mk(u.id);
    const theirs = mk(other.id);
    const keepId = app.db.get<{ id: string }>('SELECT id FROM sessions WHERE token_hash = ?', hashToken(keep.token))!.id;
    revokeUserSessions(app.db, u.id, keepId, app.clock.now());
    expect(resolveSession(app.db, keep.token, app.clock.now())).not.toBeNull();
    expect(resolveSession(app.db, gone.token, app.clock.now())).toBeNull();
    expect(resolveSession(app.db, theirs.token, app.clock.now())).not.toBeNull();
    revokeUserSessions(app.db, u.id, undefined, app.clock.now());
    expect(resolveSession(app.db, keep.token, app.clock.now())).toBeNull();
  });

  it('keeps the first revocation time when revoked twice', async () => {
    const { } = await start();
    const id = app.db.get<{ id: string }>('SELECT id FROM sessions')!.id;
    revokeSession(app.db, id, 111);
    revokeSession(app.db, id, 222);
    expect(row(id).revoked_at).toBe(111);
  });
});

describe('sessions over HTTP', () => {
  it('GET /me returns the signed-in user, and 401 unauthenticated without a cookie', async () => {
    const u = await seedUser(app, { role: 'sub_manager' });
    const cookie = await login(app, u.email, u.password);
    const me = await app.call('/api/auth/me', { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: u.id, email: u.email, role: 'sub_manager', permissions: [] });
    expect(me.headers.get('cache-control')).toBe('no-store');
    const anon = await app.call('/api/auth/me');
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ code: 'unauthenticated' });
    expect(anon.headers.getSetCookie()).toEqual([]); // no cookie sent: nothing to clear
  });

  it('expires after 12 h 01 without activity and clears the stale cookie', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const cookie = await login(app, u.email, u.password);
    app.clock.advance(IDLE_MS + 60_000);
    const res = await app.call('/api/auth/me', { cookie });
    expect(res.status).toBe(401);
    expect(setCookieLine(res)).toMatch(/^dl_session=;.*Max-Age=0/i);
  });

  it('stays valid across 11 h gaps while active, then ends at 24 h unless remembered', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const plain = await login(app, u.email, u.password);
    const remembered = await login(app, u.email, u.password, { remember: true });
    for (const wait of [11, 11]) {
      app.clock.advance(wait * HOUR);
      expect((await app.call('/api/auth/me', { cookie: plain })).status).toBe(200);
      expect((await app.call('/api/auth/me', { cookie: remembered })).status).toBe(200);
    }
    app.clock.advance(2 * HOUR); // 24 h in
    expect((await app.call('/api/auth/me', { cookie: plain })).status).toBe(401);
    expect((await app.call('/api/auth/me', { cookie: remembered })).status).toBe(200);
  });

  it('ends a remembered session after 30 days even when active', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const cookie = await login(app, u.email, u.password, { remember: true });
    for (let i = 0; i < 59; i += 1) {
      app.clock.advance(12 * HOUR - 1000);
      expect((await app.call('/api/auth/me', { cookie })).status).toBe(200);
    }
    app.clock.advance(12 * HOUR);
    expect((await app.call('/api/auth/me', { cookie })).status).toBe(401);
  });

  it('rejects malformed session cookies without error and clears them', async () => {
    for (const cookie of ['dl_session=', 'dl_session=short', `dl_session=${'a'.repeat(44)}`, 'dl_session=%00%00', `dl_session=${'!'.repeat(43)}`, 'dl_session']) {
      const res = await app.call('/api/auth/me', { cookie });
      expect(res.status, cookie).toBe(401);
    }
  });

  it('logout returns 204, revokes the session, clears the cookie and a replay gets 401', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const cookie = await login(app, u.email, u.password);
    const out = await app.call('/api/auth/logout', { method: 'POST', cookie });
    expect(out.status).toBe(204);
    expect(setCookieLine(out)).toMatch(/^dl_session=;/);
    expect((await app.call('/api/auth/me', { cookie })).status).toBe(401);
    expect((await app.call('/api/auth/logout', { method: 'POST', cookie })).status).toBe(401);
    expect(app.db.get<{ revoked_at: number | null }>('SELECT revoked_at FROM sessions')!.revoked_at).toBe(app.clock.now());
  });

  it('logout needs a session and the CSRF headers, and only ends the caller’s own session', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const mine = await login(app, u.email, u.password);
    const other = await login(app, u.email, u.password);
    expect((await app.call('/api/auth/logout', { method: 'POST' })).status).toBe(401);
    const forged = await app.call('/api/auth/logout', { method: 'POST', cookie: mine, headers: { 'x-requested-with': null } });
    expect(forged.status).toBe(403);
    expect((await app.call('/api/auth/me', { cookie: mine })).status).toBe(200);
    await app.call('/api/auth/logout', { method: 'POST', cookie: mine });
    expect((await app.call('/api/auth/me', { cookie: other })).status).toBe(200);
  });
});
