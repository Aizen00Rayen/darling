import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@/shared';
import { attemptLogin, type LoginAttempt } from './login';
import { hashToken } from '../security/crypto';
import {
  createTestApp,
  login,
  seedUser,
  sessionCookieOf,
  setCookieLine,
  snap,
  totpCodeAt,
  wrongCode,
  type TestApp,
} from '../test/app';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => app.close());

const WRONG = 'Wrong-gloss-2026';
const LOGIN = '/api/auth/login';

type UserRow = {
  failed_logins: number;
  locked_until: number | null;
  last_login_at: number | null;
  totp_last_step: number | null;
};
const userRow = (id: string) => app.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id) as UserRow;
type EventRow = { user_id: string | null; email_tried: string; ip: string | null; user_agent: string | null; success: number; reason: string; at: number };
const events = () => app.db.all<EventRow>('SELECT * FROM login_events ORDER BY id');
const sessionCount = () => app.db.get<{ n: number }>('SELECT count(*) AS n FROM sessions')!.n;
const post = (body: unknown, extra: { ip?: string; headers?: Record<string, string | null>; cookie?: string } = {}) =>
  app.call(LOGIN, { body, ...extra });
const attrs = (line: string) => line.split(';').slice(1).map((p) => p.trim().toLowerCase());

describe('POST /api/auth/login: success', () => {
  it('requires the code for a 2FA owner, then logs in and sets a hardened cookie', async () => {
    const owner = await seedUser(app, { role: 'super_manager', isOwner: true, totp: true });
    const secret = owner.totpSecret as string;

    const without = await post({ email: owner.email, password: owner.password });
    expect(without.status).toBe(401);
    expect(await without.json()).toEqual({ code: 'totp_required' });
    expect(without.headers.getSetCookie()).toEqual([]);
    expect(userRow(owner.id).failed_logins).toBe(0); // a missing code is not a failed attempt

    const res = await post({ email: owner.email, password: owner.password, totpCode: totpCodeAt(secret, app.clock.now()) });
    expect(res.status).toBe(200);
    const line = setCookieLine(res) as string;
    expect(line).toMatch(/^dl_session=[A-Za-z0-9_-]{43};/);
    expect(attrs(line)).toEqual(expect.arrayContaining(['httponly', 'samesite=lax', 'path=/']));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      user: {
        id: owner.id,
        email: owner.email,
        fullName: 'Test User',
        role: 'super_manager',
        isOwner: true,
        permissions: [...PERMISSIONS],
        twoFactorEnabled: true,
        mustEnroll2fa: false,
      },
    });
    const row = userRow(owner.id);
    expect(row.last_login_at).toBe(app.clock.now());
    expect(row.totp_last_step).toBe(Math.floor(app.clock.now() / 30_000));
    expect(row.failed_logins).toBe(0);
  });

  it('rejects a replayed code with totp_invalid, accepts the next step', async () => {
    const user = await seedUser(app, { role: 'affiliate', totp: true });
    const secret = user.totpSecret as string;
    const code = totpCodeAt(secret, app.clock.now());
    expect((await post({ email: user.email, password: user.password, totpCode: code })).status).toBe(200);
    const replay = await post({ email: user.email, password: user.password, totpCode: code });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ code: 'totp_invalid' });
    const next = totpCodeAt(secret, app.clock.now(), 1);
    expect((await post({ email: user.email, password: user.password, totpCode: next })).status).toBe(200);
  });

  it('counts a wrong code as a failed attempt but a missing one as nothing', async () => {
    const user = await seedUser(app, { role: 'affiliate', totp: true });
    const wrong = wrongCode(user.totpSecret as string, app.clock.now());
    for (let i = 0; i < 3; i += 1) {
      expect(await (await post({ email: user.email, password: user.password, totpCode: wrong })).json()).toEqual({ code: 'totp_invalid' });
    }
    await post({ email: user.email, password: user.password });
    expect(userRow(user.id).failed_logins).toBe(3);
  });

  it('accepts an email with stray case and spaces', async () => {
    const aff = await seedUser(app, { role: 'affiliate', email: 'aff@example.com' });
    const res = await post({ email: '  AFF@Example.com ', password: aff.password });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe('aff@example.com');
    expect(events()[0]?.email_tried).toBe('aff@example.com');
  });

  it('returns no permissions to a sous-manager who has stray grants', async () => {
    const sub = await seedUser(app, { role: 'sub_manager', permissions: ['orders.read'] });
    const res = await post({ email: sub.email, password: sub.password });
    expect(((await res.json()) as { user: { permissions: string[] } }).user.permissions).toEqual([]);
  });

  it('flags a Super Manager without 2FA for enrolment while the setting is on, not when it is off', async () => {
    const sm = await seedUser(app, { role: 'super_manager', permissions: ['orders.read'] });
    const on = (await (await post({ email: sm.email, password: sm.password })).json()) as { user: { mustEnroll2fa: boolean; permissions: string[] } };
    expect(on.user.mustEnroll2fa).toBe(true);
    expect(on.user.permissions).toEqual(['orders.read']);
    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
    const off = (await (await post({ email: sm.email, password: sm.password })).json()) as { user: { mustEnroll2fa: boolean } };
    expect(off.user.mustEnroll2fa).toBe(false);
    const aff = await seedUser(app, { role: 'affiliate' });
    expect(((await (await post({ email: aff.email, password: aff.password })).json()) as { user: { mustEnroll2fa: boolean } }).user.mustEnroll2fa).toBe(false);
  });

  it('writes the success to login_events and not to audit_log', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    await post({ email: aff.email, password: aff.password }, { ip: '203.0.113.7', headers: { 'user-agent': 'Vitest/1' } });
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: aff.id, email_tried: aff.email, ip: '203.0.113.7', user_agent: 'Vitest/1', success: 1, reason: 'ok' });
    expect(app.db.get<{ n: number }>('SELECT count(*) AS n FROM audit_log')!.n).toBe(0);
  });
});

