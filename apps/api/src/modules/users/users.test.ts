import { Writable } from 'node:stream';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS, type Permission, type Role } from '@darling/shared';
import { buildApp } from '../../app';
import { auditLog, authTokens, sessions, settings, userPermissions, users } from '../../db/schema';
import { memoryMailer } from '../../mail/mailer';
import {
  createTestContext,
  csrfHeaders,
  freshAddress,
  login,
  seedUser,
  type SeededUser,
  type TestContext,
} from '../../../test/context';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext({
    build: {
      extend(app) {
        // A probe behind a permission other than users.manage, to see grants take effect.
        app.get(
          '/api/_probe/audit',
          { config: { access: { kind: 'permission', permission: 'audit.read' } } },
          async () => ({ ok: true }),
        );
      },
    },
  });
  // Super managers in these tests have no authenticator; do not make them enrol first.
  await ctx.db.insert(settings).values({ key: 'security.require_2fa_super_managers', value: false });
});
afterEach(async () => {
  await ctx.close();
});

type Body = Record<string, unknown>;
type Call = { cookie?: string; payload?: Body; query?: Body; headers?: Record<string, string>; ip?: string };

function call(method: 'GET' | 'POST' | 'PATCH', url: string, opts: Call = {}) {
  return ctx.app.inject({
    method,
    url,
    headers: { ...csrfHeaders(ctx), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    remoteAddress: opts.ip ?? freshAddress(),
    ...(opts.payload === undefined ? {} : { payload: opts.payload }),
    ...(opts.query === undefined ? {} : { query: opts.query as Record<string, string> }),
  });
}

const get = (url: string, cookie?: string, query?: Body) => call('GET', url, { cookie, query });
const create = (cookie: string | undefined, payload: Body, extra: Call = {}) =>
  call('POST', '/api/users', { cookie, payload, ...extra });
const patch = (cookie: string | undefined, id: string, payload: Body, extra: Call = {}) =>
  call('PATCH', `/api/users/${id}`, { cookie, payload, ...extra });
const action = (
  cookie: string | undefined,
  id: string,
  verb: 'suspend' | 'reactivate' | 'resend-invite' | 'revoke-sessions',
  payload?: Body,
  extra: Call = {},
) => call('POST', `/api/users/${id}/${verb}`, { cookie, payload, ...extra });
const probe = (cookie: string) => get('/api/_probe/audit', cookie);
const me = (cookie: string) => get('/api/auth/me', cookie);

type Actor = SeededUser & { cookie: string };

async function seedAndLogin(role: Role, extra: { isOwner?: boolean; permissions?: Permission[] } = {}): Promise<Actor> {
  const user = await seedUser(ctx, { role, ...extra });
  return { ...user, cookie: await login(ctx, user.email, user.password) };
}
const owner = () => seedAndLogin('super_manager', { isOwner: true });
const manager = () => seedAndLogin('super_manager', { permissions: ['users.manage'] });

async function row(id: string) {
  const [found] = await ctx.db.select().from(users).where(eq(users.id, id));
  if (!found) throw new Error('user not found');
  return found;
}
const audits = () => ctx.db.select().from(auditLog).orderBy(asc(auditLog.id));
const auditsFor = async (action: string, entityId?: string) =>
  (await audits()).filter((a) => a.action === action && (entityId === undefined || a.entityId === entityId));
async function liveSessions(userId: string) {
  const rows = await ctx.db.select().from(sessions).where(eq(sessions.userId, userId));
  return rows.filter((s) => s.revokedAt === null).length;
}
async function grantsOf(id: string) {
  const rows = await ctx.db.select().from(userPermissions).where(eq(userPermissions.userId, id));
  return rows.map((r) => r.permission).sort();
}
async function activeOwnerIds(): Promise<string[]> {
  const rows = await ctx.db.select().from(users).where(eq(users.isOwner, true));
  return rows.filter((r) => r.status === 'active').map((r) => r.id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Holds row locks on the given users in a test transaction, so requests queue up behind them. */
async function holdLocks(ids: string[]) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let acquired!: () => void;
  const got = new Promise<void>((r) => (acquired = r));
  const done = ctx.db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(inArray(users.id, ids)).orderBy(users.id).for('update');
    acquired();
    await released;
  });
  await got;
  return {
    async release() {
      release();
      await done;
    },
  };
}

