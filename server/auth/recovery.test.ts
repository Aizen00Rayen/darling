import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleBackgroundWork } from '../mail/outbox';
import { hashToken } from '../security/crypto';
import { createTestApp, freshIp, login, seedUser, snap, totpCodeAt, type TestApp } from '../test/app';
import { acceptInvite, resetPassword } from './recovery';
import { INVITE_TTL_MS, RESET_TTL_MS, consumeToken, invalidateTokens, issueToken, peekToken, linkFor, issueInviteMail } from './tokens';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(async () => {
  await settleBackgroundWork();
  vi.restoreAllMocks();
  app.close();
});

const PW = 'Chosen-pass-2026';
const FORGOT = '/api/auth/password/forgot';
const RESET = '/api/auth/password/reset';
const ACCEPT = '/api/auth/invite/accept';

type Row = Record<string, unknown>;
const userRow = (id: string) => app.db.get<Row>('SELECT * FROM users WHERE id = ?', id) as Row;
const tokenRows = (userId?: string) =>
  userId ? app.db.all<Row>('SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY created_at, rowid', userId) : app.db.all<Row>('SELECT * FROM auth_tokens');
const audits = () => app.db.all<Row>('SELECT * FROM audit_log ORDER BY id');
const issue = (userId: string, type: 'invite' | 'password_reset') => issueToken(app.db, app.clock, { userId, type });
const invitedUser = async () => {
  const u = await seedUser(app, { role: 'affiliate', status: 'invited' });
  return { u, token: issue(u.id, 'invite') };
};
const resetUser = async (input: Parameters<typeof seedUser>[1] = { role: 'affiliate' }) => {
  const u = await seedUser(app, input);
  return { u, token: issue(u.id, 'password_reset') };
};
const accept = (token: string, password = PW, ip?: string) => app.call(ACCEPT, { body: { token, password }, ip });
const reset = (token: string, password = PW, ip?: string) => app.call(RESET, { body: { token, password }, ip });
const settle = () => settleBackgroundWork();

