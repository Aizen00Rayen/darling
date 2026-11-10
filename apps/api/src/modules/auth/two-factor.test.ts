import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, sessions, settings, users } from '../../db/schema';
import { decryptSecret } from '../../lib/crypto';
import {
  createTestContext,
  csrfHeaders,
  freshAddress,
  login,
  seedUser,
  totpCodeAt,
  type SeededUser,
  type TestContext,
} from '../../../test/context';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

const STEP_MS = 30_000;

function post(path: string, cookie: string | undefined, payload?: Record<string, unknown>, remoteAddress?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: path,
    headers: { ...csrfHeaders(ctx), ...(cookie === undefined ? {} : { cookie }) },
    remoteAddress: remoteAddress ?? freshAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

const setup = (cookie?: string) => post('/api/auth/2fa/setup', cookie);
const enable = (cookie: string | undefined, code: string) => post('/api/auth/2fa/enable', cookie, { code });
const disable = (cookie: string | undefined, password: string, code: string) =>
  post('/api/auth/2fa/disable', cookie, { password, code });
const changePassword = (cookie: string | undefined, currentPassword: string, newPassword: string) =>
  post('/api/auth/password/change', cookie, { currentPassword, newPassword });

async function me(cookie: string) {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  return res;
}

async function userRow(id: string) {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
  if (!row) throw new Error('user not found');
  return row;
}

function audits() {
  return ctx.db.select().from(auditLog).orderBy(asc(auditLog.id));
}

/** A well-formed code that is not valid at `at` for any step the verifier tolerates (one step either side). */
function wrongCode(secret: string, at: Date): string {
  const valid = new Set([-1, 0, 1].map((offset) => totpCodeAt(secret, at, offset)));
  for (let n = 0; n < 1_000_000; n += 7919) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error('no wrong code found');
}

const WRONG = 'Wrong-gloss-2026';

async function owner(): Promise<{ user: SeededUser; cookie: string }> {
  const user = await seedUser(ctx, { role: 'super_manager', isOwner: true });
  return { user, cookie: await login(ctx, user.email, user.password) };
}

async function affiliate(options: { totp?: boolean; totpAt?: Date } = {}): Promise<{ user: SeededUser; cookie: string }> {
  const user = await seedUser(ctx, { role: 'affiliate', ...(options.totp ? { totp: true } : {}) });
  const cookie = await login(
    ctx,
    user.email,
    user.password,
    user.totpSecret === undefined ? undefined : totpCodeAt(user.totpSecret, ctx.clock.now),
  );
  return { user, cookie };
}

describe('access', () => {
  it('answers 401 to an unauthenticated caller on every route, before looking at the body', async () => {
    expect((await setup()).statusCode).toBe(401);
    for (const res of [
      await enable(undefined, '123456'),
      await enable(undefined, 'not-a-code'),
      await disable(undefined, 'x', '123456'),
      await changePassword(undefined, 'x', 'y'),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: 'unauthenticated' });
    }
  });

  it('lets a Super Manager who must still enrol call all four routes', async () => {
    const { user, cookie } = await owner();
    expect((await me(cookie)).json().mustEnroll2fa).toBe(true);

    const setupRes = await setup(cookie);
    expect(setupRes.statusCode).toBe(200);
    const secret = setupRes.json().secret as string;

    const badEnable = await enable(cookie, wrongCode(secret, ctx.clock.now));
    expect(badEnable.statusCode).toBe(400);
    expect(badEnable.json()).toEqual({ code: 'totp_invalid' });

    const badChange = await changePassword(cookie, WRONG, 'Another-gloss-2027');
    expect(badChange.statusCode).toBe(401);
    expect(badChange.json()).toEqual({ code: 'invalid_credentials' });

    // Refused for its own reason, not because enrolment is pending.
    const refused = await disable(cookie, user.password, '123456');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ code: '2fa_required_for_role' });
  });
});