/** Resolves once `n` database sessions wait on a lock: the requests under test are queued. */
async function waitForBlocked(n: number) {
  for (let i = 0; i < 200; i += 1) {
    const res = await ctx.db.execute(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((res.rows[0] as { n: number }).n >= n) return;
    await sleep(25);
  }
  throw new Error(`expected ${n} requests to be blocked on a lock`);
}

/** Fires the requests while the owner rows are locked, then lets them race for the lock. */
async function raceBehindLock<T>(ownerIds: string[], fire: () => Promise<T>[]): Promise<T[]> {
  const hold = await holdLocks(ownerIds);
  let all: Promise<T[]> | undefined;
  try {
    const pending = fire();
    all = Promise.all(pending);
    await waitForBlocked(pending.length);
  } finally {
    // Always let go, or a failing test would leave the rows locked for every later one.
    await hold.release();
  }
  return all;
}

const sortedStatuses = (res: { statusCode: number }[]) => res.map((r) => r.statusCode).sort((a, b) => a - b);

describe('POST /api/users', () => {
  it('creates an invited user with a normalised email and mails one invitation', async () => {
    const admin = await manager();
    const res = await create(admin.cookie, {
      email: ' Aya@Mail.com ',
      fullName: 'Aya Benali',
      phone: '+213 551 23 45 67',
      role: 'affiliate',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      email: 'aya@mail.com',
      fullName: 'Aya Benali',
      phone: '0551234567',
      role: 'affiliate',
      status: 'invited',
      isOwner: false,
      permissions: [],
      twoFactorEnabled: false,
      lastLoginAt: null,
    });

    const stored = await row(body.id);
    expect(stored.email).toBe('aya@mail.com');
    expect(stored.passwordHash).toBeNull();
    expect(stored.status).toBe('invited');

    expect(ctx.mailer.sent).toHaveLength(1);
    const mail = ctx.mailer.sent[0]!;
    expect(mail.to).toBe('aya@mail.com');
    const token = /\/invitation\?token=([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1];
    expect(token).toBeDefined();
    const tokens = await ctx.db.select().from(authTokens).where(eq(authTokens.userId, body.id));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.type).toBe('invite');
  });

  it('refuses the same email in another case with 409 email_taken, and sends no second mail', async () => {
    const admin = await manager();
    expect((await create(admin.cookie, { email: ' Aya@Mail.com ', fullName: 'Aya', role: 'affiliate' })).statusCode).toBe(201);
    const second = await create(admin.cookie, { email: 'aya@mail.COM', fullName: 'Aya 2', role: 'affiliate' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ code: 'email_taken' });
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(await auditsFor('user.created')).toHaveLength(1);
  });

  it('lets exactly one of several parallel creates of the same email win, never a 500', async () => {
    const admin = await manager();
    const results = await Promise.all(
      ['dup@mail.com', 'DUP@mail.com', ' dup@Mail.com', 'dup@mail.COM', 'Dup@mail.com'].map((email) =>
        create(admin.cookie, { email, fullName: 'Dup', role: 'affiliate' }),
      ),
    );
    expect(sortedStatuses(results)).toEqual([201, 409, 409, 409, 409]);
    expect(await ctx.db.select().from(users).where(eq(users.email, 'dup@mail.com'))).toHaveLength(1);
    expect(ctx.mailer.sent).toHaveLength(1);
  });

  it('creates sub managers and affiliates for a non-owner with users.manage, but never a super manager', async () => {
    const admin = await manager();
    expect((await create(admin.cookie, { email: 'sub@mail.com', fullName: 'Sub Manager', role: 'sub_manager' })).statusCode).toBe(201);
    expect((await create(admin.cookie, { email: 'aff@mail.com', fullName: 'Affiliate', role: 'affiliate' })).statusCode).toBe(201);

    const refused = await create(admin.cookie, { email: 'boss@mail.com', fullName: 'Boss', role: 'super_manager' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ code: 'owner_required' });
    const withGrants = await create(admin.cookie, {
      email: 'boss2@mail.com',
      fullName: 'Boss',
      role: 'super_manager',
      permissions: ['audit.read'],
    });
    expect(withGrants.json()).toEqual({ code: 'owner_required' });
    const wantsOwner = await create(admin.cookie, {
      email: 'boss3@mail.com',
      fullName: 'Boss',
      role: 'super_manager',
      isOwner: true,
    });
    expect(wantsOwner.json()).toEqual({ code: 'owner_required' });
    expect(await ctx.db.select().from(users).where(eq(users.email, 'boss@mail.com'))).toHaveLength(0);
  });

  it('lets an owner create super managers with grants, and other owners', async () => {
    const boss = await owner();
    const sm = await create(boss.cookie, {
      email: 'sm@mail.com',
      fullName: 'Super Manager',
      role: 'super_manager',
      permissions: ['audit.read', 'users.manage', 'audit.read'],
    });
    expect(sm.statusCode).toBe(201);
    expect(sm.json().permissions).toEqual(['users.manage', 'audit.read']);
    expect(await grantsOf(sm.json().id)).toEqual(['audit.read', 'users.manage']);

    const second = await create(boss.cookie, {
      email: 'owner2@mail.com',
      fullName: 'Second Owner',
      role: 'super_manager',
      isOwner: true,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().isOwner).toBe(true);
    expect(second.json().permissions).toEqual([...PERMISSIONS]);
  });

  it('rejects permissions and isOwner for anyone but a super manager, and bad input', async () => {
    const boss = await owner();
    for (const extra of [{ permissions: ['audit.read'] }, { permissions: [] }, { isOwner: true }, { isOwner: false }]) {
      const res = await create(boss.cookie, { email: 'x@mail.com', fullName: 'Xavier', role: 'affiliate', ...extra });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('validation');
      expect(Object.keys(res.json().errors).length).toBeGreaterThan(0);
    }
    const sub = await create(boss.cookie, { email: 'x@mail.com', fullName: 'Xavier', role: 'sub_manager', permissions: ['audit.read'] });
    expect(sub.statusCode).toBe(400);

    const badPhone = await create(boss.cookie, { email: 'x@mail.com', fullName: 'Xavier', role: 'affiliate', phone: '12345' });
    expect(badPhone.statusCode).toBe(400);
    expect(badPhone.json().code).toBe('validation');
    expect(badPhone.json().errors).toHaveProperty('phone');
    const badEmail = await create(boss.cookie, { email: 'nope', fullName: 'Xavier', role: 'affiliate' });
    expect(badEmail.statusCode).toBe(400);
    expect(await ctx.db.select().from(users).where(eq(users.email, 'x@mail.com'))).toHaveLength(0);
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('answers 201 and keeps the user invited when the invitation mail cannot be sent', async () => {
    const admin = await manager();
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const failing = {
      sent: [],
      async send() {
        throw new Error('550 5.1.1 <aya@mail.com> mailbox unavailable');
      },
    };
    // A second app on the same database whose mailer always fails, with its log captured.
    const app = await buildApp(
      { config: ctx.config, db: ctx.db, mailer: failing, clock: ctx.clock },
      { logStream },
    );
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { ...csrfHeaders(ctx), cookie: admin.cookie },
        remoteAddress: freshAddress(),
        payload: { email: 'aya@mail.com', fullName: 'Aya Benali', role: 'affiliate' },
      });
      expect(res.statusCode).toBe(201);
      expect((await row(res.json().id)).status).toBe('invited');
      await sleep(50);
      expect(unhandled).toEqual([]);
      const log = lines.join('');
      expect(log).toContain('invitation');
      expect(log).not.toContain('aya@mail.com');
      expect(log).not.toContain('mailbox unavailable');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await app.close();
    }
    // The user can be re-sent an invitation through the normal app.
    const [created] = await ctx.db.select().from(users).where(eq(users.email, 'aya@mail.com'));
    const resend = await action(admin.cookie, created!.id, 'resend-invite');
    expect(resend.statusCode).toBe(204);
    expect(ctx.mailer.sent).toHaveLength(1);
  });
});

describe('access to /api/users', () => {
  it('answers 401 without a session, and 403 to affiliates, sub managers and super managers without users.manage', async () => {
    const boss = await owner();
    const target = await seedUser(ctx, { role: 'affiliate' });
    const callers: (string | undefined)[] = [undefined];
    callers.push((await seedAndLogin('affiliate')).cookie);
    callers.push((await seedAndLogin('sub_manager')).cookie);
    callers.push((await seedAndLogin('super_manager', { permissions: ['orders.read', 'audit.read'] })).cookie);
    void boss;

    for (const [index, cookie] of callers.entries()) {
      const expected = index === 0 ? 401 : 403;
      const attempts = [
        get('/api/users', cookie),
        get(`/api/users/${target.id}`, cookie),
        create(cookie, { email: 'z@mail.com', fullName: 'Zed Zed', role: 'affiliate' }),
        patch(cookie, target.id, { fullName: 'Hacked' }),
        action(cookie, target.id, 'suspend'),
        action(cookie, target.id, 'reactivate'),
        action(cookie, target.id, 'resend-invite'),
        action(cookie, target.id, 'revoke-sessions'),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.statusCode).toBe(expected);
        expect(Object.keys(res.json())).toEqual(['code']);
      }
    }
    expect((await row(target.id)).fullName).toBe('Test User');
    expect(await ctx.db.select().from(users).where(eq(users.email, 'z@mail.com'))).toHaveLength(0);
  });

  it('answers 404 for an unknown or malformed id on every id route', async () => {
    const admin = await manager();
    const unknown = '0190b3a2-0000-7000-8000-000000000000';
    for (const id of [unknown, 'not-a-uuid', '12345', '%00', 'x'.repeat(90)]) {
      for (const res of [
        await get(`/api/users/${encodeURIComponent(id)}`, admin.cookie),
        await patch(admin.cookie, encodeURIComponent(id), { fullName: 'Nobody' }),
        await action(admin.cookie, encodeURIComponent(id), 'suspend'),
        await action(admin.cookie, encodeURIComponent(id), 'reactivate'),
        await action(admin.cookie, encodeURIComponent(id), 'resend-invite'),
        await action(admin.cookie, encodeURIComponent(id), 'revoke-sessions'),
      ]) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ code: 'not_found' });
      }
    }
  });

  it('returns an existing user without any secret field', async () => {
    const boss = await owner();
    const target = await seedUser(ctx, { role: 'super_manager', permissions: ['audit.read', 'users.manage'], totp: true });
    const res = await get(`/api/users/${target.id}`, boss.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: target.id,
      email: target.email,
      role: 'super_manager',
      status: 'active',
      isOwner: false,
      permissions: ['users.manage', 'audit.read'],
      twoFactorEnabled: true,
    });
    const text = res.body.toLowerCase();
    for (const forbidden of ['password', 'hash', 'totp', 'secret', 'token']) expect(text).not.toContain(forbidden);
    expect((await row(target.id)).passwordHash).toBeTruthy();
    expect(res.body).not.toContain((await row(target.id)).passwordHash!);
  });
});