describe('tokens', () => {
  it('uses a 7 day invitation window and a 30 minute reset window', async () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 3_600_000);
    expect(RESET_TTL_MS).toBe(30 * 60_000);
    const { u } = await invitedUser();
    const t = await issue(u.id, 'password_reset');
    expect(tokenRows(u.id).find((r) => r.token_hash === hashToken(t))?.expires_at).toBe(app.clock.now() + RESET_TTL_MS);
  });

  it('stores only the hash: the raw token appears nowhere in the database', async () => {
    const { u, token } = await invitedUser();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenRows(u.id)[0]?.token_hash).toBe(hashToken(token));
    for (const table of ['auth_tokens', 'users', 'audit_log', 'login_events']) {
      expect(JSON.stringify(app.db.all(`SELECT * FROM ${table}`))).not.toContain(token);
    }
  });

  it('consumes a token once and returns its user; peek does not consume', async () => {
    const { u, token } = await invitedUser();
    const now = app.clock.now();
    expect(peekToken(app.db, { token, type: 'invite', now })?.userId).toBe(u.id);
    expect(peekToken(app.db, { token, type: 'invite', now })?.userId).toBe(u.id);
    expect(consumeToken(app.db, { token, type: 'invite', now })).toEqual({ userId: u.id });
    expect(consumeToken(app.db, { token, type: 'invite', now })).toBeNull();
    expect(peekToken(app.db, { token, type: 'invite', now })).toBeNull();
  });

  it('refuses an unknown token, a token of the other type and an expired token (the instant of expiry included)', async () => {
    const { u, token } = await invitedUser();
    const now = app.clock.now();
    expect(consumeToken(app.db, { token: 'x'.repeat(43), type: 'invite', now })).toBeNull();
    expect(consumeToken(app.db, { token, type: 'password_reset', now })).toBeNull();
    expect(peekToken(app.db, { token, type: 'invite', now: now + INVITE_TTL_MS - 1 })).not.toBeNull();
    expect(peekToken(app.db, { token, type: 'invite', now: now + INVITE_TTL_MS })).toBeNull();
    expect(consumeToken(app.db, { token, type: 'invite', now: now + INVITE_TTL_MS })).toBeNull();
    expect(consumeToken(app.db, { token, type: 'invite', now: now + INVITE_TTL_MS - 1 })).toEqual({ userId: u.id });
  });

  it('invalidates earlier unused tokens of the same type for that user only', async () => {
    const a = await seedUser(app, { role: 'affiliate' });
    const b = await seedUser(app, { role: 'affiliate' });
    const first = issue(a.id, 'password_reset');
    const other = issue(b.id, 'password_reset');
    const invite = issue(a.id, 'invite');
    const second = issue(a.id, 'password_reset');
    const now = app.clock.now();
    expect(peekToken(app.db, { token: first, type: 'password_reset', now })).toBeNull();
    expect(peekToken(app.db, { token: second, type: 'password_reset', now })).not.toBeNull();
    expect(peekToken(app.db, { token: other, type: 'password_reset', now })).not.toBeNull();
    expect(peekToken(app.db, { token: invite, type: 'invite', now })).not.toBeNull();
    invalidateTokens(app.db, { userId: a.id, type: 'password_reset', now });
    expect(peekToken(app.db, { token: second, type: 'password_reset', now })).toBeNull();
  });

  it('issuing works inside a transaction and rolls back with it', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    expect(() =>
      app.db.transaction(() => {
        issueToken(app.db, app.clock, { userId: u.id, type: 'invite' });
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(tokenRows()).toHaveLength(0);
  });

  it('builds links under the app origin and mails a working invitation', async () => {
    const u = await seedUser(app, { role: 'affiliate', status: 'invited', fullName: 'Ines Amrani' });
    const mail = issueInviteMail(app, app.db, { id: u.id, email: u.email, fullName: 'Ines Amrani', role: 'affiliate' });
    const token = /\/invitation\?token=([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1] as string;
    expect(mail.to).toBe(u.email);
    expect(mail.text).toContain(`http://localhost:3000/invitation?token=${token}`);
    expect(linkFor(app.config, '/reinitialiser', 'abc')).toBe('http://localhost:3000/reinitialiser?token=abc');
    expect((await accept(token)).status).toBe(204);
  });
});

describe('POST /api/auth/password/forgot', () => {
  const forgot = (email: string, ip?: string) => app.call(FORGOT, { body: { email }, ip });

  it('answers 204 and mails nothing for an unknown email', async () => {
    const res = await forgot('nobody@example.test');
    expect(res.status).toBe(204);
    await settle();
    expect(app.mailer.sent).toHaveLength(0);
    expect(tokenRows()).toHaveLength(0);
  });

  it('mails exactly one link to an active user, and the link resets the password', async () => {
    const u = await seedUser(app, { role: 'affiliate', fullName: 'Ines Amrani' });
    expect((await forgot(u.email)).status).toBe(204);
    await settle();
    expect(app.mailer.sent).toHaveLength(1);
    const mail = app.mailer.sent[0]!;
    expect(mail.to).toBe(u.email);
    expect(mail.subject).toMatch(/mot de passe/i);
    const token = /http:\/\/localhost:3000\/reinitialiser\?token=([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1] as string;
    expect(token).toBeTruthy();
    expect(mail.html).toContain(`/reinitialiser?token=${token}`);
    expect((await reset(token)).status).toBe(204);
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: PW } })).status).toBe(200);
  });

  it('normalises the address (case and surrounding spaces)', async () => {
    const u = await seedUser(app, { role: 'affiliate', email: 'ines@example.test' });
    void u;
    expect((await forgot('  INES@Example.test ')).status).toBe(204);
    await settle();
    expect(app.mailer.sent).toHaveLength(1);
  });

  it('mails nothing to a suspended, deactivated or invited user', async () => {
    for (const status of ['suspended', 'deactivated', 'invited'] as const) {
      const u = await seedUser(app, { role: 'affiliate', status });
      expect((await forgot(u.email)).status).toBe(204);
    }
    await settle();
    expect(app.mailer.sent).toHaveLength(0);
    expect(tokenRows()).toHaveLength(0);
  });

  it('answers byte for byte the same whether the account is active, suspended, invited or unknown', async () => {
    const active = await seedUser(app, { role: 'affiliate' });
    const suspended = await seedUser(app, { role: 'affiliate', status: 'suspended' });
    const invited = await seedUser(app, { role: 'affiliate', status: 'invited' });
    const snaps = [];
    for (const email of [active.email, suspended.email, invited.email, 'ghost@example.test']) snaps.push(await snap(await forgot(email)));
    for (const s of snaps) expect(s).toEqual(snaps[0]);
    expect(snaps[0]?.status).toBe(204);
    expect(snaps[0]?.body).toBe('');
  });

  it('does no account work before answering: for an existing user the lookup, token and mail happen after the response', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const res = await forgot(u.email);
    expect(res.status).toBe(204);
    expect(tokenRows()).toHaveLength(0); // nothing yet: the response was built first
    expect(app.mailer.sent).toHaveLength(0);
    await settle();
    expect(tokenRows()).toHaveLength(1);
    expect(app.mailer.sent).toHaveLength(1);
  });

  it('does not wait for the mail to be delivered before answering', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    let release!: () => void;
    app.mailer.send = () => new Promise<void>((resolve) => (release = resolve));
    const started = Date.now();
    expect((await forgot(u.email)).status).toBe(204);
    expect(Date.now() - started).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await settle();
  });

  it('still answers 204 when the mail cannot be sent, logs no address, and never rejects unhandled', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const out: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => (out.push(String(c)), true)) as never);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    app.mailer.send = async () => {
      throw Object.assign(new Error(`550 mailbox ${u.email} unavailable`), { code: 'EENVELOPE' });
    };
    expect((await forgot(u.email)).status).toBe(204);
    await settle();
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    const log = out.join('');
    expect(log).toContain('mail');
    expect(log).toContain('EENVELOPE');
    expect(log).not.toContain(u.email);
    expect(log).not.toMatch(/token=/);
  });

  it('makes the first link invalid when a second one is requested', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    await forgot(u.email);
    await settle();
    await forgot(u.email);
    await settle();
    const links = app.mailer.sent.map((m) => /token=([A-Za-z0-9_-]{43})/.exec(m.text)?.[1] as string);
    expect(links).toHaveLength(2);
    expect((await reset(links[0]!)).status).toBe(400);
    expect((await reset(links[1]!)).status).toBe(204);
  });

  it('rejects a malformed body as a validation error', async () => {
    const res = await app.call(FORGOT, { body: { email: 'not-an-email' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('validation');
    expect((await app.call(FORGOT, { rawBody: '{' })).status).toBe(400);
  });
});

describe('POST /api/auth/password/reset', () => {
  it('sets the password, answers 204 with no session, and writes an audit row without secrets', async () => {
    const { u, token } = await resetUser();
    const res = await reset(token, PW, '203.0.113.8');
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(app.db.get<{ n: number }>('SELECT count(*) AS n FROM sessions')!.n).toBe(0);
    const rows = audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: u.id, action: 'auth.password_reset', entity_type: 'user', entity_id: u.id, ip: '203.0.113.8' });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain(userRow(u.id).password_hash as string);
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: PW } })).status).toBe(200);
  });

  it('refuses a token that was already used', async () => {
    const { token } = await resetUser();
    expect((await reset(token)).status).toBe(204);
    const again = await reset(token, 'Other-pass-2026');
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ code: 'invalid_token' });
  });

  it('refuses the token 30 minutes after it was issued, and accepts it a millisecond before', async () => {
    const early = await resetUser();
    app.clock.advance(RESET_TTL_MS - 1);
    expect((await reset(early.token)).status).toBe(204);
    const late = await resetUser();
    app.clock.advance(RESET_TTL_MS);
    expect((await reset(late.token)).status).toBe(400);
  });

  it('answers 400 invalid_token and keeps a user suspended after the mail was sent suspended', async () => {
    const { u, token } = await resetUser();
    app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", u.id);
    const res = await reset(token);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'invalid_token' });
    expect(userRow(u.id).status).toBe('suspended');
    expect(userRow(u.id).password_hash).not.toBeNull();
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: PW } })).status).toBe(401);
  });

  it('rolls everything back when the user is suspended after the checks, token included', async () => {
    const { u, token } = await resetUser();
    const before = userRow(u.id).password_hash;
    const outcome = await resetPassword(
      { ...app, afterChecks: async () => void app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", u.id) },
      { token, password: PW, ip: '1.1.1.1', requestId: 'r' },
    );
    expect(outcome).toEqual({ kind: 'invalid_token' });
    expect(userRow(u.id).password_hash).toBe(before);
    expect(tokenRows(u.id)[0]?.used_at).toBeNull();
    expect(audits()).toHaveLength(0);
  });

  it('lets exactly one of two parallel resets with the same token win (also on a file database)', async () => {
    app.close();
    app = createTestApp({ file: true, connections: 3 });
    const { u, token } = await resetUser();
    const results = await Promise.all([reset(token, 'First-pass-2026'), reset(token, 'Second-pass-2026')]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
    const winner = results[0]?.status === 204 ? 'First-pass-2026' : 'Second-pass-2026';
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: winner } })).status).toBe(200);
    expect(audits()).toHaveLength(1);
  });

  it('revokes every existing session', async () => {
    const { u, token } = await resetUser();
    const cookie = await login(app, u.email, u.password);
    expect((await reset(token)).status).toBe(204);
    expect((await app.call('/api/auth/me', { cookie })).status).toBe(401);
  });

  it('unlocks a locked account and clears the failed-login counter', async () => {
    const { u, token } = await resetUser();
    app.db.run('UPDATE users SET failed_logins = 10, locked_until = ? WHERE id = ?', app.clock.now() + 600_000, u.id);
    expect((await reset(token)).status).toBe(204);
    expect(userRow(u.id)).toMatchObject({ failed_logins: 0, locked_until: null });
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: PW } })).status).toBe(200);
  });

  it('keeps the account active and does not turn two-factor off', async () => {
    const { u, token } = await resetUser({ role: 'affiliate', totp: true });
    expect((await reset(token)).status).toBe(204);
    expect(userRow(u.id)).toMatchObject({ status: 'active', totp_enabled: 1 });
    const need = await app.call('/api/auth/login', { body: { email: u.email, password: PW } });
    expect(await need.json()).toEqual({ code: 'totp_required' });
    const ok = await app.call('/api/auth/login', { body: { email: u.email, password: PW, totpCode: totpCodeAt(u.totpSecret as string, app.clock.now()) } });
    expect(ok.status).toBe(200);
  });

  it('answers a weak password with a validation error and keeps the same link usable', async () => {
    const { token } = await resetUser();
    for (const weak of ['short', 'password123', 'x'.repeat(201)]) {
      const res = await reset(token, weak);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; errors: { password: string } };
      expect(body.code).toBe('validation');
      expect(body.errors.password).toBeTruthy();
    }
    expect((await reset(token)).status).toBe(204);
  });

  it('does not reveal why a token is refused: every failure is the same response', async () => {
    const used = await resetUser();
    await reset(used.token);
    const expired = await resetUser();
    app.clock.advance(RESET_TTL_MS);
    const suspended = await resetUser({ role: 'affiliate', status: 'suspended' });
    const wrongType = await invitedUser();
    const snaps = [];
    for (const t of ['x'.repeat(43), used.token, expired.token, suspended.token, wrongType.token, 'short']) {
      snaps.push(await snap(await reset(t, PW, freshIp())));
    }
    for (const s of snaps) expect(s).toEqual(snaps[0]);
    expect(snaps[0]?.body).toBe('{"code":"invalid_token"}');
  });

  it('refuses an invitation token, and the refusal does not use the invitation up', async () => {
    const { token } = await invitedUser();
    expect((await reset(token)).status).toBe(400);
    expect((await accept(token)).status).toBe(204);
  });

  it('marks the user’s other unused reset tokens as used, and voids them', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const first = issue(u.id, 'password_reset');
    const second = issue(u.id, 'password_reset');
    expect((await reset(second)).status).toBe(204);
    expect((await reset(first)).status).toBe(400);
    expect(tokenRows(u.id).every((r) => r.used_at !== null)).toBe(true);
  });
});