describe('POST /api/auth/login: failures look alike', () => {
  it('gives byte-identical responses for unknown email, wrong password, locked, suspended and invited', async () => {
    const real = await seedUser(app, { role: 'affiliate' });
    const locked = await seedUser(app, { role: 'affiliate' });
    app.db.run('UPDATE users SET locked_until = ?, failed_logins = 10 WHERE id = ?', app.clock.now() + 600_000, locked.id);
    const suspended = await seedUser(app, { role: 'affiliate', status: 'suspended' });
    const invited = await seedUser(app, { role: 'affiliate', status: 'invited' });
    const deactivated = await seedUser(app, { role: 'affiliate', status: 'deactivated' });

    const responses = await Promise.all([
      post({ email: 'nobody@example.test', password: real.password }),
      post({ email: real.email, password: WRONG }),
      post({ email: locked.email, password: locked.password }),
      post({ email: suspended.email, password: suspended.password }),
      post({ email: invited.email, password: 'whatever-2026' }),
      post({ email: deactivated.email, password: deactivated.password }),
    ]);
    const snaps = await Promise.all(responses.map(snap));
    for (const s of snaps) {
      expect(s).toEqual(snaps[0]);
      expect(s.status).toBe(401);
      expect(s.body).toBe('{"code":"invalid_credentials"}');
      expect(s.setCookie).toEqual([]);
    }
    expect(events().map((e) => e.reason).sort()).toEqual(['bad_password', 'inactive', 'inactive', 'inactive', 'locked', 'unknown_email']);
  });

  it('performs the same password work for unknown, suspended and wrong-password attempts', async () => {
    // Every failure path awaits one scrypt verification (real or dummy hash): count the verifications.
    const real = await seedUser(app, { role: 'affiliate' });
    const suspended = await seedUser(app, { role: 'affiliate', status: 'suspended' });
    const crypto = await import('../security/crypto');
    const spy = vi.spyOn(crypto, 'verifyPassword');
    await post({ email: 'ghost@example.test', password: WRONG });
    await post({ email: suspended.email, password: WRONG });
    await post({ email: real.email, password: WRONG });
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('records the reason for each kind of attempt, with the user agent cut at 255 characters', async () => {
    const ok = await seedUser(app, { role: 'affiliate' });
    const locked = await seedUser(app, { role: 'affiliate' });
    app.db.run('UPDATE users SET locked_until = ? WHERE id = ?', app.clock.now() + 600_000, locked.id);
    const suspended = await seedUser(app, { role: 'affiliate', status: 'suspended' });
    const twofa = await seedUser(app, { role: 'affiliate', totp: true });
    const wrong = wrongCode(twofa.totpSecret as string, app.clock.now());
    const headers = { 'user-agent': 'A'.repeat(300) };

    await post({ email: 'ghost@example.test', password: WRONG }, { headers });
    await post({ email: ok.email, password: WRONG }, { headers });
    await post({ email: ok.email, password: ok.password }, { headers });
    await post({ email: locked.email, password: locked.password }, { headers });
    await post({ email: suspended.email, password: suspended.password }, { headers });
    await post({ email: twofa.email, password: twofa.password }, { headers });
    await post({ email: twofa.email, password: twofa.password, totpCode: wrong }, { headers });

    const rows = events();
    expect(rows.map((r) => [r.reason, r.success, r.user_id])).toEqual([
      ['unknown_email', 0, null],
      ['bad_password', 0, ok.id],
      ['ok', 1, ok.id],
      ['locked', 0, locked.id],
      ['inactive', 0, suspended.id],
      ['totp_required', 0, twofa.id],
      ['totp_invalid', 0, twofa.id],
    ]);
    for (const row of rows) {
      expect(row.user_agent).toBe('A'.repeat(255));
      expect(row.ip).toMatch(/^10\./);
    }
    expect(rows[0]?.email_tried).toBe('ghost@example.test');
  });

  it('never writes the password or a token to login_events', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    await post({ email: aff.email, password: WRONG });
    const res = await post({ email: aff.email, password: aff.password });
    const token = (sessionCookieOf(res) as string).split('=')[1] as string;
    const dump = JSON.stringify(events());
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(WRONG);
    expect(dump).not.toContain(aff.password);
  });

  it('rejects a malformed body with 400 validation and records nothing', async () => {
    const res = await post({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; errors: Record<string, string> };
    expect(body.code).toBe('validation');
    expect(Object.keys(body.errors).sort()).toEqual(['email', 'password']);
    expect(events()).toHaveLength(0);
    const bad = await app.call(LOGIN, { rawBody: '{not json' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ code: 'bad_request' });
    const arr = await post([1, 2]);
    expect(arr.status).toBe(400);
    expect(events()).toHaveLength(0);
  });

  it('refuses oversized bodies', async () => {
    const res = await app.call(LOGIN, { rawBody: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200_000) }) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: 'payload_too_large' });
  });
});

