import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@darling/shared';
import { auditLog, loginEvents, sessions, settings, users } from '../../db/schema';
import { hashToken } from '../../lib/crypto';
import { attemptLogin, type LoginAttempt } from './login';
import {
  createTestContext,
  csrfHeaders,
  freshAddress,
  login,
  seedUser,
  sessionCookieOf,
  totpCodeAt,
  type TestContext,
} from '../../../test/context';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

type LoginBody = { email: string; password: string; remember?: boolean; totpCode?: string };

function post(
  body: LoginBody | Record<string, unknown>,
  extra: { headers?: Record<string, string>; remoteAddress?: string } = {},
  target: TestContext = ctx,
) {
  return target.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { ...csrfHeaders(target), ...extra.headers },
    remoteAddress: extra.remoteAddress ?? freshAddress(),
    payload: body,
  });
}

async function userRow(id: string) {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
  if (!row) throw new Error('user not found');
  return row;
}

function events() {
  return ctx.db.select().from(loginEvents).orderBy(asc(loginEvents.id));
}

function cookieAttributes(setCookie: string): string[] {
  return setCookie
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase());
}

function setCookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
  const found = list.find((c) => /^(__Host-)?dl_session=/.test(c));
  if (!found) throw new Error('no session cookie was set');
  return found;
}

const WRONG = 'Wrong-gloss-2026';

describe('POST /api/auth/login: success', () => {
  it('requires the code for a 2FA owner, then logs in and sets a hardened cookie', async () => {
    const owner = await seedUser(ctx, { role: 'super_manager', isOwner: true, totp: true });
    const secret = owner.totpSecret as string;

    const without = await post({ email: owner.email, password: owner.password });
    expect(without.statusCode).toBe(401);
    expect(without.json()).toEqual({ code: 'totp_required' });
    expect(without.headers['set-cookie']).toBeUndefined();
    // A missing code is not a failed attempt.
    expect((await userRow(owner.id)).failedLogins).toBe(0);

    const code = totpCodeAt(secret, ctx.clock.now);
    const res = await post({ email: owner.email, password: owner.password, totpCode: code });
    expect(res.statusCode).toBe(200);
    const cookie = setCookieOf(res);
    expect(cookie).toMatch(/^dl_session=[A-Za-z0-9_-]{43};/);
    expect(cookieAttributes(cookie)).toEqual(
      expect.arrayContaining(['httponly', 'samesite=lax', 'path=/']),
    );
    expect(res.json()).toEqual({
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

    const row = await userRow(owner.id);
    expect(row.lastLoginAt?.toISOString()).toBe(ctx.clock.now.toISOString());
    expect(row.totpLastStep).toBe(Math.floor(ctx.clock.now.getTime() / 30_000));
    expect(row.failedLogins).toBe(0);
  });

  it('rejects a replayed code with totp_invalid', async () => {
    const user = await seedUser(ctx, { role: 'affiliate', totp: true });
    const code = totpCodeAt(user.totpSecret as string, ctx.clock.now);
    expect((await post({ email: user.email, password: user.password, totpCode: code })).statusCode).toBe(200);
    const replay = await post({ email: user.email, password: user.password, totpCode: code });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ code: 'totp_invalid' });
    // The next step's code (still inside the accepted window) works.
    const next = totpCodeAt(user.totpSecret as string, ctx.clock.now, 1);
    expect((await post({ email: user.email, password: user.password, totpCode: next })).statusCode).toBe(200);
  });

  it('counts a wrong code as a failed attempt but a missing one as nothing', async () => {
    const user = await seedUser(ctx, { role: 'affiliate', totp: true });
    const valid = totpCodeAt(user.totpSecret as string, ctx.clock.now);
    const wrong = String((Number(valid) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 3; i += 1) {
      const res = await post({ email: user.email, password: user.password, totpCode: wrong });
      expect(res.json()).toEqual({ code: 'totp_invalid' });
    }
    await post({ email: user.email, password: user.password });
    expect((await userRow(user.id)).failedLogins).toBe(3);
  });

  it('locks the account after ten wrong codes', async () => {
    const user = await seedUser(ctx, { role: 'affiliate', totp: true });
    const valid = totpCodeAt(user.totpSecret as string, ctx.clock.now);
    const wrong = String((Number(valid) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 10; i += 1) {
      await post({ email: user.email, password: user.password, totpCode: wrong });
    }
    expect((await userRow(user.id)).lockedUntil).not.toBeNull();
    const res = await post({ email: user.email, password: user.password, totpCode: valid });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'invalid_credentials' });
  });

  it('accepts an email with stray case and spaces', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate', email: 'aff@example.com' });
    const res = await post({ email: '  AFF@Example.com ', password: aff.password });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('aff@example.com');
    expect((await events())[0]?.emailTried).toBe('aff@example.com');
  });

  it('returns no permissions to a sous-manager or an influenceuse who has stray grants', async () => {
    const sub = await seedUser(ctx, { role: 'sub_manager', permissions: ['orders.read'] });
    const res = await post({ email: sub.email, password: sub.password });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.permissions).toEqual([]);
  });

  it('flags a Super Manager without 2FA for enrolment while the setting is on, not when it is off', async () => {
    const sm = await seedUser(ctx, { role: 'super_manager', permissions: ['orders.read'] });
    const on = await post({ email: sm.email, password: sm.password });
    expect(on.statusCode).toBe(200);
    expect(on.json().user.mustEnroll2fa).toBe(true);
    expect(on.json().user.permissions).toEqual(['orders.read']);

    await ctx.db.insert(settings).values({ key: 'security.require_2fa_super_managers', value: false });
    const off = await post({ email: sm.email, password: sm.password });
    expect(off.json().user.mustEnroll2fa).toBe(false);

    const aff = await seedUser(ctx, { role: 'affiliate' });
    expect((await post({ email: aff.email, password: aff.password })).json().user.mustEnroll2fa).toBe(false);
  });

  it('writes the success to login_events and not to audit_log', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    await post(
      { email: aff.email, password: aff.password },
      { remoteAddress: '203.0.113.7', headers: { 'user-agent': 'Vitest/1' } },
    );
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: aff.id,
      emailTried: aff.email,
      ip: '203.0.113.7',
      userAgent: 'Vitest/1',
      success: true,
      reason: 'ok',
    });
    expect(await ctx.db.select().from(auditLog)).toHaveLength(0);
  });
});