describe('invitations', () => {
  it('accept sets the password, activates the user, opens no session, and login then works', async () => {
    const { u, token } = await invitedUser();
    const res = await accept(token);
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(userRow(u.id).status).toBe('active');
    expect(app.db.get<{ n: number }>('SELECT count(*) AS n FROM sessions')!.n).toBe(0);
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: PW } })).status).toBe(200);
  });

  it('refuses the same token a second time', async () => {
    const { token } = await invitedUser();
    await accept(token);
    const again = await accept(token, 'Other-pass-2026');
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ code: 'invalid_token' });
  });

  it('writes an audit row without the token, the password or the hash', async () => {
    const { u, token } = await invitedUser();
    await accept(token);
    const rows = audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: u.id, action: 'auth.invite_accepted' });
    expect(JSON.parse(rows[0]?.before as string)).toEqual({ status: 'invited' });
    expect(JSON.parse(rows[0]?.after as string)).toEqual({ status: 'active' });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain(userRow(u.id).password_hash as string);
  });

  it('never activates a user who was suspended before accepting', async () => {
    const { u, token } = await invitedUser();
    app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", u.id);
    expect((await accept(token)).status).toBe(400);
    expect(userRow(u.id)).toMatchObject({ status: 'suspended', password_hash: null });
  });

  it('rolls back, token included, when the user is suspended after the checks', async () => {
    const { u, token } = await invitedUser();
    const outcome = await acceptInvite(
      { ...app, afterChecks: async () => void app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", u.id) },
      { token, password: PW, ip: '1.1.1.1', requestId: 'r' },
    );
    expect(outcome).toEqual({ kind: 'invalid_token' });
    expect(userRow(u.id)).toMatchObject({ status: 'suspended', password_hash: null });
    expect(tokenRows(u.id)[0]?.used_at).toBeNull();
    expect(audits()).toHaveLength(0);
  });

  it('refuses a token for a user who is already active, without using the token up', async () => {
    const { u, token } = await invitedUser();
    app.db.run("UPDATE users SET status = 'active' WHERE id = ?", u.id);
    expect((await accept(token)).status).toBe(400);
    expect(tokenRows(u.id)[0]?.used_at).toBeNull();
  });

  it('refuses the token after 7 days and accepts it a millisecond before', async () => {
    const early = await invitedUser();
    app.clock.advance(INVITE_TTL_MS - 1);
    expect((await accept(early.token)).status).toBe(204);
    const late = await invitedUser();
    app.clock.advance(INVITE_TTL_MS);
    expect((await accept(late.token)).status).toBe(400);
  });

  it('answers a weak password with a validation error and keeps the same link usable', async () => {
    const { token } = await invitedUser();
    const weak = await accept(token, 'password123');
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { errors: { password: string } }).errors.password).toBeTruthy();
    expect(tokenRows()[0]?.used_at).toBeNull();
    expect((await accept(token)).status).toBe(204);
  });

  it('lets exactly one of two parallel accepts win', async () => {
    const { u, token } = await invitedUser();
    const results = await Promise.all([accept(token, 'First-pass-2026'), accept(token, 'Second-pass-2026')]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
    expect(audits()).toHaveLength(1);
    const winner = results[0]?.status === 204 ? 'First-pass-2026' : 'Second-pass-2026';
    expect((await app.call('/api/auth/login', { body: { email: u.email, password: winner } })).status).toBe(200);
  });

  it('refuses a password-reset token and answers every refusal the same way', async () => {
    const reset1 = await resetUser();
    const used = await invitedUser();
    await accept(used.token);
    const expired = await invitedUser();
    app.clock.advance(INVITE_TTL_MS);
    const snaps = [];
    for (const t of ['y'.repeat(43), reset1.token, used.token, expired.token]) snaps.push(await snap(await accept(t, PW, freshIp())));
    for (const s of snaps) expect(s).toEqual(snaps[0]);
    expect(snaps[0]?.body).toBe('{"code":"invalid_token"}');
  });
});