describe('POST /api/auth/login: lockout', () => {
  it('locks for 15 minutes after ten wrong passwords, even for the right one, then opens', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    for (let i = 0; i < 10; i += 1) {
      const res = await post({ email: aff.email, password: WRONG });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'invalid_credentials' });
    }
    const afterTen = userRow(aff.id);
    expect(afterTen.failed_logins).toBe(10);
    expect(afterTen.locked_until).toBe(app.clock.now() + 15 * 60_000);

    const whileLocked = await post({ email: aff.email, password: aff.password });
    expect(await whileLocked.json()).toEqual({ code: 'invalid_credentials' });
    expect(userRow(aff.id).failed_logins).toBe(10);
    expect(events().at(-1)?.reason).toBe('locked');

    app.clock.advance(15 * 60_000);
    expect((await post({ email: aff.email, password: aff.password })).status).toBe(200);
    const after = userRow(aff.id);
    expect(after.failed_logins).toBe(0);
    expect(after.locked_until).toBeNull();
  });

  it('is still locked one millisecond before the lock lapses', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    for (let i = 0; i < 10; i += 1) await post({ email: aff.email, password: WRONG });
    app.clock.advance(15 * 60_000 - 1);
    expect((await post({ email: aff.email, password: aff.password })).status).toBe(401);
  });

  it('starts a fresh count once a lock has lapsed', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    for (let i = 0; i < 10; i += 1) await post({ email: aff.email, password: WRONG });
    app.clock.advance(15 * 60_000);
    await post({ email: aff.email, password: WRONG });
    const row = userRow(aff.id);
    expect(row.failed_logins).toBe(1);
    expect(row.locked_until).toBeNull();
    expect((await post({ email: aff.email, password: aff.password })).status).toBe(200);
  });

  it('resets the counter on success so failures must be consecutive', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    for (let i = 0; i < 9; i += 1) await post({ email: aff.email, password: WRONG });
    expect(userRow(aff.id).failed_logins).toBe(9);
    expect((await post({ email: aff.email, password: aff.password })).status).toBe(200);
    expect(userRow(aff.id).failed_logins).toBe(0);
    for (let i = 0; i < 9; i += 1) await post({ email: aff.email, password: WRONG });
    expect(userRow(aff.id).locked_until).toBeNull();
    expect((await post({ email: aff.email, password: aff.password })).status).toBe(200);
  });

  it('does not count attempts on a suspended account', async () => {
    const suspended = await seedUser(app, { role: 'affiliate', status: 'suspended' });
    for (let i = 0; i < 12; i += 1) await post({ email: suspended.email, password: WRONG });
    const row = userRow(suspended.id);
    expect(row.failed_logins).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  it('locks after ten wrong codes given with the right password, and refuses the right code then', async () => {
    const user = await seedUser(app, { role: 'affiliate', totp: true });
    const secret = user.totpSecret as string;
    const wrong = wrongCode(secret, app.clock.now());
    for (let i = 0; i < 10; i += 1) {
      expect(await (await post({ email: user.email, password: user.password, totpCode: wrong })).json()).toEqual({ code: 'totp_invalid' });
    }
    expect(userRow(user.id).locked_until).not.toBeNull();
    const refused = await post({ email: user.email, password: user.password, totpCode: totpCodeAt(secret, app.clock.now()) });
    expect(await refused.json()).toEqual({ code: 'invalid_credentials' });
    expect(refused.headers.getSetCookie()).toEqual([]);
  });
});