describe('POST /api/auth/login: failures look alike', () => {
  it('gives byte-identical responses for unknown email, wrong password, locked and inactive', async () => {
    const real = await seedUser(ctx, { role: 'affiliate' });
    const locked = await seedUser(ctx, { role: 'affiliate' });
    await ctx.db
      .update(users)
      .set({ lockedUntil: new Date(ctx.clock.now.getTime() + 600_000), failedLogins: 10 })
      .where(eq(users.id, locked.id));
    const suspended = await seedUser(ctx, { role: 'affiliate', status: 'suspended' });
    const invited = await seedUser(ctx, { role: 'affiliate', status: 'invited' });

    const responses = await Promise.all([
      post({ email: 'nobody@example.test', password: real.password }),
      post({ email: real.email, password: WRONG }),
      post({ email: locked.email, password: locked.password }),
      post({ email: suspended.email, password: suspended.password }),
      post({ email: invited.email, password: invited.password }),
    ]);
    for (const res of responses) {
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe('{"code":"invalid_credentials"}');
      expect(res.headers['content-type']).toBe(responses[0]?.headers['content-type']);
      expect(res.headers['content-length']).toBe(responses[0]?.headers['content-length']);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect((await events()).map((e) => e.reason).sort()).toEqual([
      'bad_password',
      'inactive',
      'inactive',
      'locked',
      'unknown_email',
    ]);
  });

  it('records the reason for each kind of attempt, with the user agent cut at 255 characters', async () => {
    const ok = await seedUser(ctx, { role: 'affiliate' });
    const locked = await seedUser(ctx, { role: 'affiliate' });
    await ctx.db
      .update(users)
      .set({ lockedUntil: new Date(ctx.clock.now.getTime() + 600_000) })
      .where(eq(users.id, locked.id));
    const suspended = await seedUser(ctx, { role: 'affiliate', status: 'suspended' });
    const twofa = await seedUser(ctx, { role: 'affiliate', totp: true });
    const valid = totpCodeAt(twofa.totpSecret as string, ctx.clock.now);
    const wrong = String((Number(valid) + 1) % 1_000_000).padStart(6, '0');
    const longAgent = 'A'.repeat(300);
    const headers = { 'user-agent': longAgent };

    await post({ email: 'ghost@example.test', password: WRONG }, { headers });
    await post({ email: ok.email, password: WRONG }, { headers });
    await post({ email: ok.email, password: ok.password }, { headers });
    await post({ email: locked.email, password: locked.password }, { headers });
    await post({ email: suspended.email, password: suspended.password }, { headers });
    await post({ email: twofa.email, password: twofa.password }, { headers });
    await post({ email: twofa.email, password: twofa.password, totpCode: wrong }, { headers });

    const rows = await events();
    expect(rows.map((r) => [r.reason, r.success, r.userId])).toEqual([
      ['unknown_email', false, null],
      ['bad_password', false, ok.id],
      ['ok', true, ok.id],
      ['locked', false, locked.id],
      ['inactive', false, suspended.id],
      ['totp_required', false, twofa.id],
      ['totp_invalid', false, twofa.id],
    ]);
    for (const row of rows) {
      expect(row.userAgent).toBe('A'.repeat(255));
      expect(row.ip).toMatch(/^10\./);
    }
    expect(rows[0]?.emailTried).toBe('ghost@example.test');
  });

  it('never writes the password or a token to login_events', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    await post({ email: aff.email, password: WRONG });
    const res = await post({ email: aff.email, password: aff.password });
    const token = (sessionCookieOf(res) as string).split('=')[1] as string;
    const dump = JSON.stringify(await events());
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(WRONG);
    expect(dump).not.toContain(aff.password);
  });

  it('rejects a malformed body with 400 and records nothing', async () => {
    const res = await post({ email: 'not-an-email', password: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation');
    expect(await events()).toHaveLength(0);
  });
});

describe('POST /api/auth/login: lockout', () => {
  it('locks for 15 minutes after ten wrong passwords, even for the right one, then opens', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    for (let i = 0; i < 10; i += 1) {
      const res = await post({ email: aff.email, password: WRONG });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: 'invalid_credentials' });
    }
    const afterTen = await userRow(aff.id);
    expect(afterTen.failedLogins).toBe(10);
    expect(afterTen.lockedUntil?.getTime()).toBe(ctx.clock.now.getTime() + 15 * 60_000);

    const whileLocked = await post({ email: aff.email, password: aff.password });
    expect(whileLocked.statusCode).toBe(401);
    expect(whileLocked.json()).toEqual({ code: 'invalid_credentials' });
    const stillLocked = await userRow(aff.id);
    expect(stillLocked.failedLogins).toBe(10);
    expect((await events()).at(-1)?.reason).toBe('locked');

    ctx.clock.advance(15 * 60_000);
    const reopened = await post({ email: aff.email, password: aff.password });
    expect(reopened.statusCode).toBe(200);
    const after = await userRow(aff.id);
    expect(after.failedLogins).toBe(0);
    expect(after.lockedUntil).toBeNull();
  });

  it('starts a fresh count once a lock has lapsed', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    for (let i = 0; i < 10; i += 1) await post({ email: aff.email, password: WRONG });
    ctx.clock.advance(15 * 60_000);
    await post({ email: aff.email, password: WRONG });
    const row = await userRow(aff.id);
    expect(row.failedLogins).toBe(1);
    expect(row.lockedUntil).toBeNull();
    expect((await post({ email: aff.email, password: aff.password })).statusCode).toBe(200);
  });

  it('resets the counter on success so failures must be consecutive', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    for (let i = 0; i < 9; i += 1) await post({ email: aff.email, password: WRONG });
    expect((await userRow(aff.id)).failedLogins).toBe(9);
    expect((await post({ email: aff.email, password: aff.password })).statusCode).toBe(200);
    expect((await userRow(aff.id)).failedLogins).toBe(0);
    for (let i = 0; i < 9; i += 1) await post({ email: aff.email, password: WRONG });
    const row = await userRow(aff.id);
    expect(row.failedLogins).toBe(9);
    expect(row.lockedUntil).toBeNull();
    expect((await post({ email: aff.email, password: aff.password })).statusCode).toBe(200);
  });

  it('does not count attempts on a suspended account', async () => {
    const suspended = await seedUser(ctx, { role: 'affiliate', status: 'suspended' });
    for (let i = 0; i < 12; i += 1) await post({ email: suspended.email, password: WRONG });
    const row = await userRow(suspended.id);
    expect(row.failedLogins).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });
});

