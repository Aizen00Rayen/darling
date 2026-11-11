import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptSecret } from '../security/crypto';
import { newTotpSecret } from '../security/totp';
import { createTestApp, freshIp, login, seedUser, snap, totpCodeAt, wrongCode, type TestApp, type SeededUser } from '../test/app';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => app.close());

type UserRow = { totp_secret_enc: string | null; totp_enabled: number; totp_last_step: number | null; password_hash: string };
const userRow = (id: string) => app.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id) as UserRow;
type Audit = { actor_user_id: string | null; action: string; entity_type: string; entity_id: string; before: string | null; after: string | null; ip: string | null };
const audits = () => app.db.all<Audit>('SELECT * FROM audit_log ORDER BY id');

const S = '/api/auth/2fa/setup';
const E = '/api/auth/2fa/enable';
const D = '/api/auth/2fa/disable';
const C = '/api/auth/password/change';

async function signedIn(input: Parameters<typeof seedUser>[1] = { role: 'affiliate' }): Promise<{ u: SeededUser; cookie: string }> {
  const u = await seedUser(app, input);
  const code = u.totpSecret ? totpCodeAt(u.totpSecret, app.clock.now()) : undefined;
  return { u, cookie: await login(app, u.email, u.password, { totpCode: code }) };
}
const setup = async (cookie: string) => (await (await app.call(S, { method: 'POST', cookie })).json()) as { secret: string; otpauthUrl: string };

describe('access', () => {
  it('answers 401 to an unauthenticated caller on every route, before looking at the body', async () => {
    for (const path of [S, E, D, C]) {
      const res = await app.call(path, { body: { nonsense: true } });
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ code: 'unauthenticated' });
    }
  });

  it('lets a Super Manager who must still enrol call all four routes', async () => {
    const { u, cookie } = await signedIn({ role: 'super_manager' });
    expect((await app.call('/api/auth/me', { cookie })).status).toBe(200);
    expect((await app.call(S, { method: 'POST', cookie })).status).toBe(200);
    for (const [path, body] of [[E, { password: u.password, code: '123456' }], [D, { password: u.password, code: '123456' }], [C, { currentPassword: u.password, newPassword: u.password }]] as const) {
      const res = await app.call(path, { body, cookie });
      // never the enrolment refusal (disable answers its own 403 2fa_required_for_role for a Super Manager)
      expect(((await res.json().catch(() => ({}))) as { code?: string }).code, path).not.toBe('2fa_enrollment_required');
    }
  });
});