describe('POST /api/auth/2fa/setup and /enable', () => {
  it('sets up, enables with a code from the returned secret, and clears mustEnroll2fa', async () => {
    const { user, cookie } = await owner();
    expect((await me(cookie)).json()).toMatchObject({ twoFactorEnabled: false, mustEnroll2fa: true });

    const res = await setup(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { otpauthUrl: string; secret: string };
    expect(Object.keys(body).sort()).toEqual(['otpauthUrl', 'secret']);
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(body.otpauthUrl).toContain(`secret=${body.secret}`);
    expect(body.otpauthUrl).toContain(encodeURIComponent(user.email));
    expect(body.otpauthUrl).toContain('issuer=');

    // Nothing is on yet.
    expect((await userRow(user.id)).totpEnabled).toBe(false);
    expect((await me(cookie)).json()).toMatchObject({ twoFactorEnabled: false, mustEnroll2fa: true });

    const enabled = await enable(cookie, totpCodeAt(body.secret, ctx.clock.now));
    expect(enabled.statusCode).toBe(204);
    expect(enabled.body).toBe('');

    expect((await me(cookie)).json()).toMatchObject({ twoFactorEnabled: true, mustEnroll2fa: false });
    const row = await userRow(user.id);
    expect(row.totpEnabled).toBe(true);
    expect(row.totpLastStep).toBe(Math.floor(ctx.clock.now.getTime() / STEP_MS));
  });

  it('stores the secret encrypted, never in the clear', async () => {
    const { user, cookie } = await affiliate();
    const secret = (await setup(cookie)).json().secret as string;
    const row = await userRow(user.id);
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecretEnc).not.toBeNull();
    expect(row.totpSecretEnc).not.toBe(secret);
    expect(row.totpSecretEnc).not.toContain(secret);
    expect(row.totpSecretEnc).toMatch(/^v1:/);
    expect(decryptSecret(row.totpSecretEnc as string, ctx.config.encryptionKey)).toBe(secret);
  });

  it('issues a fresh secret on every setup, and only the last one validates', async () => {
    const { user, cookie } = await affiliate();
    const first = (await setup(cookie)).json().secret as string;
    const second = (await setup(cookie)).json().secret as string;
    expect(second).not.toBe(first);

    const stale = await enable(cookie, totpCodeAt(first, ctx.clock.now));
    expect(stale.statusCode).toBe(400);
    expect(stale.json()).toEqual({ code: 'totp_invalid' });
    expect((await userRow(user.id)).totpEnabled).toBe(false);

    expect((await enable(cookie, totpCodeAt(second, ctx.clock.now))).statusCode).toBe(204);
    expect((await userRow(user.id)).totpEnabled).toBe(true);
  });

  it('refuses setup and enable with 409 already_enabled once 2FA is on, and keeps the secret', async () => {
    const { user, cookie } = await affiliate();
    const secret = (await setup(cookie)).json().secret as string;
    const code = totpCodeAt(secret, ctx.clock.now);
    expect((await enable(cookie, code)).statusCode).toBe(204);
    const before = (await userRow(user.id)).totpSecretEnc;

    const again = await setup(cookie);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ code: 'already_enabled' });
    expect(again.body).not.toContain(secret);
    expect((await userRow(user.id)).totpSecretEnc).toBe(before);

    // The same code twice: the second request finds 2FA already on.
    const twice = await enable(cookie, code);
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toEqual({ code: 'already_enabled' });
  });

  it('answers a wrong code with 400 totp_invalid and leaves 2FA off', async () => {
    const { user, cookie } = await affiliate();
    const secret = (await setup(cookie)).json().secret as string;
    const res = await enable(cookie, wrongCode(secret, ctx.clock.now));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: 'totp_invalid' });
    const row = await userRow(user.id);
    expect(row.totpEnabled).toBe(false);
    expect(row.totpLastStep).toBeNull();
    expect(await audits()).toHaveLength(0);

    // A malformed code is a validation error, and nothing is enabled either.
    const malformed = await enable(cookie, '12ab');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe('validation');
    expect((await userRow(user.id)).totpEnabled).toBe(false);
  });

  it('answers 400 no_pending_setup when enable is called without a setup', async () => {
    const { user, cookie } = await affiliate();
    const res = await enable(cookie, '123456');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: 'no_pending_setup' });
    expect((await userRow(user.id)).totpEnabled).toBe(false);
  });

  it('keeps the enabling code from being replayed at login within its window, but accepts the next one', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, user.email, user.password);
    const secret = (await setup(cookie)).json().secret as string;
    const code = totpCodeAt(secret, ctx.clock.now);
    expect((await enable(cookie, code)).statusCode).toBe(204);

    const attempt = (totpCode: string) =>
      post('/api/auth/login', undefined, { email: user.email, password: user.password, totpCode });

    const replay = await attempt(code);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ code: 'totp_invalid' });
    expect(replay.headers['set-cookie']).toBeUndefined();

    // The previous step is inside the 90 s window too, but it is no later than the stored step.
    const earlier = await attempt(totpCodeAt(secret, ctx.clock.now, -1));
    expect(earlier.statusCode).toBe(401);

    ctx.clock.advance(STEP_MS);
    const next = await attempt(totpCodeAt(secret, ctx.clock.now));
    expect(next.statusCode).toBe(200);
  });
});