describe('POST /api/auth/login: rate limit and CSRF', () => {
  it('answers the sixth attempt in a minute from one address with 429 and Retry-After', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const address = '198.51.100.9';
    for (let i = 0; i < 5; i += 1) {
      const res = await post({ email: aff.email, password: WRONG }, { remoteAddress: address });
      expect(res.statusCode).toBe(401);
    }
    const limited = await post({ email: aff.email, password: aff.password }, { remoteAddress: address });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: 'too_many_attempts' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(limited.headers['set-cookie']).toBeUndefined();

    // Only attempts that reached the handler are logged; the limited one (right password) logged nothing.
    expect(await events()).toHaveLength(5);
    expect((await userRow(aff.id)).failedLogins).toBe(5);
    // Another address is not affected.
    expect((await post({ email: aff.email, password: aff.password })).statusCode).toBe(200);
  });

  it('refuses a request without x-requested-with or with a foreign origin', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const noHeader = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ctx.config.appOrigin },
      remoteAddress: freshAddress(),
      payload: { email: aff.email, password: aff.password },
    });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json()).toEqual({ code: 'csrf' });
    const foreign = await post(
      { email: aff.email, password: aff.password },
      { headers: { origin: 'https://evil.example' } },
    );
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toEqual({ code: 'csrf' });
    expect(await events()).toHaveLength(0);
  });
});