describe('owner rules', () => {
  it('requires an owner to edit, suspend or otherwise manage a super manager', async () => {
    const admin = await manager();
    const sm = await seedUser(ctx, { role: 'super_manager', permissions: ['audit.read'] });
    const smSession = await login(ctx, sm.email, sm.password);
    const refusals = [
      await patch(admin.cookie, sm.id, { fullName: 'Renamed' }),
      await patch(admin.cookie, sm.id, { permissions: ['orders.read'] }),
      await patch(admin.cookie, sm.id, { isOwner: true }),
      await patch(admin.cookie, sm.id, { role: 'affiliate' }),
      await action(admin.cookie, sm.id, 'suspend'),
      await action(admin.cookie, sm.id, 'reactivate'),
      await action(admin.cookie, sm.id, 'resend-invite'),
      await action(admin.cookie, sm.id, 'revoke-sessions'),
    ];
    for (const res of refusals) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ code: 'owner_required' });
    }
    const after = await row(sm.id);
    expect(after.fullName).toBe('Test User');
    expect(after.status).toBe('active');
    expect(await grantsOf(sm.id)).toEqual(['audit.read']);
    expect((await me(smSession)).statusCode).toBe(200);
    expect(await audits()).toHaveLength(0);

    // Reading is allowed: users.manage covers the whole directory.
    expect((await get(`/api/users/${sm.id}`, admin.cookie)).statusCode).toBe(200);
  });

  it('refuses a non-owner who tries to make someone an owner, grant permissions or promote to super manager', async () => {
    const admin = await manager();
    const aff = await seedUser(ctx, { role: 'affiliate' });

    // On an affiliate the flags are simply invalid (400); promoting the role itself needs an owner.
    for (const payload of [{ isOwner: true }, { permissions: ['audit.read'] }]) {
      const res = await patch(admin.cookie, aff.id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('validation');
    }
    for (const payload of [{ role: 'super_manager' }, { role: 'super_manager', permissions: ['audit.read'] }]) {
      const res = await patch(admin.cookie, aff.id, payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ code: 'owner_required' });
    }
    expect((await row(aff.id)).role).toBe('affiliate');
  });

  it('lets an owner promote an affiliate to super manager with grants, and sets the owner flag', async () => {
    const boss = await owner();
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const promoted = await patch(boss.cookie, aff.id, { role: 'super_manager', permissions: ['audit.read'] });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ role: 'super_manager', isOwner: false, permissions: ['audit.read'] });

    const crowned = await patch(boss.cookie, aff.id, { isOwner: true });
    expect(crowned.statusCode).toBe(200);
    expect(crowned.json()).toMatchObject({ isOwner: true, permissions: [...PERMISSIONS] });
    expect((await row(aff.id)).isOwner).toBe(true);
  });

  it('removes grants when a super manager becomes another role, and demands the owner flag be cleared first', async () => {
    const boss = await owner();
    const sm = await seedUser(ctx, { role: 'super_manager', permissions: ['audit.read', 'orders.read'] });
    const session = await login(ctx, sm.email, sm.password);

    const demoted = await patch(boss.cookie, sm.id, { role: 'sub_manager' });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json()).toMatchObject({ role: 'sub_manager', isOwner: false, permissions: [] });
    expect(await grantsOf(sm.id)).toEqual([]);
    expect((await me(session)).statusCode).toBe(401);

    const second = await seedUser(ctx, { role: 'super_manager', isOwner: true });
    const blocked = await patch(boss.cookie, second.id, { role: 'affiliate' });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().code).toBe('validation');
    expect(blocked.json().errors).toHaveProperty('role');
    const stillOwner = await row(second.id);
    expect(stillOwner.role).toBe('super_manager');
    expect(stillOwner.isOwner).toBe(true);

    // Demote first, then change the role.
    expect((await patch(boss.cookie, second.id, { isOwner: false })).statusCode).toBe(200);
    expect((await patch(boss.cookie, second.id, { role: 'affiliate' })).statusCode).toBe(200);
  });

  it('refuses permissions or the owner flag when the resulting role is not super manager', async () => {
    const boss = await owner();
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const sm = await seedUser(ctx, { role: 'super_manager' });
    for (const [id, payload] of [
      [aff.id, { permissions: ['audit.read'] }],
      [aff.id, { isOwner: true }],
      [aff.id, { isOwner: false }],
      [sm.id, { role: 'affiliate', permissions: ['audit.read'] }],
      [sm.id, { role: 'sub_manager', isOwner: false }],
    ] as const) {
      const res = await patch(boss.cookie, id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('validation');
    }
    expect(await grantsOf(aff.id)).toEqual([]);
  });
});

