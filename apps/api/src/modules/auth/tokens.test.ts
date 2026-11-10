import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLE_LABELS } from '@darling/shared';
import { authTokens, auditLog, sessions, users } from '../../db/schema';
import { hashToken, verifyPassword } from '../../lib/crypto';
import type { Mail } from '../../mail/mailer';
import {
  createTestContext,
  csrfHeaders,
  freshAddress,
  login,
  seedUser,
  type SeededUser,
  type TestContext,
} from '../../../test/context';
import { acceptInvite, resetPassword, settleBackgroundWork } from './recovery';
import {
  consumeToken,
  INVITE_TTL_MS,
  issueToken,
  RESET_TTL_MS,
  sendInvite,
  sendPasswordReset,
} from './tokens';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

const NEW_PASSWORD = 'Velvet-peony-2026';
const MINUTE = 60_000;

const INVALID_TOKEN = { code: 'invalid_token' };
const NOT_FOUND = { code: 'not_found' };

function post(path: string, payload: Record<string, unknown>, remoteAddress?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: path,
    headers: csrfHeaders(ctx),
    remoteAddress: remoteAddress ?? freshAddress(),
    payload,
  });
}

const forgot = (email: string, ip?: string) => post('/api/auth/password/forgot', { email }, ip);
const reset = (token: string, password: string, ip?: string) =>
  post('/api/auth/password/reset', { token, password }, ip);
const accept = (token: string, password: string, ip?: string) =>
  post('/api/auth/invite/accept', { token, password }, ip);