describe('POST /api/auth/login: sessions', () => {
  it('never reuses a cookie the client presents (session fixation)', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const bogus = 'dl_session=attackerchosenvalueattackerchosenvalue12';
    const res = await post({ email: aff.email, password: aff.password }, { headers: { cookie: bogus } });
    expect(res.statusCode).toBe(200);
    const issued = sessionCookieOf(res) as string;
    expect(issued).not.toBe(bogus);
    expect(issued.split('=')[1]).toHaveLength(43);
    const all = ([] as string[]).concat(res.headers['set-cookie'] as string | string[]);
    expect(all.filter((c) => c.startsWith('dl_session='))).toHaveLength(1);

    const planted = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: bogus } });
    expect(planted.statusCode).toBe(401);
    const real = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: issued } });
    expect(real.statusCode).toBe(200);
  });

  it('issues a new token and revokes the old session when a valid cookie is presented', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const first = await login(ctx, aff.email, aff.password);
    const res = await post({ email: aff.email, password: aff.password }, { headers: { cookie: first } });
    const second = sessionCookieOf(res) as string;
    expect(second).not.toBe(first);
    const old = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first } });
    expect(old.statusCode).toBe(401);
    const fresh = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second } });
    expect(fresh.statusCode).toBe(200);
  });

  it('leaves an existing session alone when the new login fails', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const first = await login(ctx, aff.email, aff.password);
    await post({ email: aff.email, password: WRONG }, { headers: { cookie: first } });
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first } });
    expect(me.statusCode).toBe(200);
  });

  it('stores only the sha256 of the token, never the token', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, aff.email, aff.password, undefined, { remember: true });
    const token = cookie.split('=')[1] as string;
    const rows = await ctx.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(token));
    expect(rows[0]?.tokenHash).not.toBe(token);
    expect(rows[0]?.remember).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(await ctx.db.select().from(users))).not.toContain(token);
    expect(JSON.stringify(await ctx.db.select().from(auditLog))).not.toContain(token);
  });

  it('lets only one of two parallel logins with the same code succeed', async () => {
    const user = await seedUser(ctx, { role: 'affiliate', totp: true });
    const code = totpCodeAt(user.totpSecret as string, ctx.clock.now);
    const results = await Promise.all([
      post({ email: user.email, password: user.password, totpCode: code }),
      post({ email: user.email, password: user.password, totpCode: code }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const loser = results.find((r) => r.statusCode === 401);
    expect(loser?.json()).toEqual({ code: 'totp_invalid' });
    expect(loser?.headers['set-cookie']).toBeUndefined();
    expect(await ctx.db.select().from(sessions)).toHaveLength(1);
  });
});

describe('POST /api/auth/login: session cookie attributes', () => {
  async function attributesFor(secure: boolean, remember: boolean) {
    const local = await createTestContext({ config: { cookieSecure: secure } });
    try {
      const aff = await seedUser(local, { role: 'affiliate' });
      const res = await post(
        { email: aff.email, password: aff.password, ...(remember ? { remember: true } : {}) },
        {},
        local,
      );
      expect(res.statusCode).toBe(200);
      const cookie = setCookieOf(res);
      const logout = await local.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { ...csrfHeaders(local), cookie: cookie.split(';')[0] as string },
      });
      return { cookie, attrs: cookieAttributes(cookie), logoutCookie: setCookieOf(logout) };
    } finally {
      await local.close();
    }
  }

  it.each([
    { secure: false, remember: false },
    { secure: false, remember: true },
    { secure: true, remember: false },
    { secure: true, remember: true },
  ])('secure=$secure remember=$remember', async ({ secure, remember }) => {
    const { cookie, attrs, logoutCookie } = await attributesFor(secure, remember);
    const name = secure ? '__Host-dl_session' : 'dl_session';
    expect(cookie.startsWith(`${name}=`)).toBe(true);
    expect(attrs).toEqual(expect.arrayContaining(['httponly', 'samesite=lax', 'path=/']));
    expect(attrs.includes('secure')).toBe(secure);
    expect(attrs.some((a) => a.startsWith('domain'))).toBe(false);
    const maxAge = attrs.find((a) => a.startsWith('max-age='));
    expect(maxAge).toBe(remember ? 'max-age=2592000' : undefined);
    expect(attrs.some((a) => a.startsWith('expires='))).toBe(false);

    // Logout expires the same cookie with the same attributes.
    const cleared = cookieAttributes(logoutCookie);
    expect(logoutCookie.startsWith(`${name}=;`)).toBe(true);
    expect(cleared).toEqual(expect.arrayContaining(['httponly', 'samesite=lax', 'path=/', 'max-age=0']));
    expect(cleared.includes('secure')).toBe(secure);
    expect(cleared.some((a) => a.startsWith('expires=thu, 01 jan 1970'))).toBe(true);
  });
});