describe('GET /api/auth/invite/:token', () => {
  const lookup = (token: string, ip?: string) => app.call(`/api/auth/invite/${token}`, { ip });

  it('returns the name and email for a valid invitation and does not consume it', async () => {
    const { u, token } = await invitedUser();
    for (let i = 0; i < 2; i += 1) {
      const res = await lookup(token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ email: u.email, fullName: 'Test User' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect((await accept(token)).status).toBe(204);
  });

  it('answers 404 not_found, identically, for unknown, used, expired, suspended and wrong-type tokens', async () => {
    const used = await invitedUser();
    await accept(used.token);
    const expired = await invitedUser();
    const suspended = await invitedUser();
    app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", suspended.u.id);
    const wrong = await resetUser();
    app.clock.advance(INVITE_TTL_MS);
    const live = await invitedUser();
    expect((await lookup(live.token)).status).toBe(200);
    const snaps = [];
    for (const t of ['z'.repeat(43), used.token, expired.token, suspended.token, wrong.token, 'bad%20token']) snaps.push(await snap(await lookup(t, freshIp())));
    for (const s of snaps) expect(s).toEqual(snaps[0]);
    expect(snaps[0]).toMatchObject({ status: 404, body: '{"code":"not_found"}' });
  });
});

describe('rate limits', () => {
  it('allows 10 requests in 15 minutes per address across lookup, accept and reset, then answers 429', async () => {
    const ip = '198.51.100.20';
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) codes.push((await app.call(`/api/auth/invite/${'a'.repeat(43)}`, { ip })).status);
    for (let i = 0; i < 3; i += 1) codes.push((await accept('b'.repeat(43), PW, ip)).status);
    for (let i = 0; i < 3; i += 1) codes.push((await reset('c'.repeat(43), PW, ip)).status);
    expect(codes).toEqual([404, 404, 404, 404, 400, 400, 400, 400, 400, 400]);
    for (const res of [await app.call(`/api/auth/invite/${'a'.repeat(43)}`, { ip }), await accept('b'.repeat(43), PW, ip), await reset('c'.repeat(43), PW, ip)]) {
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ code: 'too_many_attempts' });
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect((await app.call(`/api/auth/invite/${'a'.repeat(43)}`)).status).toBe(404); // another address
    app.clock.advance(15 * 60_000);
    expect((await app.call(`/api/auth/invite/${'a'.repeat(43)}`, { ip })).status).toBe(404);
  });

  it('blocks a valid token as well once the budget is spent', async () => {
    const { token } = await invitedUser();
    const ip = '198.51.100.21';
    for (let i = 0; i < 10; i += 1) await reset('d'.repeat(43), PW, ip);
    expect((await accept(token, PW, ip)).status).toBe(429);
    expect((await accept(token)).status).toBe(204);
  });

  it('allows 5 forgot requests in 15 minutes per address (a budget of its own), then answers 429', async () => {
    const ip = '198.51.100.22';
    for (let i = 0; i < 5; i += 1) expect((await app.call(FORGOT, { body: { email: 'a@b.co' }, ip })).status).toBe(204);
    const limited = await app.call(FORGOT, { body: { email: 'a@b.co' }, ip });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ code: 'too_many_attempts' });
    expect((await reset('e'.repeat(43), PW, ip)).status).toBe(400); // token budget untouched
  });
});