describe('POST /api/auth/2fa/setup and /enable', () => {
  it('sets up, enables with a code from the returned secret, and clears mustEnroll2fa', async () => {
    const { u, cookie } = await signedIn({ role: 'super_manager' });
    expect(((await (await app.call('/api/auth/me', { cookie })).json()) as { mustEnroll2fa: boolean }).mustEnroll2fa).toBe(true);
    const res = await app.call(S, { method: 'POST', cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { secret, otpauthUrl } = (await res.json()) as { secret: string; otpauthUrl: string };
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(otpauthUrl).toContain(`secret=${secret}`);
    const en = await app.call(E, { body: { password: u.password, code: totpCodeAt(secret, app.clock.now()) }, cookie });
    expect(en.status).toBe(204);
    const me = (await (await app.call('/api/auth/me', { cookie })).json()) as { twoFactorEnabled: boolean; mustEnroll2fa: boolean };
    expect(me).toMatchObject({ twoFactorEnabled: true, mustEnroll2fa: false });
    // the account now needs the code to log in
    const again = await app.call('/api/auth/login', { body: { email: u.email, password: u.password } });
    expect(await again.json()).toEqual({ code: 'totp_required' });
  });

  it('stores the secret encrypted, never in the clear', async () => {
    const { u, cookie } = await signedIn();
    const { secret } = await setup(cookie);
    const stored = userRow(u.id).totp_secret_enc as string;
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored, app.config.encryptionKey)).toBe(secret);
    expect(userRow(u.id).totp_enabled).toBe(0);
  });

  it('issues a fresh secret on every setup, and only the last one validates', async () => {
    const { u, cookie } = await signedIn();
    const first = await setup(cookie);
    const second = await setup(cookie);
    expect(second.secret).not.toBe(first.secret);
    const wrong = await app.call(E, { body: { password: u.password, code: totpCodeAt(first.secret, app.clock.now()) }, cookie });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ code: 'totp_invalid' });
    expect((await app.call(E, { body: { password: u.password, code: totpCodeAt(second.secret, app.clock.now()) }, cookie })).status).toBe(204);
  });

  it('refuses setup and enable with 409 already_enabled once 2FA is on, and keeps the secret', async () => {
    const { u, cookie } = await signedIn({ role: 'affiliate', totp: true });
    const before = userRow(u.id).totp_secret_enc;
    const s = await app.call(S, { method: 'POST', cookie });
    expect(s.status).toBe(409);
    expect(await s.json()).toEqual({ code: 'already_enabled' });
    const e = await app.call(E, { body: { password: u.password, code: totpCodeAt(u.totpSecret as string, app.clock.now(), 1) }, cookie });
    expect(e.status).toBe(409);
    expect(userRow(u.id).totp_secret_enc).toBe(before);
  });

  it('answers a wrong code with 400 totp_invalid and leaves 2FA off', async () => {
    const { u, cookie } = await signedIn();
    const { secret } = await setup(cookie);
    const res = await app.call(E, { body: { password: u.password, code: wrongCode(secret, app.clock.now()) }, cookie });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'totp_invalid' });
    expect(userRow(u.id).totp_enabled).toBe(0);
    expect(audits()).toHaveLength(0);
  });

  it('answers 400 no_pending_setup when enable is called without a setup', async () => {
    const { u, cookie } = await signedIn();
    const res = await app.call(E, { body: { password: u.password, code: '123456' }, cookie });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'no_pending_setup' });
  });

  it('needs the current password to enable: wrong is 401 and leaves 2FA off, missing is a validation error', async () => {
    const { u, cookie } = await signedIn();
    const { secret } = await setup(cookie);
    const code = totpCodeAt(secret, app.clock.now());
    const wrong = await app.call(E, { body: { password: 'Not-the-password-1', code }, cookie });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ code: 'invalid_credentials' });
    expect(userRow(u.id).totp_enabled).toBe(0);
    const missing = await app.call(E, { body: { code }, cookie });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { code: string }).code).toBe('validation');
    const badCode = await app.call(E, { body: { password: u.password, code: '12345' }, cookie });
    expect(badCode.status).toBe(400);
    expect(((await badCode.json()) as { errors: object }).errors).toHaveProperty('code');
    expect(userRow(u.id).totp_enabled).toBe(0);
  });

  it('does not let a stolen session take over enrolment: the victim can still log in without a code', async () => {
    const { u, cookie } = await signedIn();
    const { secret } = await setup(cookie);
    // the thief has the cookie and a valid code for their own authenticator, but not the password
    const res = await app.call(E, { body: { password: 'Guess-the-password-9', code: totpCodeAt(secret, app.clock.now()) }, cookie });
    expect(res.status).toBe(401);
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: u.password } })).status).toBe(200);
  });

  it('only one of two parallel enables with the same password and code succeeds', async () => {
    const { u, cookie } = await signedIn();
    const { secret } = await setup(cookie);
    const body = { password: u.password, code: totpCodeAt(secret, app.clock.now()) };
    const results = await Promise.all([app.call(E, { body, cookie }), app.call(E, { body, cookie })]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    expect(audits().filter((a) => a.action === 'auth.2fa_enabled')).toHaveLength(1);
  });

  it('a parallel setup cannot make a different secret live than the one that was verified', async () => {
    const { u, cookie } = await signedIn();
    const { secret } = await setup(cookie);
    const code = totpCodeAt(secret, app.clock.now());
    const [en, again] = await Promise.all([app.call(E, { body: { password: u.password, code }, cookie }), app.call(S, { method: 'POST', cookie })]);
    // Either the new secret replaced the pending one before the claim (enable refused: 400) or enable won (204, setup 409).
    expect([204, 400]).toContain(en.status);
    if (en.status === 204) {
      expect(again.status).toBe(409);
      expect(decryptSecret(userRow(u.id).totp_secret_enc as string, app.config.encryptionKey)).toBe(secret);
      expect(userRow(u.id).totp_enabled).toBe(1);
    } else {
      expect(userRow(u.id).totp_enabled).toBe(0);
    }
  });

  it('keeps the enabling code from being replayed at login within its window, but accepts the next one', async () => {
    const { u, cookie } = await signedIn();
    const { secret } = await setup(cookie);
    const code = totpCodeAt(secret, app.clock.now());
    expect((await app.call(E, { body: { password: u.password, code }, cookie })).status).toBe(204);
    const replay = await app.call('/api/auth/login', { body: { email: u.email, password: u.password, totpCode: code } });
    expect(await replay.json()).toEqual({ code: 'totp_invalid' });
    const next = totpCodeAt(secret, app.clock.now(), 1);
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: u.password, totpCode: next } })).status).toBe(200);
  });
});