describe('POST /api/auth/login: rate limit, CSRF and client address', () => {
  it('answers the sixth attempt in a minute from one address with 429 and Retry-After', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    const ip = '198.51.100.9';
    for (let i = 0; i < 5; i += 1) expect((await post({ email: aff.email, password: WRONG }, { ip })).status).toBe(401);
    const limited = await post({ email: aff.email, password: aff.password }, { ip });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ code: 'too_many_attempts' });
    const retry = Number(limited.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(limited.headers.getSetCookie()).toEqual([]);
    expect(events()).toHaveLength(5); // the limited attempt never reached the credential check
    expect(userRow(aff.id).failed_logins).toBe(5);
    expect((await post({ email: aff.email, password: aff.password })).status).toBe(200); // another address
    app.clock.advance(60_000);
    expect((await post({ email: aff.email, password: aff.password }, { ip })).status).toBe(200);
  });

  it('rate limits by the real client address: spoofed left-most X-Forwarded-For values share one bucket (hops=1)', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    const results: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      // The proxy appends the real address (198.51.100.77) on the right; the client chose the left part.
      const res = await post({ email: aff.email, password: WRONG }, { ip: `203.0.113.${i}, 198.51.100.77` });
      results.push(res.status);
    }
    expect(results).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it('gives two real client addresses separate buckets', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    for (let i = 0; i < 5; i += 1) await post({ email: aff.email, password: WRONG }, { ip: '198.51.100.1' });
    expect((await post({ email: aff.email, password: WRONG }, { ip: '198.51.100.1' })).status).toBe(429);
    expect((await post({ email: aff.email, password: WRONG }, { ip: '198.51.100.2' })).status).toBe(401);
  });

  it('with hops=0 (never in production) the header is ignored: every request shares the unknown address, with a 4x budget', async () => {
    app.close();
    app = createTestApp({ config: { trustedProxyHops: 0 } });
    const aff = await seedUser(app, { role: 'affiliate' });
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await post({ email: aff.email, password: WRONG })).status);
    // wrong passwords lock the account after ten, which still answers 401; only the 21st hits the (4x) limit
    expect(statuses).toEqual([...Array(20).fill(401), 429]);
  });

  it('refuses a request without x-requested-with or with a foreign origin before touching anything', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    const noHeader = await post({ email: aff.email, password: aff.password }, { headers: { 'x-requested-with': null } });
    expect(noHeader.status).toBe(403);
    expect(await noHeader.json()).toEqual({ code: 'csrf' });
    const foreign = await post({ email: aff.email, password: aff.password }, { headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    expect(events()).toHaveLength(0);
    expect(sessionCount()).toBe(0);
  });
});