describe('POST /api/auth/2fa/disable', () => {
  it('refuses a Super Manager with 403 2fa_required_for_role, whatever the credentials', async () => {
    const owners = await Promise.all([
      seedUser(ctx, { role: 'super_manager', isOwner: true, totp: true }),
      seedUser(ctx, { role: 'super_manager', totp: true, permissions: ['users.manage'] }),
    ]);
    for (const sm of owners) {
      const secret = sm.totpSecret as string;
      const cookie = await login(ctx, sm.email, sm.password, totpCodeAt(secret, ctx.clock.now));
      ctx.clock.advance(STEP_MS);
      const code = totpCodeAt(secret, ctx.clock.now);

      for (const [password, c] of [
        [sm.password, code],
        [WRONG, code],
        [sm.password, wrongCode(secret, ctx.clock.now)],
        [WRONG, wrongCode(secret, ctx.clock.now)],
      ] as const) {
        const res = await disable(cookie, password, c);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ code: '2fa_required_for_role' });
      }
      const row = await userRow(sm.id);
      expect(row.totpEnabled).toBe(true);
      expect(row.totpSecretEnc).not.toBeNull();
      // The refused attempts did not spend the code.
      expect(row.totpLastStep).toBe(Math.floor((ctx.clock.now.getTime() - STEP_MS) / STEP_MS));
    }
    expect(await audits()).toHaveLength(0);
  });

  it('lets a Super Manager disable when the requirement is switched off', async () => {
    await ctx.db.insert(settings).values({ key: 'security.require_2fa_super_managers', value: false });
    const sm = await seedUser(ctx, { role: 'super_manager', isOwner: true, totp: true });
    const secret = sm.totpSecret as string;
    const cookie = await login(ctx, sm.email, sm.password, totpCodeAt(secret, ctx.clock.now));
    ctx.clock.advance(STEP_MS);
    const res = await disable(cookie, sm.password, totpCodeAt(secret, ctx.clock.now));
    expect(res.statusCode).toBe(204);
    expect((await userRow(sm.id)).totpEnabled).toBe(false);
  });

  it('lets an affiliate disable with password and code, clearing the secret', async () => {
    const { user, cookie } = await affiliate({ totp: true });
    const secret = user.totpSecret as string;
    // The login consumed this step; a fresh one is needed.
    ctx.clock.advance(STEP_MS);

    const res = await disable(cookie, user.password, totpCodeAt(secret, ctx.clock.now));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    const row = await userRow(user.id);
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecretEnc).toBeNull();
    expect(row.totpLastStep).toBeNull();
    expect((await me(cookie)).json().twoFactorEnabled).toBe(false);
    // Login no longer asks for a code.
    await login(ctx, user.email, user.password);
  });

  it('answers 401 invalid_credentials for a wrong password and 400 totp_invalid for a wrong code', async () => {
    const { user, cookie } = await affiliate({ totp: true });
    const secret = user.totpSecret as string;
    ctx.clock.advance(STEP_MS);
    const code = totpCodeAt(secret, ctx.clock.now);

    const badPassword = await disable(cookie, WRONG, code);
    expect(badPassword.statusCode).toBe(401);
    expect(badPassword.json()).toEqual({ code: 'invalid_credentials' });

    const badCode = await disable(cookie, user.password, wrongCode(secret, ctx.clock.now));
    expect(badCode.statusCode).toBe(400);
    expect(badCode.json()).toEqual({ code: 'totp_invalid' });

    const row = await userRow(user.id);
    expect(row.totpEnabled).toBe(true);
    expect(row.totpSecretEnc).not.toBeNull();
    // Neither failure spent the valid code.
    expect((await disable(cookie, user.password, code)).statusCode).toBe(204);
  });

  it('refuses a code already used at login, and takes the next one', async () => {
    const { user, cookie } = await affiliate({ totp: true });
    const secret = user.totpSecret as string;
    // Same step as the login that created the session.
    const replay = await disable(cookie, user.password, totpCodeAt(secret, ctx.clock.now));
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ code: 'totp_invalid' });
    expect((await userRow(user.id)).totpEnabled).toBe(true);

    ctx.clock.advance(STEP_MS);
    expect((await disable(cookie, user.password, totpCodeAt(secret, ctx.clock.now))).statusCode).toBe(204);
  });

  it('refuses the same code a second time (replay of a disable code)', async () => {
    const { user, cookie } = await affiliate({ totp: true });
    const secret = user.totpSecret as string;
    ctx.clock.advance(STEP_MS);
    const code = totpCodeAt(secret, ctx.clock.now);
    expect((await disable(cookie, user.password, code)).statusCode).toBe(204);
    const again = await disable(cookie, user.password, code);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ code: 'not_enabled' });
  });

  it('only one of two parallel disables with the same code succeeds', async () => {
    const { user, cookie } = await affiliate({ totp: true });
    const secret = user.totpSecret as string;
    ctx.clock.advance(STEP_MS);
    const code = totpCodeAt(secret, ctx.clock.now);
    const results = await Promise.all([disable(cookie, user.password, code), disable(cookie, user.password, code)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, expect.any(Number)]);
    expect((await audits()).filter((a) => a.action === 'auth.2fa_disabled')).toHaveLength(1);
  });
});