describe('POST /api/auth/2fa/disable', () => {
  it('refuses a Super Manager with 403 2fa_required_for_role, whatever the credentials', async () => {
    const { u, cookie } = await signedIn({ role: 'super_manager', totp: true });
    for (const body of [
      { password: u.password, code: totpCodeAt(u.totpSecret as string, app.clock.now(), 1) },
      { password: 'Wrong-password-1', code: '000000' },
    ]) {
      const res = await app.call(D, { body, cookie });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: '2fa_required_for_role' });
    }
    expect(userRow(u.id).totp_enabled).toBe(1);
  });

  it('lets a Super Manager disable when the requirement is switched off', async () => {
    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
    const { u, cookie } = await signedIn({ role: 'super_manager', totp: true });
    const res = await app.call(D, { body: { password: u.password, code: totpCodeAt(u.totpSecret as string, app.clock.now(), 1) }, cookie });
    expect(res.status).toBe(204);
    expect(userRow(u.id)).toMatchObject({ totp_enabled: 0, totp_secret_enc: null, totp_last_step: null });
  });

  it('lets an affiliate disable with password and code, clearing the secret, and records it', async () => {
    const { u, cookie } = await signedIn({ role: 'affiliate', totp: true });
    const res = await app.call(D, { body: { password: u.password, code: totpCodeAt(u.totpSecret as string, app.clock.now(), 1) }, cookie });
    expect(res.status).toBe(204);
    expect(userRow(u.id)).toMatchObject({ totp_enabled: 0, totp_secret_enc: null });
    expect(audits().map((a) => a.action)).toEqual(['auth.2fa_disabled']);
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: u.password } })).status).toBe(200);
  });

  it('answers 401 invalid_credentials for a wrong password, 400 totp_invalid for a wrong code, 409 when not enabled', async () => {
    const { u, cookie } = await signedIn({ role: 'affiliate', totp: true });
    const secret = u.totpSecret as string;
    const badPw = await app.call(D, { body: { password: 'Wrong-password-1', code: totpCodeAt(secret, app.clock.now(), 1) }, cookie });
    expect(badPw.status).toBe(401);
    expect(await badPw.json()).toEqual({ code: 'invalid_credentials' });
    const badCode = await app.call(D, { body: { password: u.password, code: wrongCode(secret, app.clock.now()) }, cookie });
    expect(badCode.status).toBe(400);
    expect(await badCode.json()).toEqual({ code: 'totp_invalid' });
    expect(userRow(u.id).totp_enabled).toBe(1);
    const plain = await signedIn({ role: 'affiliate' });
    const none = await app.call(D, { body: { password: plain.u.password, code: '123456' }, cookie: plain.cookie });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ code: 'not_enabled' });
  });

  it('refuses a code already used at login, and takes the next one; a code never works twice', async () => {
    const { u, cookie } = await signedIn({ role: 'affiliate', totp: true });
    const secret = u.totpSecret as string;
    // signedIn consumed the code of the current step at login
    const used = await app.call(D, { body: { password: u.password, code: totpCodeAt(secret, app.clock.now()) }, cookie });
    expect(used.status).toBe(400);
    expect(await used.json()).toEqual({ code: 'totp_invalid' });
    expect((await app.call(D, { body: { password: u.password, code: totpCodeAt(secret, app.clock.now(), 1) }, cookie })).status).toBe(204);
  });

  it('only one of two parallel disables with the same code succeeds', async () => {
    const { u, cookie } = await signedIn({ role: 'affiliate', totp: true });
    const body = { password: u.password, code: totpCodeAt(u.totpSecret as string, app.clock.now(), 1) };
    const results = await Promise.all([app.call(D, { body, cookie }), app.call(D, { body, cookie })]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    expect(audits().filter((a) => a.action === 'auth.2fa_disabled')).toHaveLength(1);
  });
});