describe('POST /api/auth/login: sessions', () => {
  it('never reuses a cookie the client presents (session fixation)', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    const bogus = 'dl_session=attackerchosenvalueattackerchosenvalue12';
    const res = await post({ email: aff.email, password: aff.password }, { cookie: bogus });
    expect(res.status).toBe(200);
    const issued = sessionCookieOf(res) as string;
    expect(issued).not.toBe(bogus);
    expect(issued.split('=')[1]).toHaveLength(43);
    expect(res.headers.getSetCookie().filter((c) => c.startsWith('dl_session='))).toHaveLength(1); // no clearing cookie on top
    expect((await app.call('/api/auth/me', { cookie: bogus })).status).toBe(401);
    expect((await app.call('/api/auth/me', { cookie: issued })).status).toBe(200);
  });

  it('issues a new token and revokes the old session when a valid cookie is presented', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    const first = await login(app, aff.email, aff.password);
    const res = await post({ email: aff.email, password: aff.password }, { cookie: first });
    const second = sessionCookieOf(res) as string;
    expect(second).not.toBe(first);
    expect((await app.call('/api/auth/me', { cookie: first })).status).toBe(401);
    expect((await app.call('/api/auth/me', { cookie: second })).status).toBe(200);
  });

  it('leaves an existing session alone when the new login fails', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    const first = await login(app, aff.email, aff.password);
    await post({ email: aff.email, password: WRONG }, { cookie: first });
    expect((await app.call('/api/auth/me', { cookie: first })).status).toBe(200);
  });

  it('stores only the sha256 of the token, never the token', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    const cookie = await login(app, aff.email, aff.password, { remember: true });
    const token = cookie.split('=')[1] as string;
    const rows = app.db.all<{ token_hash: string; remember: number }>('SELECT * FROM sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashToken(token));
    expect(rows[0]?.remember).toBe(1);
    for (const table of ['sessions', 'users', 'audit_log', 'login_events']) {
      expect(JSON.stringify(app.db.all(`SELECT * FROM ${table}`))).not.toContain(token);
    }
  });

  it('lets only one of two parallel logins with the same code succeed', async () => {
    const user = await seedUser(app, { role: 'affiliate', totp: true });
    const code = totpCodeAt(user.totpSecret as string, app.clock.now());
    const results = await Promise.all([
      post({ email: user.email, password: user.password, totpCode: code }),
      post({ email: user.email, password: user.password, totpCode: code }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const loser = results.find((r) => r.status === 401) as Response;
    expect(await loser.json()).toEqual({ code: 'totp_invalid' });
    expect(loser.headers.getSetCookie()).toEqual([]);
    expect(sessionCount()).toBe(1);
  });
});

describe('POST /api/auth/login: session cookie attributes', () => {
  it.each([
    { secure: false, remember: false },
    { secure: false, remember: true },
    { secure: true, remember: false },
    { secure: true, remember: true },
  ])('secure=$secure remember=$remember', async ({ secure, remember }) => {
    const local = createTestApp({ config: { cookieSecure: secure } });
    try {
      const aff = await seedUser(local, { role: 'affiliate' });
      const res = await local.call(LOGIN, { body: { email: aff.email, password: aff.password, ...(remember ? { remember: true } : {}) } });
      expect(res.status).toBe(200);
      const line = setCookieLine(res) as string;
      const name = secure ? '__Host-dl_session' : 'dl_session';
      expect(line.startsWith(`${name}=`)).toBe(true);
      const a = attrs(line);
      expect(a).toEqual(expect.arrayContaining(['httponly', 'samesite=lax', 'path=/']));
      expect(a.includes('secure')).toBe(secure);
      expect(a.some((x) => x.startsWith('domain'))).toBe(false);
      expect(a.find((x) => x.startsWith('max-age='))).toBe(remember ? 'max-age=2592000' : undefined);
      expect(a.some((x) => x.startsWith('expires='))).toBe(false);

      const out = await local.call('/api/auth/logout', { method: 'POST', cookie: line.split(';')[0] });
      expect(out.status).toBe(204);
      const cleared = setCookieLine(out) as string;
      expect(cleared.startsWith(`${name}=;`)).toBe(true);
      const c = attrs(cleared);
      expect(c).toEqual(expect.arrayContaining(['httponly', 'samesite=lax', 'path=/', 'max-age=0']));
      expect(c.includes('secure')).toBe(secure);
      expect(c.some((x) => x.startsWith('expires=thu, 01 jan 1970'))).toBe(true);
    } finally {
      local.close();
    }
  });

  it('a secure deployment ignores a plain dl_session cookie (only the __Host- cookie counts)', async () => {
    const local = createTestApp({ config: { cookieSecure: true } });
    try {
      const aff = await seedUser(local, { role: 'affiliate' });
      const res = await local.call(LOGIN, { body: { email: aff.email, password: aff.password } });
      const token = (sessionCookieOf(res) as string).split('=')[1];
      expect((await local.call('/api/auth/me', { cookie: `dl_session=${token}` })).status).toBe(401);
      expect((await local.call('/api/auth/me', { cookie: `__Host-dl_session=${token}` })).status).toBe(200);
    } finally {
      local.close();
    }
  });
});

describe('POST /api/auth/login: attempts are reserved atomically', () => {
  const count = (reason: string) => events().filter((e) => e.reason === reason).length;

  it('lets at most ten of forty parallel wrong passwords be checked, then refuses the right one', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    const burst = await Promise.all(Array.from({ length: 40 }, () => post({ email: aff.email, password: WRONG })));
    for (const res of burst) {
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('{"code":"invalid_credentials"}');
    }
    expect(count('bad_password')).toBe(10);
    expect(count('locked')).toBe(30);
    const locked = userRow(aff.id);
    expect(locked.failed_logins).toBe(10);
    expect(locked.locked_until).toBe(app.clock.now() + 15 * 60_000);

    const right = await post({ email: aff.email, password: aff.password });
    expect(right.status).toBe(401);
    expect(right.headers.getSetCookie()).toEqual([]);
    expect(sessionCount()).toBe(0);
    expect(userRow(aff.id).locked_until).toBe(locked.locked_until);

    app.clock.advance(15 * 60_000);
    expect((await post({ email: aff.email, password: aff.password })).status).toBe(200);
    expect(userRow(aff.id).failed_logins).toBe(0);
  });

  it('does the same against a temp file database shared by several connections', async () => {
    app.close();
    app = createTestApp({ file: true, connections: 3 });
    const aff = await seedUser(app, { role: 'affiliate' });
    const burst = await Promise.all([
      ...Array.from({ length: 40 }, () => post({ email: aff.email, password: WRONG })),
      post({ email: aff.email, password: aff.password }),
    ]);
    const ok = count('ok');
    expect(burst.filter((r) => r.status === 200)).toHaveLength(ok);
    expect(ok).toBeLessThanOrEqual(1);
    expect(events()).toHaveLength(41);
    expect(count('bad_password')).toBeLessThanOrEqual(10 * (ok + 1));
    if (ok === 0) {
      expect(userRow(aff.id).locked_until).not.toBeNull();
      expect(userRow(aff.id).failed_logins).toBe(10);
    }
  });

  it('after a success the counter is clear, and a later burst gets a fresh window of ten', async () => {
    const aff = await seedUser(app, { role: 'affiliate' });
    for (let i = 0; i < 4; i += 1) await post({ email: aff.email, password: WRONG });
    expect((await post({ email: aff.email, password: aff.password })).status).toBe(200);
    expect(userRow(aff.id).failed_logins).toBe(0);
    await Promise.all(Array.from({ length: 25 }, () => post({ email: aff.email, password: WRONG })));
    expect(count('bad_password')).toBe(4 + 10);
    expect(userRow(aff.id).locked_until).not.toBeNull();
  });

  it('never locks an account by repeating the right password without a code', async () => {
    const user = await seedUser(app, { role: 'affiliate', totp: true });
    for (let i = 0; i < 12; i += 1) {
      expect(await (await post({ email: user.email, password: user.password })).json()).toEqual({ code: 'totp_required' });
      const row = userRow(user.id);
      expect(row.failed_logins).toBe(0);
      expect(row.locked_until).toBeNull();
    }
    expect(count('totp_required')).toBe(12);
    const code = totpCodeAt(user.totpSecret as string, app.clock.now());
    expect((await post({ email: user.email, password: user.password, totpCode: code })).status).toBe(200);
  });

  it('releases a missing-code reservation even when it was the tenth attempt, lifting only its own lock', async () => {
    const user = await seedUser(app, { role: 'affiliate', totp: true });
    const secret = user.totpSecret as string;
    const wrong = wrongCode(secret, app.clock.now());
    for (let i = 0; i < 9; i += 1) await post({ email: user.email, password: user.password, totpCode: wrong });
    expect(userRow(user.id).failed_logins).toBe(9);
    expect(await (await post({ email: user.email, password: user.password })).json()).toEqual({ code: 'totp_required' });
    const row = userRow(user.id);
    expect(row.failed_logins).toBe(9);
    expect(row.locked_until).toBeNull();
    expect((await post({ email: user.email, password: user.password, totpCode: totpCodeAt(secret, app.clock.now()) })).status).toBe(200);
  });

  // The `onVerified` seam runs right after the password check, so the tests can change the account at
  // exactly that moment instead of hoping a race happens.
  describe('a lock that lands during verification', () => {
    const attempt = (o: Partial<LoginAttempt> & Pick<LoginAttempt, 'email' | 'password'>): LoginAttempt => ({
      remember: false,
      totpCode: undefined,
      ip: '203.0.113.50',
      userAgent: 'Vitest/1',
      presentedSessionId: undefined,
      ...o,
    });
    const lockNow = (id: string) => async () => {
      app.db.run('UPDATE users SET failed_logins = 10, locked_until = ? WHERE id = ?', app.clock.now() + 15 * 60_000, id);
    };

    it('refuses the right password, creates no session and leaves the counters alone', async () => {
      const aff = await seedUser(app, { role: 'affiliate' });
      const outcome = await attemptLogin({ ...app, onVerified: lockNow(aff.id) }, attempt({ email: aff.email, password: aff.password }));
      expect(outcome).toEqual({ kind: 'invalid_credentials' });
      expect(sessionCount()).toBe(0);
      const row = userRow(aff.id);
      expect(row.failed_logins).toBe(10);
      expect(row.locked_until).toBe(app.clock.now() + 15 * 60_000);
      expect(row.last_login_at).toBeNull();
      expect(events().map((e) => e.reason)).toEqual(['locked']);
    });

    it('does the same for a valid code, and does not spend the code', async () => {
      const user = await seedUser(app, { role: 'affiliate', totp: true });
      const code = totpCodeAt(user.totpSecret as string, app.clock.now());
      const outcome = await attemptLogin({ ...app, onVerified: lockNow(user.id) }, attempt({ email: user.email, password: user.password, totpCode: code }));
      expect(outcome).toEqual({ kind: 'invalid_credentials' });
      expect(sessionCount()).toBe(0);
      expect(userRow(user.id).totp_last_step).toBeNull();
      expect(events().map((e) => e.reason)).toEqual(['locked']);
    });

    it('does not lift a lock when the tenth attempt of a window is someone else’s', async () => {
      const aff = await seedUser(app, { role: 'affiliate' });
      app.db.run('UPDATE users SET failed_logins = 8 WHERE id = ?', aff.id);
      // This attempt reserves the 9th slot; a concurrent attempt then takes the 10th and locks.
      const outcome = await attemptLogin(
        { ...app, onVerified: async () => void (await post({ email: aff.email, password: WRONG })) },
        attempt({ email: aff.email, password: aff.password }),
      );
      expect(outcome).toEqual({ kind: 'invalid_credentials' });
      expect(sessionCount()).toBe(0);
      expect(userRow(aff.id).locked_until).not.toBeNull();
      expect(events().map((e) => e.reason)).toEqual(['bad_password', 'locked']);
    });

    it('the attempt that takes the tenth slot lifts only the lock it set itself (missing code)', async () => {
      const user = await seedUser(app, { role: 'affiliate', totp: true });
      app.db.run('UPDATE users SET failed_logins = 9 WHERE id = ?', user.id);
      const outcome = await attemptLogin({ ...app }, attempt({ email: user.email, password: user.password }));
      expect(outcome).toEqual({ kind: 'totp_required' });
      expect(userRow(user.id)).toMatchObject({ failed_logins: 9, locked_until: null });
    });

    it('a lock set by someone else while a missing-code attempt verifies stays in place', async () => {
      const user = await seedUser(app, { role: 'affiliate', totp: true });
      app.db.run('UPDATE users SET failed_logins = 9 WHERE id = ?', user.id);
      const theirs = app.clock.now() + 15 * 60_000 + 5;
      const outcome = await attemptLogin(
        { ...app, onVerified: async () => void app.db.run('UPDATE users SET failed_logins = 10, locked_until = ? WHERE id = ?', theirs, user.id) },
        attempt({ email: user.email, password: user.password }),
      );
      expect(outcome).toEqual({ kind: 'totp_required' });
      expect(userRow(user.id).locked_until).toBe(theirs);
    });

    it('an account suspended while the password is verified gets no session', async () => {
      const aff = await seedUser(app, { role: 'affiliate' });
      const outcome = await attemptLogin(
        { ...app, onVerified: async () => void app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", aff.id) },
        attempt({ email: aff.email, password: aff.password }),
      );
      expect(outcome).toEqual({ kind: 'invalid_credentials' });
      expect(sessionCount()).toBe(0);
    });
  });
});