describe('POST /api/auth/password/change', () => {
  const NEW = 'Brand-new-gloss-2027';

  it('refuses a new password that fails the policy, with a French message on newPassword', async () => {
    const { user, cookie } = await affiliate();

    const common = await changePassword(cookie, user.password, 'password123');
    expect(common.statusCode).toBe(400);
    expect(common.json().code).toBe('validation');
    expect(common.json().errors.newPassword).toMatch(/trop courant/);

    const short = await changePassword(cookie, user.password, 'abcdefghi');
    expect(short.statusCode).toBe(400);
    expect(short.json().errors.newPassword).toMatch(/au moins 10 caractères/);

    const same = await changePassword(cookie, user.password, user.password);
    expect(same.statusCode).toBe(400);
    expect(same.json()).toEqual({
      code: 'validation',
      errors: { newPassword: 'Le nouveau mot de passe doit être différent de l’ancien.' },
    });

    // Nothing changed.
    await login(ctx, user.email, user.password);
    expect(await audits()).toHaveLength(0);
  });

  it('answers 401 invalid_credentials for a wrong current password', async () => {
    const { user, cookie } = await affiliate();
    const res = await changePassword(cookie, WRONG, NEW);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'invalid_credentials' });
    await login(ctx, user.email, user.password);
    expect(await audits()).toHaveLength(0);
  });

  it('changes the hash, ends every other session and keeps the current one', async () => {
    const { user, cookie } = await affiliate();
    const otherDevice = await login(ctx, user.email, user.password);
    const bystander = await affiliate();
    const hashBefore = (await userRow(user.id)).passwordHash;

    const res = await changePassword(cookie, user.password, NEW);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const hashAfter = (await userRow(user.id)).passwordHash as string;
    expect(hashAfter).not.toBe(hashBefore);
    expect(hashAfter).toMatch(/^\$argon2id\$/);

    expect((await me(cookie)).statusCode).toBe(200);
    expect((await me(otherDevice)).statusCode).toBe(401);
    // Someone else's session is untouched.
    expect((await me(bystander.cookie)).statusCode).toBe(200);

    const old = await post('/api/auth/login', undefined, { email: user.email, password: user.password });
    expect(old.statusCode).toBe(401);
    await login(ctx, user.email, NEW);
  });

  it('stamps the revocation with the injected clock', async () => {
    const { user, cookie } = await affiliate();
    await login(ctx, user.email, user.password);
    ctx.clock.advance(60_000);
    expect((await changePassword(cookie, user.password, NEW)).statusCode).toBe(204);
    const rows = await ctx.db.select().from(sessions).where(eq(sessions.userId, user.id));
    const revoked = rows.filter((s) => s.revokedAt !== null);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.revokedAt?.getTime()).toBe(ctx.clock.now.getTime());
  });
});