describe('POST /api/auth/login: attempts are reserved atomically', () => {
  const reasons = async () => (await events()).map((e) => e.reason);
  const count = async (reason: string) => (await reasons()).filter((r) => r === reason).length;

  it('lets at most ten of forty parallel wrong passwords be checked, then refuses the right one', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const burst = await Promise.all(
      Array.from({ length: 40 }, () => post({ email: aff.email, password: WRONG })),
    );
    for (const res of burst) {
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe('{"code":"invalid_credentials"}');
    }
    expect(await count('bad_password')).toBe(10);
    expect(await count('locked')).toBe(30);
    const locked = await userRow(aff.id);
    expect(locked.failedLogins).toBe(10);
    expect(locked.lockedUntil?.getTime()).toBe(ctx.clock.now.getTime() + 15 * 60_000);

    const right = await post({ email: aff.email, password: aff.password });
    expect(right.statusCode).toBe(401);
    expect(right.body).toBe('{"code":"invalid_credentials"}');
    expect(right.headers['set-cookie']).toBeUndefined();
    expect(await ctx.db.select().from(sessions)).toHaveLength(0);
    const still = await userRow(aff.id);
    expect(still.failedLogins).toBe(10);
    expect(still.lockedUntil?.getTime()).toBe(locked.lockedUntil?.getTime());

    ctx.clock.advance(15 * 60_000);
    expect((await post({ email: aff.email, password: aff.password })).statusCode).toBe(200);
    expect((await userRow(aff.id)).failedLogins).toBe(0);
  });

  it('bounds a burst that includes the right password, and never loses a lock to it', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const results = await Promise.all([
      ...Array.from({ length: 40 }, () => post({ email: aff.email, password: WRONG })),
      post({ email: aff.email, password: aff.password }),
    ]);
    const ok = await count('ok');
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(ok);
    expect(ok).toBeLessThanOrEqual(1);
    expect((await events()).length).toBe(41);
    // Every success reopens a window of ten checks; without one the cap is ten in total.
    expect(await count('bad_password')).toBeLessThanOrEqual(10 * (ok + 1));
    const row = await userRow(aff.id);
    if (ok === 0) {
      expect(row.lockedUntil).not.toBeNull();
      expect(row.failedLogins).toBe(10);
    }
  });

  it('after a success the counter is clear, and a later burst gets a fresh window of ten', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    for (let i = 0; i < 4; i += 1) await post({ email: aff.email, password: WRONG });
    expect((await post({ email: aff.email, password: aff.password })).statusCode).toBe(200);
    const row = await userRow(aff.id);
    expect(row.failedLogins).toBe(0);
    expect(row.lockedUntil).toBeNull();
    await Promise.all(Array.from({ length: 25 }, () => post({ email: aff.email, password: WRONG })));
    expect(await count('bad_password')).toBe(4 + 10);
    expect((await userRow(aff.id)).lockedUntil).not.toBeNull();
  });

  it('never locks an account by repeating the right password without a code', async () => {
    const user = await seedUser(ctx, { role: 'affiliate', totp: true });
    for (let i = 0; i < 12; i += 1) {
      const res = await post({ email: user.email, password: user.password });
      expect(res.json()).toEqual({ code: 'totp_required' });
      const row = await userRow(user.id);
      expect(row.failedLogins).toBe(0);
      expect(row.lockedUntil).toBeNull();
    }
    expect(await count('totp_required')).toBe(12);
    const code = totpCodeAt(user.totpSecret as string, ctx.clock.now);
    expect((await post({ email: user.email, password: user.password, totpCode: code })).statusCode).toBe(200);
  });

  it('releases a missing-code reservation even when it was the tenth attempt', async () => {
    const user = await seedUser(ctx, { role: 'affiliate', totp: true });
    const valid = totpCodeAt(user.totpSecret as string, ctx.clock.now);
    const wrong = String((Number(valid) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 9; i += 1) {
      await post({ email: user.email, password: user.password, totpCode: wrong });
    }
    expect((await userRow(user.id)).failedLogins).toBe(9);
    const res = await post({ email: user.email, password: user.password });
    expect(res.json()).toEqual({ code: 'totp_required' });
    const row = await userRow(user.id);
    expect(row.failedLogins).toBe(9);
    expect(row.lockedUntil).toBeNull();
    expect((await post({ email: user.email, password: user.password, totpCode: valid })).statusCode).toBe(200);
  });

  it('locks after ten wrong codes given with the right password', async () => {
    const user = await seedUser(ctx, { role: 'affiliate', totp: true });
    const valid = totpCodeAt(user.totpSecret as string, ctx.clock.now);
    const wrong = String((Number(valid) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 10; i += 1) {
      const res = await post({ email: user.email, password: user.password, totpCode: wrong });
      expect(res.json()).toEqual({ code: 'totp_invalid' });
    }
    expect(await count('totp_invalid')).toBe(10);
    const row = await userRow(user.id);
    expect(row.failedLogins).toBe(10);
    expect(row.lockedUntil).not.toBeNull();
    const refused = await post({ email: user.email, password: user.password, totpCode: valid });
    expect(refused.json()).toEqual({ code: 'invalid_credentials' });
    expect(refused.headers['set-cookie']).toBeUndefined();
  });

  // A lock that lands while the password is being verified must win over that attempt. The
  // `onVerified` seam runs right after the password check, so the test can lock the account at
  // exactly that moment instead of hoping a race happens.
  describe('a lock that lands during verification', () => {
    function attempt(overrides: Partial<LoginAttempt> & Pick<LoginAttempt, 'email' | 'password'>): LoginAttempt {
      return {
        remember: false,
        totpCode: undefined,
        ip: '203.0.113.50',
        userAgent: 'Vitest/1',
        presentedSessionId: undefined,
        ...overrides,
      };
    }
    const lockDuringVerify = (id: string) => async () => {
      await ctx.db
        .update(users)
        .set({ failedLogins: 10, lockedUntil: new Date(ctx.clock.now.getTime() + 15 * 60_000) })
        .where(eq(users.id, id));
    };

    it('refuses the right password, creates no session and leaves the counters alone', async () => {
      const aff = await seedUser(ctx, { role: 'affiliate' });
      const outcome = await attemptLogin(
        { db: ctx.db, config: ctx.config, clock: ctx.clock, onVerified: lockDuringVerify(aff.id) },
        attempt({ email: aff.email, password: aff.password }),
      );
      expect(outcome).toEqual({ kind: 'invalid_credentials' });
      expect(await ctx.db.select().from(sessions)).toHaveLength(0);
      const row = await userRow(aff.id);
      expect(row.failedLogins).toBe(10);
      expect(row.lockedUntil?.getTime()).toBe(ctx.clock.now.getTime() + 15 * 60_000);
      expect(row.lastLoginAt).toBeNull();
      expect(await reasons()).toEqual(['locked']);
    });

    it('does the same for a valid code, and does not spend the code', async () => {
      const user = await seedUser(ctx, { role: 'affiliate', totp: true });
      const code = totpCodeAt(user.totpSecret as string, ctx.clock.now);
      const outcome = await attemptLogin(
        { db: ctx.db, config: ctx.config, clock: ctx.clock, onVerified: lockDuringVerify(user.id) },
        attempt({ email: user.email, password: user.password, totpCode: code }),
      );
      expect(outcome).toEqual({ kind: 'invalid_credentials' });
      expect(await ctx.db.select().from(sessions)).toHaveLength(0);
      const row = await userRow(user.id);
      expect(row.totpLastStep).toBeNull();
      expect(row.failedLogins).toBe(10);
      expect(await reasons()).toEqual(['locked']);
    });

    it('does not lift a lock when the tenth attempt of a window is someone else’s', async () => {
      const aff = await seedUser(ctx, { role: 'affiliate' });
      await ctx.db.update(users).set({ failedLogins: 8 }).where(eq(users.id, aff.id));
      // This attempt reserves the 9th slot; a concurrent attempt then takes the 10th and locks.
      const outcome = await attemptLogin(
        {
          db: ctx.db,
          config: ctx.config,
          clock: ctx.clock,
          onVerified: async () => {
            await post({ email: aff.email, password: WRONG });
          },
        },
        attempt({ email: aff.email, password: aff.password }),
      );
      expect(outcome).toEqual({ kind: 'invalid_credentials' });
      expect(await ctx.db.select().from(sessions)).toHaveLength(0);
      expect((await userRow(aff.id)).lockedUntil).not.toBeNull();
      expect(await reasons()).toEqual(['bad_password', 'locked']);
    });
  });
});