const lookup = (token: string, ip?: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/api/auth/invite/${encodeURIComponent(token)}`,
    remoteAddress: ip ?? freshAddress(),
  });

const deps = () => ({ db: ctx.db, mailer: ctx.mailer, config: ctx.config, clock: ctx.clock });

/** The reset or invitation link inside a mail, parsed. */
function linkOf(mail: Mail): URL {
  const found = /https?:\/\/\S+/.exec(mail.text);
  if (!found) throw new Error('no link in the mail');
  return new URL(found[0]);
}
function tokenOf(mail: Mail): string {
  const token = linkOf(mail).searchParams.get('token');
  if (!token) throw new Error('no token in the link');
  return token;
}

/** Requests a reset mail for `email` and returns the token it carries. */
async function requestResetToken(email: string): Promise<string> {
  const before = ctx.mailer.sent.length;
  const res = await forgot(email);
  expect(res.statusCode).toBe(204);
  await vi.waitFor(() => expect(ctx.mailer.sent.length).toBe(before + 1));
  return tokenOf(ctx.mailer.sent[before] as Mail);
}

async function seedInvited(): Promise<SeededUser> {
  const user = await seedUser(ctx, { role: 'affiliate', status: 'invited' });
  await ctx.db.update(users).set({ passwordHash: null }).where(eq(users.id, user.id));
  return user;
}

/** Issues an invitation token for a freshly seeded invited user. */
async function invitation(): Promise<{ user: SeededUser; token: string }> {
  const user = await seedInvited();
  const token = await issueToken(ctx.db, { userId: user.id, type: 'invite', now: ctx.clock() });
  return { user, token };
}

async function userRow(id: string) {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
  if (!row) throw new Error('user not found');
  return row;
}

const tokenRows = () => ctx.db.select().from(authTokens).orderBy(asc(authTokens.createdAt));
const audits = () => ctx.db.select().from(auditLog).orderBy(asc(auditLog.id));

/** Everything that must be the same for every failure: status, body, headers (minus the request id). */
function shape(res: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  const headers = { ...res.headers };
  delete headers['x-request-id'];
  delete headers['date'];
  return { status: res.statusCode, body: res.body, headers };
}

describe('tokens', () => {
  it('uses a 7 day invitation window and a 30 minute reset window', async () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 3600_000);
    expect(RESET_TTL_MS).toBe(30 * 60_000);
    const user = await seedUser(ctx, { role: 'affiliate' });
    const now = ctx.clock();
    await issueToken(ctx.db, { userId: user.id, type: 'invite', now });
    await issueToken(ctx.db, { userId: user.id, type: 'password_reset', now });
    const rows = await tokenRows();
    const byType = Object.fromEntries(rows.map((r) => [r.type, r.expiresAt.getTime() - now.getTime()]));
    expect(byType).toEqual({ invite: INVITE_TTL_MS, password_reset: RESET_TTL_MS });
  });

  it('stores only the hash: the raw token appears nowhere in the database', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const token = await issueToken(ctx.db, { userId: user.id, type: 'password_reset', now: ctx.clock() });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await tokenRows();
    expect(row?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(await tokenRows())).not.toContain(token);
    expect(JSON.stringify(await audits())).not.toContain(token);
  });

  it('consumes a token once and returns its user', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const now = ctx.clock();
    const token = await issueToken(ctx.db, { userId: user.id, type: 'password_reset', now });
    expect(await consumeToken(ctx.db, { token, type: 'password_reset', now })).toEqual({ userId: user.id });
    expect(await consumeToken(ctx.db, { token, type: 'password_reset', now })).toBeNull();
    const [row] = await tokenRows();
    expect(row?.usedAt?.getTime()).toBe(now.getTime());
  });

  it('refuses an unknown token, a token of the other type and an expired token', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const now = ctx.clock();
    const token = await issueToken(ctx.db, { userId: user.id, type: 'password_reset', now });
    expect(await consumeToken(ctx.db, { token: 'nope', type: 'password_reset', now })).toBeNull();
    expect(await consumeToken(ctx.db, { token, type: 'invite', now })).toBeNull();
    // The refusals above did not use the token up.
    const atExpiry = new Date(now.getTime() + RESET_TTL_MS);
    expect(await consumeToken(ctx.db, { token, type: 'password_reset', now: atExpiry })).toBeNull();
    const justBefore = new Date(atExpiry.getTime() - 1);
    expect(await consumeToken(ctx.db, { token, type: 'password_reset', now: justBefore })).toEqual({
      userId: user.id,
    });
  });

  it('lets exactly one of many parallel consumes win', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const now = ctx.clock();
    const token = await issueToken(ctx.db, { userId: user.id, type: 'invite', now });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeToken(ctx.db, { token, type: 'invite', now })),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('invalidates earlier unused tokens of the same type for that user only', async () => {
    const a = await seedUser(ctx, { role: 'affiliate' });
    const b = await seedUser(ctx, { role: 'affiliate' });
    const now = ctx.clock();
    const first = await issueToken(ctx.db, { userId: a.id, type: 'password_reset', now });
    const invite = await issueToken(ctx.db, { userId: a.id, type: 'invite', now });
    const other = await issueToken(ctx.db, { userId: b.id, type: 'password_reset', now });
    const second = await issueToken(ctx.db, { userId: a.id, type: 'password_reset', now });

    expect(await consumeToken(ctx.db, { token: first, type: 'password_reset', now })).toBeNull();
    expect(await consumeToken(ctx.db, { token: second, type: 'password_reset', now })).toEqual({ userId: a.id });
    expect(await consumeToken(ctx.db, { token: invite, type: 'invite', now })).toEqual({ userId: a.id });
    expect(await consumeToken(ctx.db, { token: other, type: 'password_reset', now })).toEqual({ userId: b.id });
  });

  it('works inside a transaction and rolls back with it', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const now = ctx.clock();
    const token = await issueToken(ctx.db, { userId: user.id, type: 'password_reset', now });
    await expect(
      ctx.db.transaction(async (tx) => {
        expect(await consumeToken(tx, { token, type: 'password_reset', now })).toEqual({ userId: user.id });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await consumeToken(ctx.db, { token, type: 'password_reset', now })).toEqual({ userId: user.id });
  });
});

describe('mails', () => {
  it('sendInvite mails an invitation link under the app origin with a token that works', async () => {
    const user = await seedInvited();
    await sendInvite(deps(), { id: user.id, email: user.email, fullName: 'Lina Haddad', role: 'affiliate' });
    expect(ctx.mailer.sent).toHaveLength(1);
    const mail = ctx.mailer.sent[0] as Mail;
    expect(mail.to).toBe(user.email);
    expect(mail.text).toContain('Lina Haddad');
    expect(mail.text).toContain(ROLE_LABELS.affiliate);
    const link = linkOf(mail);
    expect(`${link.origin}${link.pathname}`).toBe(`${ctx.config.appOrigin}/invitation`);
    expect([...link.searchParams.keys()]).toEqual(['token']);
    const token = tokenOf(mail);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('sendInvite again makes the earlier invitation link invalid', async () => {
    const user = await seedInvited();
    const u = { id: user.id, email: user.email, fullName: 'Lina Haddad', role: 'affiliate' as const };
    await sendInvite(deps(), u);
    await sendInvite(deps(), u);
    const [first, second] = ctx.mailer.sent.map(tokenOf) as [string, string];
    expect((await accept(first, NEW_PASSWORD)).json()).toEqual(INVALID_TOKEN);
    expect((await accept(second, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('sendPasswordReset mails a /reinitialiser link under the app origin', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    await sendPasswordReset(deps(), { id: user.id, email: user.email, fullName: 'Lina Haddad', role: 'affiliate' });
    const mail = ctx.mailer.sent[0] as Mail;
    expect(mail.to).toBe(user.email);
    const link = linkOf(mail);
    expect(`${link.origin}${link.pathname}`).toBe(`${ctx.config.appOrigin}/reinitialiser`);
    expect([...link.searchParams.keys()]).toEqual(['token']);
    expect((await reset(tokenOf(mail), NEW_PASSWORD)).statusCode).toBe(204);
  });
});

describe('POST /api/auth/password/forgot', () => {
  it('answers 204 and mails nothing for an unknown email', async () => {
    const res = await forgot('nobody@example.test');
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    await settleBackgroundWork();
    expect(ctx.mailer.sent).toHaveLength(0);
    expect(await tokenRows()).toHaveLength(0);
  });

  it('mails exactly one link to an active user, and the link resets the password', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const res = await forgot(user.email);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    await vi.waitFor(() => expect(ctx.mailer.sent).toHaveLength(1));
    await settleBackgroundWork();
    expect(ctx.mailer.sent).toHaveLength(1);

    const mail = ctx.mailer.sent[0] as Mail;
    expect(mail.to).toBe(user.email);
    const link = linkOf(mail);
    expect(`${link.origin}${link.pathname}`).toBe(`${ctx.config.appOrigin}/reinitialiser`);
    expect([...link.searchParams.keys()]).toEqual(['token']);

    expect((await reset(tokenOf(mail), NEW_PASSWORD)).statusCode).toBe(204);
    await expect(login(ctx, user.email, user.password)).rejects.toThrow('401');
    await expect(login(ctx, user.email, NEW_PASSWORD)).resolves.toMatch(/dl_session=/);
  });

  it('normalises the address (case and surrounding spaces)', async () => {
    const user = await seedUser(ctx, { role: 'affiliate', email: 'lina.haddad@example.test' });
    expect((await forgot('  Lina.Haddad@EXAMPLE.test ')).statusCode).toBe(204);
    await vi.waitFor(() => expect(ctx.mailer.sent).toHaveLength(1));
    expect((ctx.mailer.sent[0] as Mail).to).toBe(user.email);
  });

  it('mails nothing to a suspended or an invited user', async () => {
    const suspended = await seedUser(ctx, { role: 'affiliate', status: 'suspended' });
    const deactivated = await seedUser(ctx, { role: 'affiliate', status: 'deactivated' });
    const invited = await seedInvited();
    for (const email of [suspended.email, deactivated.email, invited.email]) {
      expect((await forgot(email)).statusCode).toBe(204);
    }
    await settleBackgroundWork();
    expect(ctx.mailer.sent).toHaveLength(0);
    expect(await tokenRows()).toHaveLength(0);
  });

  it('answers byte for byte the same whether the account is active, suspended, invited or unknown', async () => {
    const active = await seedUser(ctx, { role: 'affiliate' });
    const suspended = await seedUser(ctx, { role: 'affiliate', status: 'suspended' });
    const invited = await seedInvited();
    const results = [];
    for (const email of [active.email, suspended.email, invited.email, 'nobody@example.test']) {
      results.push(shape(await forgot(email)));
    }
    await settleBackgroundWork();
    expect(results[0]).toEqual({ status: 204, body: '', headers: results[0]?.headers });
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('does not wait for the mail to be delivered before answering', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: Mail[] = [];
    ctx.mailer.send = async (mail) => {
      await gate;
      delivered.push(mail);
    };
    const res = await forgot(user.email);
    expect(res.statusCode).toBe(204);
    expect(delivered).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
  });

  it('still answers 204 when the mail cannot be sent, and never rejects unhandled', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const attempted = vi.fn(async () => {
      throw new Error(`smtp down for ${user.email}`);
    });
    ctx.mailer.send = attempted;
    const res = await forgot(user.email);
    expect(res.statusCode).toBe(204);
    await vi.waitFor(() => expect(attempted).toHaveBeenCalledTimes(1));
    await settleBackgroundWork();
  });

  it('makes the first link invalid when a second one is requested', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const first = await requestResetToken(user.email);
    const second = await requestResetToken(user.email);
    expect(second).not.toBe(first);
    expect((await reset(first, NEW_PASSWORD)).json()).toEqual(INVALID_TOKEN);
    expect((await reset(second, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('rejects a malformed body as a validation error', async () => {
    const res = await post('/api/auth/password/forgot', { email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation');
  });
});

describe('POST /api/auth/password/reset', () => {
  it('sets the password, answers 204 with no session, and writes an audit row', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const token = await requestResetToken(user.email);
    const res = await reset(token, NEW_PASSWORD);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await verifyPassword((await userRow(user.id)).passwordHash as string, NEW_PASSWORD)).toBe(true);

    const rows = (await audits()).filter((a) => a.action === 'auth.password_reset');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorUserId).toBe(user.id);
    expect(rows[0]?.entityType).toBe('user');
    expect(rows[0]?.entityId).toBe(user.id);
    const dump = JSON.stringify(await audits());
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(NEW_PASSWORD);
    expect(dump).not.toContain((await userRow(user.id)).passwordHash as string);
    expect(dump).not.toContain('argon2');
  });

  it('refuses a token that was already used', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const token = await requestResetToken(user.email);
    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    const again = await reset(token, 'Another-peony-2026');
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual(INVALID_TOKEN);
    expect(await verifyPassword((await userRow(user.id)).passwordHash as string, NEW_PASSWORD)).toBe(true);
  });

  it('refuses the token 30 minutes after it was issued, and accepts it a second before', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const late = await requestResetToken(user.email);
    ctx.clock.advance(31 * MINUTE);
    const res = await reset(late, NEW_PASSWORD);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(INVALID_TOKEN);

    const fresh = await requestResetToken(user.email);
    ctx.clock.advance(RESET_TTL_MS - 1_000);
    expect((await reset(fresh, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('answers 400 invalid_token and keeps a user suspended after the mail was sent suspended', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const token = await requestResetToken(user.email);
    const before = (await userRow(user.id)).passwordHash;
    await ctx.db.update(users).set({ status: 'suspended' }).where(eq(users.id, user.id));

    const res = await reset(token, NEW_PASSWORD);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(INVALID_TOKEN);
    const after = await userRow(user.id);
    expect(after.status).toBe('suspended');
    expect(after.passwordHash).toBe(before);
  });

  it('rolls everything back when the user is suspended after the checks, token included', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, user.email, user.password);
    const token = await requestResetToken(user.email);
    const before = (await userRow(user.id)).passwordHash;

    const outcome = await resetPassword(
      {
        ...deps(),
        afterChecks: async () => {
          await ctx.db.update(users).set({ status: 'suspended' }).where(eq(users.id, user.id));
        },
      },
      { token, password: NEW_PASSWORD, ip: '127.0.0.1', requestId: 'req-test-1' },
    );
    expect(outcome).toEqual({ kind: 'invalid_token' });
    const after = await userRow(user.id);
    expect(after.status).toBe('suspended');
    expect(after.passwordHash).toBe(before);
    const [row] = await ctx.db.select().from(authTokens).where(eq(authTokens.tokenHash, hashToken(token)));
    expect(row?.usedAt).toBeNull();
    const live = await ctx.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(live.every((s) => s.revokedAt === null)).toBe(true);
    expect(cookie).toBeTruthy();
    expect((await audits()).filter((a) => a.action === 'auth.password_reset')).toHaveLength(0);
  });

  it('lets exactly one of two parallel resets with the same token win', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const token = await requestResetToken(user.email);
    const results = await Promise.all([reset(token, NEW_PASSWORD), reset(token, 'Another-peony-2026')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400]);
    expect((await audits()).filter((a) => a.action === 'auth.password_reset')).toHaveLength(1);
  });

  it('revokes every existing session', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const one = await login(ctx, user.email, user.password);
    const two = await login(ctx, user.email, user.password);
    const token = await requestResetToken(user.email);
    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    for (const cookie of [one, two]) {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(res.statusCode).toBe(401);
    }
    const rows = await ctx.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('unlocks a locked account and clears the failed-login counter', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    await ctx.db
      .update(users)
      .set({ failedLogins: 10, lockedUntil: new Date(ctx.clock().getTime() + 15 * MINUTE) })
      .where(eq(users.id, user.id));
    await expect(login(ctx, user.email, user.password)).rejects.toThrow('401');
    const token = await requestResetToken(user.email);
    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    const after = await userRow(user.id);
    expect(after.failedLogins).toBe(0);
    expect(after.lockedUntil).toBeNull();
    await expect(login(ctx, user.email, NEW_PASSWORD)).resolves.toMatch(/dl_session=/);
  });

  it('keeps the account active and does not turn two-factor off', async () => {
    const user = await seedUser(ctx, { role: 'affiliate', totp: true });
    const token = await requestResetToken(user.email);
    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    const after = await userRow(user.id);
    expect(after.totpEnabled).toBe(true);
    expect(after.totpSecretEnc).not.toBeNull();
    expect(after.status).toBe('active');
    // The new password alone is not enough any more than the old one was.
    const res = await post('/api/auth/login', { email: user.email, password: NEW_PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'totp_required' });
  });

  it('answers a weak password with a validation error and keeps the same link usable', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const token = await requestResetToken(user.email);
    const weak = await reset(token, 'short');
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('validation');
    expect(typeof weak.json().errors.password).toBe('string');
    expect(weak.json().errors.password.length).toBeGreaterThan(0);
    expect((await userRow(user.id)).passwordHash).not.toBeNull();
    const [row] = await ctx.db.select().from(authTokens).where(eq(authTokens.tokenHash, hashToken(token)));
    expect(row?.usedAt).toBeNull();

    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('does not reveal why a token is refused: every failure is the same response', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const suspended = await seedUser(ctx, { role: 'affiliate' });
    const wrongType = await issueToken(ctx.db, { userId: user.id, type: 'invite', now: ctx.clock() });
    const used = await requestResetToken(user.email);
    expect((await reset(used, NEW_PASSWORD)).statusCode).toBe(204);
    const expired = await requestResetToken(user.email);
    ctx.clock.advance(RESET_TTL_MS + 1_000);
    const toSuspend = await requestResetToken(suspended.email);
    await ctx.db.update(users).set({ status: 'suspended' }).where(eq(users.id, suspended.id));

    const attempts = [
      'not-a-token-at-all',
      wrongType,
      used,
      expired,
      toSuspend,
    ];
    const shapes = [];
    for (const token of attempts) shapes.push(shape(await reset(token, 'Another-peony-2026')));
    expect(shapes[0]?.status).toBe(400);
    expect(JSON.parse(shapes[0]?.body ?? '')).toEqual(INVALID_TOKEN);
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });

  it('refuses an invitation token, and the refusal does not use the invitation up', async () => {
    const { user, token } = await invitation();
    const res = await reset(token, NEW_PASSWORD);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(INVALID_TOKEN);
    expect((await userRow(user.id)).status).toBe('invited');
    expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('marks the user’s other unused reset tokens as used', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const now = ctx.clock();
    const first = await issueToken(ctx.db, { userId: user.id, type: 'password_reset', now });
    // A token that was issued without going through issueToken (for example by an older release).
    await ctx.db.insert(authTokens).values({
      userId: user.id,
      type: 'password_reset',
      tokenHash: hashToken('legacy-token-value'),
      expiresAt: new Date(now.getTime() + RESET_TTL_MS),
    });
    expect((await reset(first, NEW_PASSWORD)).statusCode).toBe(204);
    const rows = await ctx.db.select().from(authTokens).where(eq(authTokens.userId, user.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.usedAt !== null)).toBe(true);
    expect((await reset('legacy-token-value', 'Another-peony-2026')).json()).toEqual(INVALID_TOKEN);
  });
});

describe('POST /api/auth/password/change and a pending reset link', () => {
  it('makes an earlier reset link invalid', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, user.email, user.password);
    const link = await requestResetToken(user.email);
    const changed = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password/change',
      headers: { ...csrfHeaders(ctx), cookie },
      remoteAddress: freshAddress(),
      payload: { currentPassword: user.password, newPassword: NEW_PASSWORD },
    });
    expect(changed.statusCode).toBe(204);
    const res = await reset(link, 'Another-peony-2026');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(INVALID_TOKEN);
    expect(await verifyPassword((await userRow(user.id)).passwordHash as string, NEW_PASSWORD)).toBe(true);
  });
});

describe('invitations', () => {
  it('accept sets the password, activates the user, opens no session, and login then works', async () => {
    const { user, token } = await invitation();
    const res = await accept(token, NEW_PASSWORD);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['set-cookie']).toBeUndefined();
    const row = await userRow(user.id);
    expect(row.status).toBe('active');
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(row.passwordHash as string, NEW_PASSWORD)).toBe(true);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
    await expect(login(ctx, user.email, NEW_PASSWORD)).resolves.toMatch(/dl_session=/);
  });

  it('refuses the same token a second time', async () => {
    const { token } = await invitation();
    expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(204);
    const again = await accept(token, 'Another-peony-2026');
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual(INVALID_TOKEN);
  });

  it('writes an audit row without the token, the password or the hash', async () => {
    const { user, token } = await invitation();
    expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(204);
    const rows = (await audits()).filter((a) => a.action === 'auth.invite_accepted');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorUserId).toBe(user.id);
    expect(rows[0]?.entityId).toBe(user.id);
    const dump = JSON.stringify(await audits());
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(NEW_PASSWORD);
    expect(dump).not.toContain('argon2');
    expect(JSON.stringify(await tokenRows())).not.toContain(token);
  });

  it('never activates a user who was suspended before accepting', async () => {
    const { user, token } = await invitation();
    await ctx.db.update(users).set({ status: 'suspended' }).where(eq(users.id, user.id));
    const res = await accept(token, NEW_PASSWORD);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(INVALID_TOKEN);
    const row = await userRow(user.id);
    expect(row.status).toBe('suspended');
    expect(row.passwordHash).toBeNull();
    // A deactivated user is refused the same way.
    await ctx.db.update(users).set({ status: 'deactivated' }).where(eq(users.id, user.id));
    expect((await accept(token, NEW_PASSWORD)).json()).toEqual(INVALID_TOKEN);
    expect((await userRow(user.id)).status).toBe('deactivated');
  });

  it('rolls back, token included, when the user is suspended after the checks', async () => {
    const { user, token } = await invitation();
    const outcome = await acceptInvite(
      {
        ...deps(),
        afterChecks: async () => {
          await ctx.db.update(users).set({ status: 'suspended' }).where(eq(users.id, user.id));
        },
      },
      { token, password: NEW_PASSWORD, ip: '127.0.0.1', requestId: 'req-test-2' },
    );
    expect(outcome).toEqual({ kind: 'invalid_token' });
    const row = await userRow(user.id);
    expect(row.status).toBe('suspended');
    expect(row.passwordHash).toBeNull();
    const [tokenRow] = await ctx.db.select().from(authTokens).where(eq(authTokens.tokenHash, hashToken(token)));
    expect(tokenRow?.usedAt).toBeNull();
    expect((await audits()).filter((a) => a.action === 'auth.invite_accepted')).toHaveLength(0);
  });

  it('refuses a token for a user who is already active, without using the token up', async () => {
    const user = await seedUser(ctx, { role: 'affiliate' });
    const token = await issueToken(ctx.db, { userId: user.id, type: 'invite', now: ctx.clock() });
    const before = (await userRow(user.id)).passwordHash;
    expect((await accept(token, NEW_PASSWORD)).json()).toEqual(INVALID_TOKEN);
    expect((await userRow(user.id)).passwordHash).toBe(before);
    const [row] = await tokenRows();
    expect(row?.usedAt).toBeNull();
  });

  it('refuses the token after 7 days and accepts it a second before', async () => {
    const late = await invitation();
    ctx.clock.advance(INVITE_TTL_MS + 1_000);
    const res = await accept(late.token, NEW_PASSWORD);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(INVALID_TOKEN);
    expect((await userRow(late.user.id)).status).toBe('invited');

    const fresh = await invitation();
    ctx.clock.advance(INVITE_TTL_MS - 1_000);
    expect((await accept(fresh.token, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('answers a weak password with a validation error and keeps the same link usable', async () => {
    const { user, token } = await invitation();
    const weak = await accept(token, 'password');
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('validation');
    expect(typeof weak.json().errors.password).toBe('string');
    expect((await userRow(user.id)).status).toBe('invited');
    expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('lets exactly one of two parallel accepts win', async () => {
    const { token } = await invitation();
    const results = await Promise.all([accept(token, NEW_PASSWORD), accept(token, 'Another-peony-2026')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400]);
    expect((await audits()).filter((a) => a.action === 'auth.invite_accepted')).toHaveLength(1);
  });

  it('refuses a password-reset token', async () => {
    const user = await seedInvited();
    const token = await issueToken(ctx.db, { userId: user.id, type: 'password_reset', now: ctx.clock() });
    expect((await accept(token, NEW_PASSWORD)).json()).toEqual(INVALID_TOKEN);
    expect((await userRow(user.id)).status).toBe('invited');
    expect((await lookup(token)).statusCode).toBe(404);
  });

  it('answers every refusal of a token the same way', async () => {
    const used = await invitation();
    expect((await accept(used.token, NEW_PASSWORD)).statusCode).toBe(204);
    const expired = await invitation();
    const suspended = await invitation();
    await ctx.db.update(users).set({ status: 'suspended' }).where(eq(users.id, suspended.user.id));
    const resetToken = await issueToken(ctx.db, { userId: expired.user.id, type: 'password_reset', now: ctx.clock() });
    ctx.clock.advance(INVITE_TTL_MS + 1_000);
    const fresh = await invitation();
    expect((await accept(fresh.token, NEW_PASSWORD)).statusCode).toBe(204);

    const shapes = [];
    for (const token of ['unknown-token', used.token, expired.token, suspended.token, resetToken]) {
      shapes.push(shape(await accept(token, 'Another-peony-2026')));
    }
    expect(shapes[0]?.status).toBe(400);
    expect(JSON.parse(shapes[0]?.body ?? '')).toEqual(INVALID_TOKEN);
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });
});

describe('GET /api/auth/invite/:token', () => {
  it('returns the name and email for a valid invitation and does not consume it', async () => {
    const { user, token } = await invitation();
    const res = await lookup(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: user.email, fullName: 'Test User' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await lookup(token)).statusCode).toBe(200);
    expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('answers 404 not_found, identically, for unknown, used, expired and suspended', async () => {
    const used = await invitation();
    expect((await accept(used.token, NEW_PASSWORD)).statusCode).toBe(204);
    const suspended = await invitation();
    await ctx.db.update(users).set({ status: 'suspended' }).where(eq(users.id, suspended.user.id));
    const expired = await invitation();
    ctx.clock.advance(INVITE_TTL_MS + 1_000);

    const shapes = [];
    for (const token of ['unknown-token', used.token, suspended.token, expired.token]) {
      shapes.push(shape(await lookup(token)));
    }
    expect(shapes[0]?.status).toBe(404);
    expect(JSON.parse(shapes[0]?.body ?? '')).toEqual(NOT_FOUND);
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });
});

describe('rate limits', () => {
  it('allows 10 requests in 15 minutes per address across lookup, accept and reset, then answers 429', async () => {
    const ip = '203.0.113.7';
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) codes.push((await lookup(`unknown-${i}`, ip)).statusCode);
    for (let i = 0; i < 3; i += 1) codes.push((await accept(`unknown-${i}`, NEW_PASSWORD, ip)).statusCode);
    for (let i = 0; i < 3; i += 1) codes.push((await reset(`unknown-${i}`, NEW_PASSWORD, ip)).statusCode);
    expect(codes).toEqual([404, 404, 404, 404, 400, 400, 400, 400, 400, 400]);

    for (const res of [await lookup('x', ip), await accept('x', NEW_PASSWORD, ip), await reset('x', NEW_PASSWORD, ip)]) {
      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ code: 'too_many_attempts' });
      expect(res.headers['retry-after']).toBeDefined();
    }
    // Another address is unaffected.
    expect((await lookup('x', '203.0.113.8')).statusCode).toBe(404);
  });

  it('blocks a valid token as well once the budget is spent', async () => {
    const ip = '203.0.113.20';
    const { token } = await invitation();
    for (let i = 0; i < 10; i += 1) await lookup(`unknown-${i}`, ip);
    expect((await accept(token, NEW_PASSWORD, ip)).statusCode).toBe(429);
    expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('allows 5 forgot requests in 15 minutes per address, then answers 429', async () => {
    const ip = '203.0.113.30';
    for (let i = 0; i < 5; i += 1) expect((await forgot('nobody@example.test', ip)).statusCode).toBe(204);
    const sixth = await forgot('nobody@example.test', ip);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toEqual({ code: 'too_many_attempts' });
    expect((await forgot('nobody@example.test', '203.0.113.31')).statusCode).toBe(204);
    // Forgot has a budget of its own: the token routes are still open from that address.
    expect((await reset('x', NEW_PASSWORD, ip)).statusCode).toBe(400);
    await settleBackgroundWork();
  });
});