describe('rate limits (per authenticated user, not per address)', () => {
  it('answers the sixth password/change in a minute with 429 for that user, from any address, not for another', async () => {
    const a = await affiliate();
    const b = await affiliate();
    for (let i = 0; i < 5; i += 1) {
      const res = await post('/api/auth/password/change', a.cookie, { currentPassword: WRONG, newPassword: 'Brand-new-gloss-2027' }, freshAddress());
      expect(res.statusCode).toBe(401);
    }
    // A different address does not buy a fresh allowance, and the right password no longer gets through.
    const limited = await post(
      '/api/auth/password/change',
      a.cookie,
      { currentPassword: a.user.password, newPassword: 'Brand-new-gloss-2027' },
      freshAddress(),
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: 'too_many_attempts' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(await audits()).toHaveLength(0);

    // Another user, even from the very address that was limited, is unaffected.
    const ok = await post(
      '/api/auth/password/change',
      b.cookie,
      { currentPassword: b.user.password, newPassword: 'Brand-new-gloss-2027' },
      '203.0.113.7',
    );
    expect(ok.statusCode).toBe(204);
  });

  it('limits 2fa/enable and 2fa/disable the same way, each on its own count', async () => {
    const a = await affiliate();
    const secret = (await setup(a.cookie)).json().secret as string;
    for (let i = 0; i < 5; i += 1) {
      expect((await enable(a.cookie, wrongCode(secret, ctx.clock.now))).statusCode).toBe(400);
    }
    const limited = await enable(a.cookie, totpCodeAt(secret, ctx.clock.now));
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: 'too_many_attempts' });
    expect((await userRow(a.user.id)).totpEnabled).toBe(false);
    // setup does not verify anything and is not limited by it.
    expect((await setup(a.cookie)).statusCode).toBe(200);

    const b = await affiliate({ totp: true });
    const bSecret = b.user.totpSecret as string;
    ctx.clock.advance(STEP_MS);
    for (let i = 0; i < 5; i += 1) {
      expect((await disable(b.cookie, WRONG, totpCodeAt(bSecret, ctx.clock.now))).statusCode).toBe(401);
    }
    const stopped = await disable(b.cookie, b.user.password, totpCodeAt(bSecret, ctx.clock.now));
    expect(stopped.statusCode).toBe(429);
    expect(stopped.json()).toEqual({ code: 'too_many_attempts' });
    expect((await userRow(b.user.id)).totpEnabled).toBe(true);
  });
});

describe('audit and secrecy', () => {
  it('records each success with no secret, password, hash or code in the entry', async () => {
    const { user, cookie } = await affiliate();
    const hashBefore = (await userRow(user.id)).passwordHash as string;
    const NEW = 'Brand-new-gloss-2027';

    const secret = (await setup(cookie)).json().secret as string;
    const enableCode = totpCodeAt(secret, ctx.clock.now);
    expect((await enable(cookie, enableCode)).statusCode).toBe(204);
    expect((await changePassword(cookie, user.password, NEW)).statusCode).toBe(204);
    const hashAfter = (await userRow(user.id)).passwordHash as string;
    const enc = (await userRow(user.id)).totpSecretEnc as string;
    ctx.clock.advance(STEP_MS);
    const disableCode = totpCodeAt(secret, ctx.clock.now);
    expect((await disable(cookie, NEW, disableCode)).statusCode).toBe(204);

    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['auth.2fa_enabled', 'auth.password_changed', 'auth.2fa_disabled']);
    for (const row of rows) {
      expect(row.entityType).toBe('user');
      expect(row.entityId).toBe(user.id);
      expect(row.actorUserId).toBe(user.id);
      expect(row.ip).toEqual(expect.any(String));
      expect(row.requestId).toEqual(expect.any(String));
    }
    expect(rows[0]).toMatchObject({ before: { twoFactorEnabled: false }, after: { twoFactorEnabled: true } });
    expect(rows[2]).toMatchObject({ before: { twoFactorEnabled: true }, after: { twoFactorEnabled: false } });

    const dump = JSON.stringify(rows);
    for (const secretThing of [secret, enc, user.password, NEW, hashBefore, hashAfter, '$argon2']) {
      expect(dump).not.toContain(secretThing);
    }
    // Codes are six digits, so look for them only where free-form content could carry them (ids and
    // timestamps elsewhere in the row could contain six digits by chance).
    const content = JSON.stringify(rows.map((r) => [r.before, r.after, r.reason]));
    for (const code of [enableCode, disableCode]) expect(content).not.toContain(code);
  });

  it('returns the secret only from setup: not from /me, not from errors, not from later calls', async () => {
    const { cookie } = await affiliate();
    const setupRes = await setup(cookie);
    const secret = setupRes.json().secret as string;
    expect(setupRes.body).toContain(secret);

    const everything = [
      await me(cookie),
      await enable(cookie, wrongCode(secret, ctx.clock.now)),
      await enable(cookie, totpCodeAt(secret, ctx.clock.now)),
      await setup(cookie),
      await me(cookie),
    ];
    for (const res of everything) {
      expect(res.body).not.toContain(secret);
      expect(JSON.stringify(res.headers)).not.toContain(secret);
    }
    expect(JSON.stringify(await audits())).not.toContain(secret);
  });
});