describe('PATCH /api/users/:id', () => {
  it('lets a non-owner edit name and phone of a sub manager without touching sessions, with an audit entry', async () => {
    const admin = await manager();
    const sub = await seedAndLogin('sub_manager');
    const res = await patch(admin.cookie, sub.id, { fullName: '  Nadia Haddad ', phone: '0661 23 45 67' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fullName: 'Nadia Haddad', phone: '0661234567', role: 'sub_manager' });
    expect((await me(sub.cookie)).statusCode).toBe(200);

    const [entry] = await auditsFor('user.updated', sub.id);
    expect(entry).toBeDefined();
    expect(entry!.actorUserId).toBe(admin.id);
    expect(entry!.entityType).toBe('user');
    expect(entry!.before).toMatchObject({ fullName: 'Test User', phone: null });
    expect(entry!.after).toMatchObject({ fullName: 'Nadia Haddad', phone: '0661234567' });
  });

  it('records the reason and writes nothing when nothing changes', async () => {
    const admin = await manager();
    const aff = await seedUser(ctx, { role: 'affiliate' });
    expect((await patch(admin.cookie, aff.id, { fullName: 'Test User' })).statusCode).toBe(200);
    expect(await audits()).toHaveLength(0);

    const res = await patch(admin.cookie, aff.id, { fullName: 'Lina Messaoudi', reason: 'correction' });
    expect(res.statusCode).toBe(200);
    const [entry] = await auditsFor('user.updated', aff.id);
    expect(entry!.reason).toBe('correction');
  });

  it('cannot change the email, and rejects invalid input', async () => {
    const admin = await manager();
    const aff = await seedUser(ctx, { role: 'affiliate', email: 'keep@mail.com' });
    const res = await patch(admin.cookie, aff.id, { email: 'new@mail.com', fullName: 'Same Person' });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('keep@mail.com');
    expect((await row(aff.id)).email).toBe('keep@mail.com');

    for (const payload of [{ fullName: '' }, { phone: 'abc' }, { role: 'overlord' }, { permissions: ['nope'] }]) {
      const bad = await patch(admin.cookie, aff.id, payload);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe('validation');
    }
  });

  it('revokes the target sessions when role, permissions or owner flag change (Review Focus 4)', async () => {
    const boss = await owner();
    const sm = await seedAndLogin('super_manager');
    expect((await probe(sm.cookie)).statusCode).toBe(403);

    const grant = await patch(boss.cookie, sm.id, { permissions: ['audit.read'] });
    expect(grant.statusCode).toBe(200);
    expect(grant.json().permissions).toEqual(['audit.read']);
    // The old session is gone, the grant is not usable until a fresh login.
    expect((await probe(sm.cookie)).statusCode).toBe(401);
    expect((await me(sm.cookie)).statusCode).toBe(401);
    expect(await liveSessions(sm.id)).toBe(0);

    const fresh = await login(ctx, sm.email, sm.password);
    expect((await probe(fresh)).statusCode).toBe(200);

    const remove = await patch(boss.cookie, sm.id, { permissions: [] });
    expect(remove.statusCode).toBe(200);
    expect((await probe(fresh)).statusCode).toBe(401);
    const again = await login(ctx, sm.email, sm.password);
    expect((await probe(again)).statusCode).toBe(403);
    expect((await me(again)).statusCode).toBe(200);

    // Role change and owner flag revoke too; repeating the same permissions does not.
    expect((await patch(boss.cookie, sm.id, { permissions: [] })).statusCode).toBe(200);
    expect((await me(again)).statusCode).toBe(200);
    expect((await patch(boss.cookie, sm.id, { isOwner: true })).statusCode).toBe(200);
    expect((await me(again)).statusCode).toBe(401);

    const sub = await seedAndLogin('sub_manager');
    expect((await patch(boss.cookie, sub.id, { role: 'affiliate' })).statusCode).toBe(200);
    expect((await me(sub.cookie)).statusCode).toBe(401);
  });

  it('lets a non-owner change a sub manager into an affiliate, revoking their sessions', async () => {
    const admin = await manager();
    const sub = await seedAndLogin('sub_manager');
    const res = await patch(admin.cookie, sub.id, { role: 'affiliate' });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('affiliate');
    expect((await me(sub.cookie)).statusCode).toBe(401);
  });
});