describe('POST /api/auth/password/change', () => {
  const NEW = 'Brand-new-pass-77';

  it('refuses a new password that fails the policy, with a French message on newPassword, and changes nothing', async () => {
    const { u, cookie } = await signedIn();
    const hash = userRow(u.id).password_hash;
    for (const newPassword of ['short', 'password123', u.password]) {
      const res = await app.call(C, { body: { currentPassword: u.password, newPassword }, cookie });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; errors: { newPassword: string } };
      expect(body.code).toBe('validation');
      expect(body.errors.newPassword).toMatch(/mot de passe/i);
    }
    expect(userRow(u.id).password_hash).toBe(hash);
  });

  it('answers 401 invalid_credentials for a wrong current password (before judging the new one)', async () => {
    const { cookie } = await signedIn();
    const res = await app.call(C, { body: { currentPassword: 'Wrong-password-1', newPassword: 'x' }, cookie });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'invalid_credentials' });
  });

  it('changes the hash, ends every other session and keeps the current one; the new password works', async () => {
    const { u, cookie } = await signedIn();
    const other = await login(app, u.email, u.password);
    const res = await app.call(C, { body: { currentPassword: u.password, newPassword: NEW }, cookie });
    expect(res.status).toBe(204);
    expect((await app.call('/api/auth/me', { cookie })).status).toBe(200);
    expect((await app.call('/api/auth/me', { cookie: other })).status).toBe(401);
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: u.password } })).status).toBe(401);
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: NEW } })).status).toBe(200);
  });

  it('voids outstanding password-reset links', async () => {
    const { u, cookie } = await signedIn();
    await app.call('/api/auth/password/forgot', { body: { email: u.email } });
    await new Promise((r) => setTimeout(r, 20));
    const { settleBackgroundWork } = await import('../mail/outbox');
    await settleBackgroundWork();
    expect(app.mailer.sent).toHaveLength(1);
    const link = /token=([A-Za-z0-9_-]{43})/.exec(app.mailer.sent[0]?.text ?? '')?.[1] as string;
    expect((await app.call('/api/auth/password/change', { body: { currentPassword: u.password, newPassword: NEW }, cookie })).status).toBe(204);
    const reset = await app.call('/api/auth/password/reset', { body: { token: link, password: 'Another-pass-88' } });
    expect(reset.status).toBe(400);
    expect(await reset.json()).toEqual({ code: 'invalid_token' });
  });

  it('only one of two parallel changes with the same current password wins, and its password is the one that stays', async () => {
    const { u, cookie } = await signedIn();
    const results = await Promise.all([
      app.call(C, { body: { currentPassword: u.password, newPassword: 'First-new-pass-1' }, cookie }),
      app.call(C, { body: { currentPassword: u.password, newPassword: 'Second-new-pass-2' }, cookie }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    const winner = results[0]?.status === 204 ? 'First-new-pass-1' : 'Second-new-pass-2';
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: winner } })).status).toBe(200);
  });

  it('stamps the revocation with the injected clock', async () => {
    const { u, cookie } = await signedIn();
    await login(app, u.email, u.password);
    app.clock.advance(5_000);
    await app.call(C, { body: { currentPassword: u.password, newPassword: NEW }, cookie });
    const revoked = app.db.all<{ revoked_at: number | null }>('SELECT revoked_at FROM sessions WHERE revoked_at IS NOT NULL');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.revoked_at).toBe(app.clock.now());
  });
});

describe('rate limits (per authenticated user, not per address)', () => {
  it('answers the sixth password/change in a minute with 429 for that user, from any address, not for another', async () => {
    const { u, cookie } = await signedIn();
    const other = await signedIn();
    for (let i = 0; i < 5; i += 1) {
      expect((await app.call(C, { body: { currentPassword: 'Wrong-password-1', newPassword: 'Whatever-pass-1' }, cookie, ip: freshIp() })).status).toBe(401);
    }
    const limited = await app.call(C, { body: { currentPassword: u.password, newPassword: 'Whatever-pass-1' }, cookie, ip: freshIp() });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ code: 'too_many_attempts' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await app.call(C, { body: { currentPassword: 'Wrong-password-1', newPassword: 'Whatever-pass-1' }, cookie: other.cookie })).status).toBe(401);
    app.clock.advance(60_000);
    expect((await app.call(C, { body: { currentPassword: 'Wrong-password-1', newPassword: 'Whatever-pass-1' }, cookie })).status).toBe(401);
  });

  it('shares one budget of five across enable, disable and password/change', async () => {
    const { u, cookie } = await signedIn();
    const wrong = { currentPassword: 'Wrong-password-1', newPassword: 'Whatever-pass-1' };
    await app.call(C, { body: wrong, cookie });
    await app.call(E, { body: { password: 'Wrong-password-1', code: '123456' }, cookie });
    await app.call(D, { body: { password: 'Wrong-password-1', code: '123456' }, cookie });
    await app.call(E, { body: { password: 'Wrong-password-1', code: '123456' }, cookie });
    await app.call(C, { body: wrong, cookie });
    for (const [path, body] of [[C, wrong], [E, { password: u.password, code: '123456' }], [D, { password: u.password, code: '123456' }]] as const) {
      expect((await app.call(path, { body, cookie })).status, path).toBe(429);
    }
  });

  it('counts requests that fail validation too (the budget is spent before the body is read)', async () => {
    const { cookie } = await signedIn();
    for (let i = 0; i < 5; i += 1) expect((await app.call(C, { body: {}, cookie })).status).toBe(400);
    expect((await app.call(C, { body: {}, cookie })).status).toBe(429);
  });

  it('does not count setup or /me against the budget', async () => {
    const { cookie } = await signedIn();
    for (let i = 0; i < 8; i += 1) {
      expect((await app.call(S, { method: 'POST', cookie })).status).toBe(200);
      expect((await app.call('/api/auth/me', { cookie })).status).toBe(200);
    }
    expect((await app.call(C, { body: { currentPassword: 'Wrong-password-1', newPassword: 'Whatever-pass-1' }, cookie })).status).toBe(401);
  });

  it('does not let an anonymous caller burn a user’s budget (access is checked first)', async () => {
    const { u, cookie } = await signedIn();
    for (let i = 0; i < 10; i += 1) expect((await app.call(C, { body: {} })).status).toBe(401);
    expect((await app.call(C, { body: { currentPassword: u.password, newPassword: 'Fresh-new-pass-9' }, cookie })).status).toBe(204);
  });
});

describe('audit and secrecy', () => {
  it('records each success with no secret, password, hash or code in the entry', async () => {
    const { u, cookie } = await signedIn();
    const { secret } = await setup(cookie);
    const code = totpCodeAt(secret, app.clock.now());
    await app.call(E, { body: { password: u.password, code }, cookie, ip: '203.0.113.5' });
    await app.call(C, { body: { currentPassword: u.password, newPassword: 'Audit-new-pass-3' }, cookie });
    await app.call(D, { body: { password: 'Audit-new-pass-3', code: totpCodeAt(secret, app.clock.now(), 1) }, cookie });
    const rows = audits();
    expect(rows.map((r) => r.action)).toEqual(['auth.2fa_enabled', 'auth.password_changed', 'auth.2fa_disabled']);
    for (const r of rows) {
      expect(r).toMatchObject({ actor_user_id: u.id, entity_type: 'user', entity_id: u.id });
    }
    expect(rows[0]?.ip).toBe('203.0.113.5');
    expect(JSON.parse(rows[0]?.after as string)).toEqual({ twoFactorEnabled: true });
    const dump = JSON.stringify(rows);
    for (const secretValue of [secret, code, u.password, 'Audit-new-pass-3', userRow(u.id).password_hash, cookie.split('=')[1] as string]) {
      expect(dump).not.toContain(secretValue as string);
    }
  });

  it('returns the secret only from setup: not from /me, not from errors, not from later calls', async () => {
    const { u, cookie } = await signedIn();
    const { secret } = await setup(cookie);
    const seen: string[] = [];
    seen.push(await (await app.call('/api/auth/me', { cookie })).text());
    seen.push(await (await app.call(E, { body: { password: u.password, code: '000000' }, cookie })).text());
    seen.push(await (await app.call(E, { body: { password: 'bad', code: 'x' }, cookie })).text());
    for (const text of seen) expect(text).not.toContain(secret);
    expect(newTotpSecret()).not.toBe(secret);
  });

  it('every refusal of the password-verifying routes has the same shape for the same input', async () => {
    const { cookie } = await signedIn({ role: 'affiliate', totp: true });
    const a = await snap(await app.call(D, { body: { password: 'Wrong-password-1', code: '123456' }, cookie }));
    app.limiter.reset();
    const b = await snap(await app.call(D, { body: { password: 'Wrong-password-2', code: '654321' }, cookie }));
    expect(a).toEqual(b);
  });
});