describe('self rules', () => {
  it('forbids changing your own role or permissions', async () => {
    const boss = await owner();
    const other = await seedUser(ctx, { role: 'super_manager', isOwner: true });
    void other;
    for (const payload of [{ role: 'sub_manager' }, { permissions: ['audit.read'] }, { role: 'sub_manager', isOwner: false }]) {
      const res = await patch(boss.cookie, boss.id, payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ code: 'forbidden' });
    }
    const stored = await row(boss.id);
    expect(stored.role).toBe('super_manager');
    expect(stored.isOwner).toBe(true);
    expect(await grantsOf(boss.id)).toEqual([]);
    expect((await me(boss.cookie)).statusCode).toBe(200);

    // A non-owner super manager cannot touch their own permissions either.
    const admin = await manager();
    const own = await patch(admin.cookie, admin.id, { permissions: ['users.manage', 'audit.read'] });
    expect(own.statusCode).toBe(403);
    expect(await grantsOf(admin.id)).toEqual(['users.manage']);
  });

  it('refuses to suspend yourself, even as the last owner', async () => {
    const boss = await owner();
    const res = await action(boss.cookie, boss.id, 'suspend');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'cannot_suspend_self' });
    expect((await row(boss.id)).status).toBe('active');
    expect(await audits()).toHaveLength(0);

    const admin = await manager();
    expect((await action(admin.cookie, admin.id, 'suspend')).json()).toEqual({ code: 'cannot_suspend_self' });
  });

  it('lets an owner clear their own flag only while another active owner remains', async () => {
    const a = await owner();
    const b = await seedUser(ctx, { role: 'super_manager', isOwner: true, status: 'suspended' });

    // The only other owner is suspended, so it does not count.
    const blocked = await patch(a.cookie, a.id, { isOwner: false });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ code: 'last_owner' });
    expect((await row(a.id)).isOwner).toBe(true);
    expect((await me(a.cookie)).statusCode).toBe(200);

    await ctx.db.update(users).set({ status: 'active' }).where(eq(users.id, b.id));
    const ok = await patch(a.cookie, a.id, { isOwner: false });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ isOwner: false, role: 'super_manager' });
    expect((await row(a.id)).isOwner).toBe(false);
    expect((await me(a.cookie)).statusCode).toBe(401);
    expect(await activeOwnerIds()).toEqual([b.id]);
  });

  it('does not count an invited owner as an active one', async () => {
    const a = await owner();
    await seedUser(ctx, { role: 'super_manager', isOwner: true, status: 'invited' });
    const res = await patch(a.cookie, a.id, { isOwner: false });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'last_owner' });
  });
});

describe('last owner invariant under concurrency (Review Focus 2)', () => {
  async function twoOwners() {
    // Earlier iterations leave owners behind; only the two under test may be owners now.
    await ctx.db.update(users).set({ isOwner: false });
    const a = await owner();
    const b = await owner();
    return { a, b };
  }

  it('lets exactly one of two owners remove the other flag, held at the lock', async () => {
    for (let i = 0; i < 10; i += 1) {
      const { a, b } = await twoOwners();
      const results = await raceBehindLock([a.id, b.id], () => [
        patch(b.cookie, a.id, { isOwner: false }),
        patch(a.cookie, b.id, { isOwner: false }),
      ]);
      expect(sortedStatuses(results)).toEqual([200, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json()).toEqual({ code: 'last_owner' });
      expect(await activeOwnerIds()).toHaveLength(1);
    }
  });

  it('lets exactly one of two owners suspend the other, and one demote while the other suspends', async () => {
    for (let i = 0; i < 6; i += 1) {
      const { a, b } = await twoOwners();
      const results = await raceBehindLock([a.id, b.id], () => [
        action(b.cookie, a.id, 'suspend'),
        action(a.cookie, b.id, 'suspend'),
      ]);
      expect(sortedStatuses(results)).toEqual([204, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json()).toEqual({ code: 'last_owner' });
      expect(await activeOwnerIds()).toHaveLength(1);
    }
    for (let i = 0; i < 6; i += 1) {
      const { a, b } = await twoOwners();
      const results = await raceBehindLock([a.id, b.id], () => [
        patch(b.cookie, a.id, { isOwner: false }),
        action(a.cookie, b.id, 'suspend'),
      ]);
      // One of them lands (200 for the demotion, 204 for the suspension); the other is refused.
      expect(results.map((r) => r.statusCode).filter((s) => s === 409)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 200 || r.statusCode === 204)).toHaveLength(1);
      expect(results.find((r) => r.statusCode === 409)!.json()).toEqual({ code: 'last_owner' });
      expect(await activeOwnerIds()).toHaveLength(1);
    }
  });

  it('never leaves zero owners with three owners demoting each other in a cycle', async () => {
    for (let i = 0; i < 6; i += 1) {
      await ctx.db.update(users).set({ isOwner: false });
      const a = await owner();
      const b = await owner();
      const c = await owner();
      const results = await raceBehindLock([a.id, b.id, c.id], () => [
        patch(a.cookie, b.id, { isOwner: false }),
        patch(b.cookie, c.id, { isOwner: false }),
        patch(c.cookie, a.id, { isOwner: false }),
      ]);
      expect(sortedStatuses(results)).toEqual([200, 200, 409]);
      expect(await activeOwnerIds()).toHaveLength(1);
    }
  });

  it('keeps at least one owner when the same races run without any holding', async () => {
    for (let i = 0; i < 10; i += 1) {
      const { a, b } = await twoOwners();
      const results = await Promise.all([
        patch(b.cookie, a.id, { isOwner: false }),
        patch(a.cookie, b.id, { isOwner: false }),
        action(a.cookie, b.id, 'suspend'),
        action(b.cookie, a.id, 'suspend'),
      ]);
      for (const res of results) expect([200, 204, 401, 409]).toContain(res.statusCode);
      expect((await activeOwnerIds()).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('suspend, reactivate, resend-invite, revoke-sessions', () => {
  it('suspends a user: 204, no login, existing session dead, audited', async () => {
    const admin = await manager();
    const target = await seedAndLogin('affiliate');
    expect(await liveSessions(target.id)).toBe(1);

    const res = await action(admin.cookie, target.id, 'suspend', { reason: 'fraud suspicion' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await row(target.id)).status).toBe('suspended');
    expect((await me(target.cookie)).statusCode).toBe(401);
    expect(await liveSessions(target.id)).toBe(0);

    const attempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: csrfHeaders(ctx),
      remoteAddress: freshAddress(),
      payload: { email: target.email, password: target.password },
    });
    expect(attempt.statusCode).toBe(401);
    expect(attempt.json()).toEqual({ code: 'invalid_credentials' });

    const [entry] = await auditsFor('user.suspended', target.id);
    expect(entry).toBeDefined();
    expect(entry!.actorUserId).toBe(admin.id);
    expect(entry!.reason).toBe('fraud suspicion');
    expect(entry!.before).toMatchObject({ status: 'active' });
    expect(entry!.after).toMatchObject({ status: 'suspended' });
  });

  it('suspends twice with a single audit row', async () => {
    const admin = await manager();
    const target = await seedUser(ctx, { role: 'affiliate' });
    expect((await action(admin.cookie, target.id, 'suspend')).statusCode).toBe(204);
    expect((await action(admin.cookie, target.id, 'suspend')).statusCode).toBe(204);
    expect(await auditsFor('user.suspended')).toHaveLength(1);
  });

  it('accepts a body-less request, an empty object and an over-long reason', async () => {
    const admin = await manager();
    const target = await seedUser(ctx, { role: 'affiliate' });
    expect((await action(admin.cookie, target.id, 'suspend', {})).statusCode).toBe(204);
    expect((await action(admin.cookie, target.id, 'reactivate', {})).statusCode).toBe(204);
    const long = await action(admin.cookie, target.id, 'suspend', { reason: 'x'.repeat(501) });
    expect(long.statusCode).toBe(400);
    expect(long.json().code).toBe('validation');
    expect((await row(target.id)).status).toBe('active');
  });

  it('reactivates a suspended user with a password to active, who can log in again', async () => {
    const admin = await manager();
    const target = await seedUser(ctx, { role: 'affiliate', status: 'suspended' });
    const res = await action(admin.cookie, target.id, 'reactivate');
    expect(res.statusCode).toBe(204);
    expect((await row(target.id)).status).toBe('active');
    expect(await login(ctx, target.email, target.password)).toBeTruthy();
    const [entry] = await auditsFor('user.reactivated', target.id);
    expect(entry!.before).toMatchObject({ status: 'suspended' });
    expect(entry!.after).toMatchObject({ status: 'active' });
  });

  it('returns a never-activated user to invited on reactivation, and resending the invitation works', async () => {
    const admin = await manager();
    const created = await create(admin.cookie, { email: 'new@mail.com', fullName: 'New Hire', role: 'affiliate' });
    const id = created.json().id as string;
    expect(ctx.mailer.sent).toHaveLength(1);

    expect((await action(admin.cookie, id, 'suspend')).statusCode).toBe(204);
    expect((await action(admin.cookie, id, 'resend-invite')).json()).toEqual({ code: 'not_invited' });

    expect((await action(admin.cookie, id, 'reactivate')).statusCode).toBe(204);
    expect((await row(id)).status).toBe('invited');
    const [entry] = await auditsFor('user.reactivated', id);
    expect(entry!.after).toMatchObject({ status: 'invited' });

    const resend = await action(admin.cookie, id, 'resend-invite');
    expect(resend.statusCode).toBe(204);
    expect(ctx.mailer.sent).toHaveLength(2);
    expect(ctx.mailer.sent[1]!.to).toBe('new@mail.com');
    expect(ctx.mailer.sent[1]!.text).toMatch(/\/invitation\?token=[A-Za-z0-9_-]{43}/);
    expect(await auditsFor('user.invite_resent', id)).toHaveLength(1);

    // Only the newest link is live.
    const tokens = await ctx.db.select().from(authTokens).where(eq(authTokens.userId, id));
    expect(tokens.filter((t) => t.usedAt === null)).toHaveLength(1);
  });

  it('refuses to reactivate a user who is not suspended and to resend an invitation to an active one', async () => {
    const admin = await manager();
    const active = await seedUser(ctx, { role: 'affiliate' });
    const reactivate = await action(admin.cookie, active.id, 'reactivate');
    expect(reactivate.statusCode).toBe(409);
    expect(reactivate.json()).toEqual({ code: 'not_suspended' });
    const resend = await action(admin.cookie, active.id, 'resend-invite');
    expect(resend.statusCode).toBe(409);
    expect(resend.json()).toEqual({ code: 'not_invited' });
    expect(ctx.mailer.sent).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });

  it('suspends an invited user, and a deactivated user is neither suspended nor reactivated', async () => {
    const admin = await manager();
    const invited = await seedUser(ctx, { role: 'affiliate', status: 'invited' });
    expect((await action(admin.cookie, invited.id, 'suspend')).statusCode).toBe(204);
    expect((await row(invited.id)).status).toBe('suspended');

    const gone = await seedUser(ctx, { role: 'affiliate', status: 'deactivated' });
    expect((await action(admin.cookie, gone.id, 'suspend')).statusCode).toBe(409);
    expect((await action(admin.cookie, gone.id, 'reactivate')).json()).toEqual({ code: 'not_suspended' });
    expect((await row(gone.id)).status).toBe('deactivated');
  });

  it('lets an owner suspend, reactivate and revoke sessions of a super manager', async () => {
    const boss = await owner();
    const sm = await seedAndLogin('super_manager');
    expect((await action(boss.cookie, sm.id, 'suspend')).statusCode).toBe(204);
    expect((await me(sm.cookie)).statusCode).toBe(401);
    expect((await action(boss.cookie, sm.id, 'reactivate')).statusCode).toBe(204);
    const session = await login(ctx, sm.email, sm.password);
    expect((await me(session)).statusCode).toBe(200);

    const revoke = await action(boss.cookie, sm.id, 'revoke-sessions', { reason: 'lost laptop' });
    expect(revoke.statusCode).toBe(204);
    expect((await me(session)).statusCode).toBe(401);
    const [entry] = await auditsFor('user.sessions_revoked', sm.id);
    expect(entry!.reason).toBe('lost laptop');
    expect(entry!.actorUserId).toBe(boss.id);
  });

  it('revokes every session of the target with revoke-sessions and leaves the actor and others alone', async () => {
    const admin = await manager();
    const target = await seedAndLogin('affiliate');
    const second = await login(ctx, target.email, target.password);
    const bystander = await seedAndLogin('affiliate');
    expect(await liveSessions(target.id)).toBe(2);

    expect((await action(admin.cookie, target.id, 'revoke-sessions')).statusCode).toBe(204);
    expect((await me(target.cookie)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(401);
    expect((await me(bystander.cookie)).statusCode).toBe(200);
    expect((await me(admin.cookie)).statusCode).toBe(200);
    expect((await row(target.id)).status).toBe('active');
  });
});

describe('GET /api/users', () => {
  type Item = { id: string; fullName: string; email: string; role: string; status: string };

  async function seedDirectory() {
    const admin = await manager();
    const make = async (role: Role, patchRow: Partial<typeof users.$inferInsert>) => {
      const user = await seedUser(ctx, { role });
      await ctx.db.update(users).set(patchRow).where(eq(users.id, user.id));
      return user;
    };
    const aya = await make('affiliate', { fullName: 'Aya Benali' });
    const byEmail = await make('affiliate', { fullName: 'Karim Saidi', email: 'contact.AYA@mail.com' });
    const byPhone = await make('sub_manager', { fullName: 'Nour Hamdi', phone: '0551234567' });
    const percent = await make('affiliate', { fullName: 'Promo 100% Club', status: 'suspended' });
    const underscore = await make('affiliate', { fullName: 'Lina_Messaoudi' });
    const backslash = await make('affiliate', { fullName: 'Sami\\Bouzid' });
    const plain = await make('affiliate', { fullName: 'Lina Messaoudi' });
    return { admin, aya, byEmail, byPhone, percent, underscore, backslash, plain };
  }

  const ids = (res: { json(): { items: Item[] } }) => res.json().items.map((i) => i.id);

  it('filters by q on name, email and phone, case-insensitively', async () => {
    const d = await seedDirectory();
    const aya = await get('/api/users', d.admin.cookie, { q: 'aya' });
    expect(aya.statusCode).toBe(200);
    expect(ids(aya).sort()).toEqual([d.aya.id, d.byEmail.id].sort());
    expect(aya.json().total).toBe(2);

    expect(ids(await get('/api/users', d.admin.cookie, { q: 'AYA BEN' }))).toEqual([d.aya.id]);
    expect(ids(await get('/api/users', d.admin.cookie, { q: '55123' }))).toEqual([d.byPhone.id]);
    expect(ids(await get('/api/users', d.admin.cookie, { q: ' hamdi ' }))).toEqual([d.byPhone.id]);
    expect(ids(await get('/api/users', d.admin.cookie, { q: 'zzz-nothing' }))).toEqual([]);
  });

  it('treats %, _ and \\ in q literally', async () => {
    const d = await seedDirectory();
    expect(ids(await get('/api/users', d.admin.cookie, { q: '%' }))).toEqual([d.percent.id]);
    expect(ids(await get('/api/users', d.admin.cookie, { q: '_' }))).toEqual([d.underscore.id]);
    expect(ids(await get('/api/users', d.admin.cookie, { q: '\\' }))).toEqual([d.backslash.id]);
    expect(ids(await get('/api/users', d.admin.cookie, { q: 'Lina_M' }))).toEqual([d.underscore.id]);
    const all = await get('/api/users', d.admin.cookie, { q: 'Lina' });
    expect(ids(all).sort()).toEqual([d.underscore.id, d.plain.id].sort());
  });

  it('filters by role and status, and rejects unknown values', async () => {
    const d = await seedDirectory();
    const affiliates = await get('/api/users', d.admin.cookie, { role: 'affiliate' });
    expect(affiliates.json().items.every((i: Item) => i.role === 'affiliate')).toBe(true);
    expect(affiliates.json().total).toBe(6);

    const suspended = await get('/api/users', d.admin.cookie, { status: 'suspended' });
    expect(ids(suspended)).toEqual([d.percent.id]);
    const combined = await get('/api/users', d.admin.cookie, { role: 'sub_manager', status: 'active' });
    expect(ids(combined)).toEqual([d.byPhone.id]);

    for (const query of [{ role: 'overlord' }, { status: 'gone' }, { page: '0' }, { page: 'x' }]) {
      const res = await get('/api/users', d.admin.cookie, query);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('validation');
    }
  });

  it('pages 50 at a time, newest first, with a stable total', async () => {
    const admin = await manager();
    const base = Date.parse('2026-02-01T00:00:00Z');
    await ctx.db.insert(users).values(
      Array.from({ length: 59 }, (_, i) => ({
        email: `bulk-${i}@example.test`,
        fullName: `Bulk ${i}`,
        role: 'affiliate' as const,
        status: 'active' as const,
        createdAt: new Date(base + i * 1000),
      })),
    );
    const first = await get('/api/users', admin.cookie);
    const second = await get('/api/users', admin.cookie, { page: '2' });
    const third = await get('/api/users', admin.cookie, { page: '3' });
    expect(first.json().items).toHaveLength(50);
    expect(second.json().items).toHaveLength(10);
    expect(third.json().items).toHaveLength(0);
    expect(first.json().total).toBe(60);
    expect(second.json().total).toBe(60);

    const all = [...first.json().items, ...second.json().items] as Item[];
    expect(new Set(all.map((i) => i.id)).size).toBe(60);
    // The admin was created just now; the bulk rows carry ascending times in the past: newest first.
    expect(all[0]!.id).toBe(admin.id);
    expect(all[1]!.email).toBe('bulk-58@example.test');
    expect(all[59]!.email).toBe('bulk-0@example.test');
  });

  it('returns user DTOs with grants in catalogue order and every permission for an owner', async () => {
    const boss = await owner();
    await seedUser(ctx, { role: 'super_manager', permissions: ['audit.read', 'orders.read'] });
    const res = await get('/api/users', boss.cookie, { role: 'super_manager' });
    const items = res.json().items as { isOwner: boolean; permissions: string[] }[];
    expect(items.find((i) => i.isOwner)!.permissions).toEqual([...PERMISSIONS]);
    expect(items.find((i) => !i.isOwner)!.permissions).toEqual(['orders.read', 'audit.read']);
    const text = res.body.toLowerCase();
    for (const forbidden of ['password', 'hash', 'totp']) expect(text).not.toContain(forbidden);
  });
});

describe('audit entries', () => {
  it('carry actor, ip and request id, and never a secret', async () => {
    const admin = await manager();
    const ip = '10.9.8.7';
    const requestId = 'req-audit-12345';
    const headers = { 'x-request-id': requestId };

    const created = await create(
      admin.cookie,
      { email: 'audit@mail.com', fullName: 'Audit Target', phone: '0551234567', role: 'affiliate' },
      { ip, headers },
    );
    const id = created.json().id as string;
    const inviteToken = /token=([A-Za-z0-9_-]{43})/.exec(ctx.mailer.sent[0]!.text)![1]!;
    await ctx.db.update(users).set({ totpSecretEnc: 'enc-secret-value', totpEnabled: true }).where(eq(users.id, id));
    await action(admin.cookie, id, 'suspend', undefined, { ip, headers });
    await action(admin.cookie, id, 'reactivate', undefined, { ip, headers });
    await patch(admin.cookie, id, { fullName: 'Audit Renamed' }, { ip, headers });
    await action(admin.cookie, id, 'revoke-sessions', undefined, { ip, headers });
    await ctx.db.update(users).set({ status: 'invited', passwordHash: null }).where(eq(users.id, id));
    await action(admin.cookie, id, 'resend-invite', undefined, { ip, headers });

    const entries = (await audits()).filter((a) => a.entityId === id);
    expect(entries.map((a) => a.action)).toEqual([
      'user.created',
      'user.suspended',
      'user.reactivated',
      'user.updated',
      'user.sessions_revoked',
      'user.invite_resent',
    ]);
    const stored = await row(id);
    const resendToken = /token=([A-Za-z0-9_-]{43})/.exec(ctx.mailer.sent[1]!.text)![1]!;
    for (const entry of entries) {
      expect(entry.actorUserId).toBe(admin.id);
      expect(entry.entityType).toBe('user');
      expect(entry.ip).toBe(ip);
      expect(entry.requestId).toBe(requestId);
      const json = JSON.stringify(entry);
      for (const secret of [inviteToken, resendToken, 'enc-secret-value', 'password', 'totp', 'hash']) {
        expect(json.toLowerCase()).not.toContain(secret.toLowerCase());
      }
      for (const side of [entry.before, entry.after]) {
        if (side === null) continue;
        expect(Object.keys(side as object).sort()).toEqual(
          ['email', 'fullName', 'isOwner', 'permissions', 'phone', 'role', 'status'],
        );
      }
    }
    expect(stored.passwordHash).toBeNull();

    const [first] = entries;
    expect(first!.before).toBeNull();
    expect(first!.after).toMatchObject({
      email: 'audit@mail.com',
      fullName: 'Audit Target',
      phone: '0551234567',
      role: 'affiliate',
      status: 'invited',
      isOwner: false,
      permissions: [],
    });
  });

  it('record permissions as an array on a super manager change', async () => {
    const boss = await owner();
    const sm = await seedUser(ctx, { role: 'super_manager', permissions: ['orders.read'] });
    await patch(boss.cookie, sm.id, { permissions: ['audit.read', 'orders.read'] });
    const [entry] = await auditsFor('user.updated', sm.id);
    expect(entry!.before).toMatchObject({ permissions: ['orders.read'] });
    expect(entry!.after).toMatchObject({ permissions: ['orders.read', 'audit.read'] });
  });
});
