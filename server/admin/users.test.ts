import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS, userSchema, type Permission, type Role } from '@/shared';
import { settleBackgroundWork } from '../mail/outbox';
import { createTestApp, login, seedUser, type SeededUser, type TestApp } from '../test/app';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
  // Super managers in these tests have no authenticator; do not make them enrol first.
  app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
});
afterEach(async () => {
  await settleBackgroundWork();
  app.close();
});

type Body = Record<string, unknown>;
type Call = { cookie?: string; body?: Body };

const call = (method: string, url: string, opts: Call = {}) =>
  app.call(url, { method, cookie: opts.cookie, ...(opts.body === undefined ? {} : { body: opts.body }) });
const get = (url: string, cookie?: string) => call('GET', url, { cookie });
const create = (cookie: string | undefined, body: Body) => call('POST', '/api/users', { cookie, body });
const patch = (cookie: string | undefined, id: string, body: Body) => call('PATCH', `/api/users/${id}`, { cookie, body });
const action = (cookie: string | undefined, id: string, verb: 'suspend' | 'reactivate' | 'resend-invite' | 'revoke-sessions', body?: Body) =>
  call('POST', `/api/users/${id}/${verb}`, { cookie, ...(body ? { body } : {}) });
const me = (cookie: string) => get('/api/auth/me', cookie);

type Actor = SeededUser & { cookie: string };

async function seedAndLogin(role: Role, extra: { isOwner?: boolean; permissions?: Permission[]; fullName?: string } = {}): Promise<Actor> {
  const user = await seedUser(app, { role, ...extra });
  return { ...user, cookie: await login(app, user.email, user.password) };
}
const owner = () => seedAndLogin('super_manager', { isOwner: true });
const manager = () => seedAndLogin('super_manager', { permissions: ['users.manage'] });

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  full_name: string;
  phone: string | null;
  role: Role;
  status: string;
  is_owner: number;
  updated_at: number;
}
const row = (id: string) => {
  const found = app.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!found) throw new Error('user not found');
  return found;
};
interface AuditRow {
  id: number;
  actor_user_id: string | null;
  action: string;
  entity_id: string;
  before: string | null;
  after: string | null;
  reason: string | null;
  ip: string | null;
}
const audits = () => app.db.all<AuditRow>('SELECT * FROM audit_log ORDER BY id');
const auditsFor = (action: string, entityId?: string) => audits().filter((a) => a.action === action && (entityId === undefined || a.entity_id === entityId));
const liveSessions = (userId: string) =>
  app.db.get<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', userId)?.n ?? 0;
const grantsOf = (id: string) => app.db.all<{ permission: string }>('SELECT permission FROM user_permissions WHERE user_id = ? ORDER BY permission', id).map((r) => r.permission);
const activeOwnerIds = () => app.db.all<{ id: string }>("SELECT id FROM users WHERE is_owner = 1 AND status = 'active'").map((r) => r.id);
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('POST /api/users', () => {
  it('creates an invited user with a normalised email, no password, and mails one invitation', async () => {
    const admin = await manager();
    const res = await create(admin.cookie, { email: '  Aya.Test@Example.COM ', fullName: ' Aya Benali ', phone: '+213 550 12 34 56', role: 'affiliate' });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(userSchema.parse(body)).toMatchObject({
      email: 'aya.test@example.com',
      fullName: 'Aya Benali',
      phone: '0550123456',
      role: 'affiliate',
      status: 'invited',
      isOwner: false,
      permissions: [],
      twoFactorEnabled: false,
      lastLoginAt: null,
    });
    const stored = row(body.id as string);
    expect(stored.password_hash).toBeNull();

    await settleBackgroundWork();
    expect(app.mailer.sent).toHaveLength(1);
    expect(app.mailer.sent[0]?.to).toBe('aya.test@example.com');
    expect(app.mailer.sent[0]?.text).toMatch(/\/invitation\?token=[A-Za-z0-9_-]{43}/);

    const [entry] = auditsFor('user.created', stored.id);
    expect(entry?.actor_user_id).toBe(admin.id);
    expect(JSON.parse(entry?.after ?? 'null')).toMatchObject({ email: 'aya.test@example.com', role: 'affiliate', status: 'invited', isOwner: false });
    expect(entry?.before).toBeNull();
  });

  it('audit rows never carry a credential', async () => {
    const admin = await manager();
    const res = await create(admin.cookie, { email: 'x@example.test', fullName: 'Xena', role: 'sub_manager' });
    const id = (await json(res)).id as string;
    await action(admin.cookie, id, 'resend-invite');
    await action(admin.cookie, id, 'suspend', { reason: 'test' });
    await patch(admin.cookie, id, { fullName: 'Xena B' });
    const text = JSON.stringify(audits());
    for (const forbidden of [/password/i, /totp/i, /token/i, /scrypt\$/, /secret/i, /hash/i]) expect(text).not.toMatch(forbidden);
  });

  it('refuses the same email in another case with 409 email_taken and sends no second mail', async () => {
    const admin = await manager();
    expect((await create(admin.cookie, { email: 'dup@example.test', fullName: 'First', role: 'affiliate' })).status).toBe(201);
    const res = await create(admin.cookie, { email: 'DUP@Example.test', fullName: 'Second', role: 'affiliate' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ code: 'email_taken' });
    await settleBackgroundWork();
    expect(app.mailer.sent).toHaveLength(1);
    expect(app.db.get<{ n: number }>("SELECT count(*) AS n FROM users WHERE email = 'dup@example.test'")?.n).toBe(1);
  });

  it('maps a unique violation that slips past the pre-check to 409 (never a 500)', async () => {
    const admin = await manager();
    // Simulate a racing writer: the email appears between the pre-check read and the insert.
    const real = app.db.transaction.bind(app.db);
    let armed = true;
    app.db.transaction = ((fn: (tx: typeof app.db) => unknown, mode?: 'immediate' | 'deferred') =>
      real((tx) => {
        const run = tx.run.bind(tx);
        if (armed) {
          tx.run = ((sql: string, ...p: never[]) => {
            if (armed && /^\s*INSERT INTO users/i.test(sql)) {
              armed = false;
              run(
                "INSERT INTO users (id, email, full_name, role, status, created_at, updated_at) VALUES ('race', 'race@example.test', 'R', 'affiliate', 'invited', 1, 1)",
              );
            }
            return run(sql, ...p);
          }) as typeof tx.run;
        }
        return fn(tx);
      }, mode)) as typeof app.db.transaction;
    const res = await create(admin.cookie, { email: 'race@example.test', fullName: 'Racer', role: 'affiliate' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ code: 'email_taken' });
    expect(audits().filter((a) => a.action === 'user.created')).toHaveLength(0);
  });

  it('lets exactly one of several parallel creates of the same email win, never a 500', async () => {
    app.close();
    app = createTestApp({ file: true, connections: 3 });
    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
    const admin = await manager();
    const results = await Promise.all(
      ['a@example.test', 'A@example.test', 'a@EXAMPLE.test', ' a@example.test '].map((email) =>
        create(admin.cookie, { email, fullName: 'Same Person', role: 'affiliate' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(app.db.get<{ n: number }>("SELECT count(*) AS n FROM users WHERE email = 'a@example.test'")?.n).toBe(1);
  });

  it('creates sub managers and affiliates for a non-owner with users.manage, but never a super manager', async () => {
    const admin = await manager();
    for (const role of ['sub_manager', 'affiliate'] as const) {
      const res = await create(admin.cookie, { email: `${role}@example.test`, fullName: 'Someone', role });
      expect(res.status).toBe(201);
    }
    const res = await create(admin.cookie, { email: 'sm@example.test', fullName: 'Someone', role: 'super_manager', permissions: ['audit.read'] });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ code: 'owner_required' });
    expect(app.db.get("SELECT 1 FROM users WHERE email = 'sm@example.test'")).toBeUndefined();
  });

  it('lets an owner create super managers with grants, and other owners without any grant rows', async () => {
    const boss = await owner();
    const sm = await create(boss.cookie, { email: 'sm@example.test', fullName: 'Super Two', role: 'super_manager', permissions: ['audit.read', 'users.manage'] });
    expect(sm.status).toBe(201);
    const smBody = await json(sm);
    expect(smBody.permissions).toEqual(['users.manage', 'audit.read']); // catalogue order
    expect(grantsOf(smBody.id as string)).toEqual(['audit.read', 'users.manage']);

    const o2 = await create(boss.cookie, { email: 'o2@example.test', fullName: 'Owner Two', role: 'super_manager', isOwner: true, permissions: ['audit.read'] });
    expect(o2.status).toBe(201);
    const o2Body = await json(o2);
    expect(o2Body).toMatchObject({ isOwner: true, status: 'invited' });
    expect((o2Body.permissions as string[]).length).toBe(PERMISSIONS.length);
    expect(grantsOf(o2Body.id as string)).toEqual([]);
  });

  it('rejects permissions and isOwner for anyone but a super manager, and bad input', async () => {
    const boss = await owner();
    const a = await create(boss.cookie, { email: 'a@example.test', fullName: 'Aya', role: 'affiliate', permissions: ['audit.read'] });
    expect(a.status).toBe(400);
    expect(((await json(a)).errors as Record<string, string>).permissions).toBeTruthy();
    const b = await create(boss.cookie, { email: 'b@example.test', fullName: 'Aya', role: 'sub_manager', isOwner: true });
    expect(((await json(b)).errors as Record<string, string>).isOwner).toBeTruthy();
    for (const bad of [{}, { email: 'nope', fullName: 'Aya', role: 'affiliate' }, { email: 'c@example.test', fullName: 'A', role: 'affiliate' }, { email: 'c@example.test', fullName: 'Aya', role: 'boss' }, { email: 'c@example.test', fullName: 'Aya', role: 'affiliate', phone: '123' }, { email: 'c@example.test', fullName: 'Aya', role: 'super_manager', permissions: ['nope'] }]) {
      const res = await create(boss.cookie, bad);
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('validation');
    }
    expect(app.db.get<{ n: number }>('SELECT count(*) AS n FROM users')?.n).toBe(1); // only the seeded owner
  });

  it('answers 201 and keeps the user invited when the invitation mail cannot be sent', async () => {
    const admin = await manager();
    app.mailer.send = async () => {
      throw new Error('smtp down for nobody@example.test');
    };
    const res = await create(admin.cookie, { email: 'mailfail@example.test', fullName: 'Mail Fail', role: 'affiliate' });
    expect(res.status).toBe(201);
    await settleBackgroundWork();
    expect(row((await json(res)).id as string).status).toBe('invited');
  });

  it('the invitation link in the mail activates the account', async () => {
    const admin = await manager();
    await create(admin.cookie, { email: 'invitee@example.test', fullName: 'Invitee', role: 'affiliate' });
    await settleBackgroundWork();
    const token = /token=([A-Za-z0-9_-]{43})/.exec(app.mailer.sent[0]?.text ?? '')?.[1];
    const accepted = await app.call('/api/auth/invite/accept', { body: { token, password: 'Rose-gloss-2026' } });
    expect(accepted.status).toBe(204);
  });
});

describe('access to /api/users', () => {
  it('answers 401 without a session, and 403 to affiliates, sub managers and super managers without users.manage', async () => {
    const target = await seedUser(app, { role: 'affiliate' });
    const noPermission = await seedAndLogin('super_manager', { permissions: ['audit.read', 'orders.read'] });
    const callers: [string, string | undefined][] = [
      ['anonymous', undefined],
      ['affiliate', (await seedAndLogin('affiliate')).cookie],
      ['sub_manager', (await seedAndLogin('sub_manager')).cookie],
      ['super manager without users.manage', noPermission.cookie],
    ];
    for (const [name, cookie] of callers) {
      const expected = name === 'anonymous' ? 401 : 403;
      const code = name === 'anonymous' ? 'unauthenticated' : 'forbidden';
      const requests = [
        get('/api/users', cookie),
        create(cookie, {}),
        get(`/api/users/${target.id}`, cookie),
        patch(cookie, target.id, {}),
        action(cookie, target.id, 'suspend'),
        action(cookie, target.id, 'reactivate'),
        action(cookie, target.id, 'resend-invite'),
        action(cookie, target.id, 'revoke-sessions'),
      ];
      for (const res of await Promise.all(requests)) {
        expect(res.status, name).toBe(expected);
        expect(await json(res), name).toEqual({ code });
      }
    }
  });

  it('answers 404 for an unknown or malformed id on every id route', async () => {
    const admin = await manager();
    const ids = ['018f0000-0000-7000-8000-000000000000', 'not-an-id', '1', '%00', 'x'.repeat(200), '018f0000-0000-7000-8000-00000000000g'];
    for (const id of ids) {
      const path = encodeURIComponent(id);
      const responses = [
        get(`/api/users/${path}`, admin.cookie),
        patch(admin.cookie, path, { fullName: 'Someone' }),
        action(admin.cookie, path, 'suspend'),
        action(admin.cookie, path, 'reactivate'),
        action(admin.cookie, path, 'resend-invite'),
        action(admin.cookie, path, 'revoke-sessions'),
      ];
      for (const res of await Promise.all(responses)) {
        expect(res.status, id).toBe(404);
        expect(await json(res), id).toEqual({ code: 'not_found' });
      }
    }
  });

  it('returns an existing user without any secret field', async () => {
    const admin = await manager();
    const target = await seedUser(app, { role: 'affiliate', totp: true });
    const res = await get(`/api/users/${target.id}`, admin.cookie);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'email', 'fullName', 'id', 'isOwner', 'lastLoginAt', 'permissions', 'phone', 'role', 'status', 'twoFactorEnabled'].sort());
    expect(body.twoFactorEnabled).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/scrypt|totp_secret|password/i);
  });
});

describe('owner rules', () => {
  it('requires an owner to edit, suspend or otherwise manage a super manager', async () => {
    const admin = await manager();
    const boss = await owner();
    const other = await seedAndLogin('super_manager', { permissions: ['audit.read'] });
    for (const res of [
      await patch(admin.cookie, other.id, { fullName: 'Renamed' }),
      await action(admin.cookie, other.id, 'suspend'),
      await action(admin.cookie, other.id, 'revoke-sessions'),
      await action(admin.cookie, other.id, 'reactivate'),
      await action(admin.cookie, other.id, 'resend-invite'),
    ]) {
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ code: 'owner_required' });
    }
    expect(row(other.id).full_name).toBe('Test User');
    expect((await patch(boss.cookie, other.id, { fullName: 'Renamed' })).status).toBe(200);
    expect(audits().filter((a) => a.action.startsWith('user.'))).toHaveLength(1);
  });

  it('refuses a non-owner who tries to make someone an owner, grant permissions or promote to super manager', async () => {
    const admin = await manager();
    const sub = await seedUser(app, { role: 'sub_manager' });
    for (const body of [{ role: 'super_manager' }, { role: 'super_manager', permissions: ['audit.read'] }, { role: 'super_manager', isOwner: true }]) {
      const res = await patch(admin.cookie, sub.id, body);
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ code: 'owner_required' });
    }
    expect(row(sub.id).role).toBe('sub_manager');
  });

  it('lets an owner promote an affiliate to super manager with grants, and sets the owner flag', async () => {
    const boss = await owner();
    const aff = await seedAndLogin('affiliate');
    const res = await patch(boss.cookie, aff.id, { role: 'super_manager', permissions: ['audit.read'] });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ role: 'super_manager', isOwner: false, permissions: ['audit.read'] });
    expect((await me(aff.cookie)).status).toBe(401); // role change revokes sessions
    const res2 = await patch(boss.cookie, aff.id, { isOwner: true });
    expect(res2.status).toBe(200);
    expect(row(aff.id).is_owner).toBe(1);
    expect(grantsOf(aff.id)).toEqual([]); // an owner never has grant rows
  });

  it('removes grants when a super manager becomes another role, and demands the owner flag be cleared first', async () => {
    const boss = await owner();
    const sm = await seedUser(app, { role: 'super_manager', permissions: ['audit.read'] });
    const res = await patch(boss.cookie, sm.id, { role: 'sub_manager' });
    expect(res.status).toBe(200);
    expect(grantsOf(sm.id)).toEqual([]);

    const o2 = await seedUser(app, { role: 'super_manager', isOwner: true });
    const blocked = await patch(boss.cookie, o2.id, { role: 'sub_manager' });
    expect(blocked.status).toBe(400);
    expect(Object.keys((await json(blocked)).errors as object)).toEqual(['role']);
    expect(row(o2.id).role).toBe('super_manager');
  });

  it('refuses permissions or the owner flag when the resulting role is not super manager', async () => {
    const boss = await owner();
    const sub = await seedUser(app, { role: 'sub_manager' });
    for (const [body, field] of [[{ permissions: ['audit.read'] }, 'permissions'], [{ isOwner: false }, 'isOwner'], [{ role: 'affiliate', isOwner: true }, 'isOwner']] as [Body, string][]) {
      const res = await patch(boss.cookie, sub.id, body);
      expect(res.status).toBe(400);
      expect(Object.keys((await json(res)).errors as object)).toContain(field);
    }
  });
});

describe('PATCH /api/users/:id', () => {
  it('lets a non-owner edit name and phone of a sub manager without touching sessions, with an audit entry', async () => {
    const admin = await manager();
    const sub = await seedAndLogin('sub_manager');
    const res = await patch(admin.cookie, sub.id, { fullName: 'New Name', phone: '0661 00 00 00' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ fullName: 'New Name', phone: '0661000000' });
    expect((await me(sub.cookie)).status).toBe(200);
    expect(liveSessions(sub.id)).toBe(1);
    const [entry] = auditsFor('user.updated', sub.id);
    expect(JSON.parse(entry?.before ?? '{}')).toMatchObject({ fullName: 'Test User', phone: null });
    expect(JSON.parse(entry?.after ?? '{}')).toMatchObject({ fullName: 'New Name', phone: '0661000000' });
  });

  it('records the reason and writes nothing when nothing changes', async () => {
    const admin = await manager();
    const sub = await seedUser(app, { role: 'sub_manager', fullName: 'Same Name' });
    const before = row(sub.id).updated_at;
    const none = await patch(admin.cookie, sub.id, { fullName: 'Same Name' });
    expect(none.status).toBe(200);
    expect(auditsFor('user.updated')).toHaveLength(0);
    expect(row(sub.id).updated_at).toBe(before);
    await patch(admin.cookie, sub.id, { fullName: 'Other Name', reason: ' typo ' });
    expect(auditsFor('user.updated')[0]?.reason).toBe('typo');
  });

  it('cannot change the email, and rejects invalid input', async () => {
    const admin = await manager();
    const sub = await seedUser(app, { role: 'sub_manager', email: 'keep@example.test' });
    await patch(admin.cookie, sub.id, { email: 'new@example.test', fullName: 'Ok Name' });
    expect(row(sub.id).email).toBe('keep@example.test');
    for (const bad of [{ fullName: 'A' }, { phone: 'abc' }, { role: 'nope' }, { permissions: 'x' }]) {
      const res = await patch(admin.cookie, sub.id, bad);
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('validation');
    }
  });

  it('revokes the target sessions when role, permissions or owner flag change', async () => {
    const boss = await owner();
    const sm = await seedAndLogin('super_manager', { permissions: ['audit.read'] });
    expect((await patch(boss.cookie, sm.id, { permissions: ['audit.read', 'settings.manage'] })).status).toBe(200);
    expect(grantsOf(sm.id)).toEqual(['audit.read', 'settings.manage']);
    expect((await me(sm.cookie)).status).toBe(401);
    expect(liveSessions(sm.id)).toBe(0);

    // a fresh login sees the new grants
    const cookie = await login(app, sm.email, sm.password);
    expect(((await json(await me(cookie))).permissions as string[]).sort()).toEqual(['audit.read', 'settings.manage']);

    // removing all grants revokes again
    expect((await patch(boss.cookie, sm.id, { permissions: [] })).status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
    expect(grantsOf(sm.id)).toEqual([]);
  });

  it('does not revoke sessions when the submitted grants are identical to the stored ones', async () => {
    const boss = await owner();
    const sm = await seedAndLogin('super_manager', { permissions: ['audit.read', 'settings.manage'] });
    expect((await patch(boss.cookie, sm.id, { permissions: ['settings.manage', 'audit.read'], fullName: 'Renamed Sm' })).status).toBe(200);
    expect((await me(sm.cookie)).status).toBe(200);
  });

  it('lets a non-owner change a sub manager into an affiliate, revoking their sessions', async () => {
    const admin = await manager();
    const sub = await seedAndLogin('sub_manager');
    expect((await patch(admin.cookie, sub.id, { role: 'affiliate' })).status).toBe(200);
    expect((await me(sub.cookie)).status).toBe(401);
  });
});

describe('clearing a phone number', () => {
  it.each([[null], ['']])('PATCH phone %j clears it, is audited, and leaves sessions alone', async (value) => {
    const admin = await manager();
    const sub = await seedAndLogin('sub_manager');
    await patch(admin.cookie, sub.id, { phone: '0661 00 00 00' });
    const res = await patch(admin.cookie, sub.id, { phone: value });
    expect(res.status).toBe(200);
    expect((await json(res)).phone).toBeNull();
    expect(row(sub.id).phone).toBeNull();
    expect((await me(sub.cookie)).status).toBe(200);
    const entries = auditsFor('user.updated', sub.id);
    expect(JSON.parse(entries.at(-1)?.before ?? '{}').phone).toBe('0661000000');
    expect(JSON.parse(entries.at(-1)?.after ?? '{}').phone).toBeNull();
  });

  it('clearing an already empty phone is a no-op without an audit row; bad numbers are still refused', async () => {
    const admin = await manager();
    const sub = await seedUser(app, { role: 'sub_manager' });
    expect((await patch(admin.cookie, sub.id, { phone: null })).status).toBe(200);
    expect(auditsFor('user.updated')).toHaveLength(0);
    expect((await patch(admin.cookie, sub.id, { phone: 'abc' })).status).toBe(400);
    expect((await patch(admin.cookie, sub.id, { phone: '   ' })).status).toBe(400);
  });

  it('create still refuses an empty phone', async () => {
    const admin = await manager();
    expect((await create(admin.cookie, { email: 'p@example.test', fullName: 'Pp Pp', role: 'affiliate', phone: null })).status).toBe(400);
  });
});

describe('owner edit bug (the form sent an owner’s effective permissions as grants)', () => {
  it('an owner edits their own name and phone: 200, sessions untouched, no grant rows', async () => {
    const boss = await owner();
    const res = await patch(boss.cookie, boss.id, { fullName: 'Boss Renamed', phone: '0550 11 22 33' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ fullName: 'Boss Renamed', phone: '0550112233', isOwner: true });
    expect((await me(boss.cookie)).status).toBe(200);
    expect(grantsOf(boss.id)).toEqual([]);
  });

  it('an owner who sends the old buggy payload (all 14 effective permissions, role, isOwner) still succeeds and writes no grants', async () => {
    const boss = await owner();
    const res = await patch(boss.cookie, boss.id, { fullName: 'Boss Again', role: 'super_manager', isOwner: true, permissions: [...PERMISSIONS] });
    expect(res.status).toBe(200);
    expect(grantsOf(boss.id)).toEqual([]);
    expect((await me(boss.cookie)).status).toBe(200);
    expect(((await json(res)).permissions as string[]).length).toBe(PERMISSIONS.length);
  });

  it('owner A edits owner B: 200, B’s sessions untouched, no grant rows, even with permissions in the payload', async () => {
    const a = await owner();
    const b = await seedAndLogin('super_manager', { isOwner: true });
    const res = await patch(a.cookie, b.id, { fullName: 'B Renamed', permissions: [...PERMISSIONS], isOwner: true });
    expect(res.status).toBe(200);
    expect(row(b.id).full_name).toBe('B Renamed');
    expect(liveSessions(b.id)).toBe(1);
    expect((await me(b.cookie)).status).toBe(200);
    expect(grantsOf(b.id)).toEqual([]);
    const [entry] = auditsFor('user.updated', b.id);
    expect(JSON.parse(entry?.after ?? '{}').permissions).toEqual([]);
  });

  it('a non-owner with users.manage can edit their own name and phone (but not role or permissions)', async () => {
    const admin = await manager();
    const res = await patch(admin.cookie, admin.id, { fullName: 'Me Renamed', phone: '0770 00 00 01' });
    expect(res.status).toBe(200);
    expect(row(admin.id).full_name).toBe('Me Renamed');
    expect((await me(admin.cookie)).status).toBe(200);
    expect(grantsOf(admin.id)).toEqual(['users.manage']);
    // sending their own current grants back is not a change
    expect((await patch(admin.cookie, admin.id, { fullName: 'Me Again', permissions: ['users.manage'] })).status).toBe(200);
  });

  it('grants for non-owner super managers still work and revoke sessions', async () => {
    const boss = await owner();
    const sm = await seedAndLogin('super_manager', { permissions: [] });
    const res = await patch(boss.cookie, sm.id, { permissions: ['users.manage', 'orders.read'] });
    expect(res.status).toBe(200);
    expect(grantsOf(sm.id)).toEqual(['orders.read', 'users.manage']);
    expect((await me(sm.cookie)).status).toBe(401);
  });

  it('de-flagging an owner with a permission list stores that list as grants', async () => {
    const a = await owner();
    const b = await seedUser(app, { role: 'super_manager', isOwner: true });
    const res = await patch(a.cookie, b.id, { isOwner: false, permissions: ['audit.read'] });
    expect(res.status).toBe(200);
    expect(grantsOf(b.id)).toEqual(['audit.read']);
    expect(row(b.id).is_owner).toBe(0);
  });

  it('promoting to owner clears stale grant rows', async () => {
    const a = await owner();
    const sm = await seedUser(app, { role: 'super_manager', permissions: ['audit.read'] });
    expect((await patch(a.cookie, sm.id, { isOwner: true, permissions: ['audit.read'] })).status).toBe(200);
    expect(grantsOf(sm.id)).toEqual([]);
  });
});

describe('self rules', () => {
  it('forbids changing your own role or permissions', async () => {
    const boss = await owner();
    await seedUser(app, { role: 'super_manager', isOwner: true });
    for (const body of [{ role: 'sub_manager' }, { role: 'sub_manager', isOwner: false }]) {
      const res = await patch(boss.cookie, boss.id, body);
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ code: 'forbidden' });
    }
    expect(row(boss.id).role).toBe('super_manager');
    expect(row(boss.id).is_owner).toBe(1);
    expect((await me(boss.cookie)).status).toBe(200);

    const admin = await manager();
    const own = await patch(admin.cookie, admin.id, { permissions: ['users.manage', 'audit.read'] });
    expect(own.status).toBe(403);
    expect(await json(own)).toEqual({ code: 'forbidden' });
    expect(grantsOf(admin.id)).toEqual(['users.manage']);
    const dropped = await patch(admin.cookie, admin.id, { permissions: [] });
    expect(dropped.status).toBe(403);
  });

  it('refuses to suspend yourself, even as the last owner', async () => {
    const boss = await owner();
    const res = await action(boss.cookie, boss.id, 'suspend');
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ code: 'cannot_suspend_self' });
    expect(row(boss.id).status).toBe('active');
    expect(audits()).toHaveLength(0);
    const admin = await manager();
    expect(await json(await action(admin.cookie, admin.id, 'suspend'))).toEqual({ code: 'cannot_suspend_self' });
  });

  it('lets an owner clear their own flag only while another active owner remains', async () => {
    const a = await owner();
    const b = await seedUser(app, { role: 'super_manager', isOwner: true, status: 'suspended' });
    const blocked = await patch(a.cookie, a.id, { isOwner: false });
    expect(blocked.status).toBe(409);
    expect(await json(blocked)).toEqual({ code: 'last_owner' });
    expect(row(a.id).is_owner).toBe(1);
    expect((await me(a.cookie)).status).toBe(200);

    app.db.run("UPDATE users SET status = 'active' WHERE id = ?", b.id);
    const ok = await patch(a.cookie, a.id, { isOwner: false });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ isOwner: false, role: 'super_manager' });
    expect((await me(a.cookie)).status).toBe(401);
    expect(activeOwnerIds()).toEqual([b.id]);
  });

  it('does not count an invited owner as an active one', async () => {
    const a = await owner();
    await seedUser(app, { role: 'super_manager', isOwner: true, status: 'invited' });
    const res = await patch(a.cookie, a.id, { isOwner: false });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ code: 'last_owner' });
  });
});

describe('re-authorisation inside the transaction (ruling R12)', () => {
  /** Runs `hook` once, right before the handler's first transaction: i.e. after authentication and the access decision. */
  function changeBeforeTransaction(hook: () => void) {
    const real = app.db.transaction.bind(app.db);
    let done = false;
    app.db.transaction = ((fn: never, mode?: 'immediate' | 'deferred') => {
      if (!done) {
        done = true;
        hook();
      }
      return real(fn, mode);
    }) as typeof app.db.transaction;
  }

  it('an owner demoted after authentication cannot complete an owner-only action on a super manager', async () => {
    const boss = await owner();
    const other = await seedUser(app, { role: 'super_manager', isOwner: true }); // keeps the last-owner rule out of the way
    const target = await seedUser(app, { role: 'super_manager', permissions: ['audit.read'] });
    changeBeforeTransaction(() => app.db.run('UPDATE users SET is_owner = 0 WHERE id = ?', boss.id));
    const res = await patch(boss.cookie, target.id, { fullName: 'Hijacked' });
    expect(res.status).toBe(403);
    expect(row(target.id).full_name).toBe('Test User');
    expect(auditsFor('user.updated')).toHaveLength(0);
    expect(other.id).toBeTruthy();
  });

  it('an actor suspended after authentication cannot finish any action', async () => {
    const admin = await manager();
    const target = await seedUser(app, { role: 'affiliate' });
    changeBeforeTransaction(() => app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", admin.id));
    const res = await action(admin.cookie, target.id, 'suspend');
    expect(res.status).toBe(403);
    expect(row(target.id).status).toBe('active');
  });

  it('a manager whose users.manage grant is removed after authentication cannot create users', async () => {
    const admin = await manager();
    changeBeforeTransaction(() => app.db.run('DELETE FROM user_permissions WHERE user_id = ?', admin.id));
    const res = await create(admin.cookie, { email: 'late@example.test', fullName: 'Late Comer', role: 'affiliate' });
    expect(res.status).toBe(403);
    expect(app.db.get("SELECT 1 FROM users WHERE email = 'late@example.test'")).toBeUndefined();
    expect(audits()).toHaveLength(0);
  });

  it('a stale actor id (demoted owner) is refused by every mutation of the service', async () => {
    const { createUser, updateUser, suspendUser, reactivateUser, revokeSessions, resendInvite } = await import('./users');
    const stale = await seedUser(app, { role: 'super_manager', isOwner: true });
    app.db.run('UPDATE users SET is_owner = 0 WHERE id = ?', stale.id); // demoted after "authentication"
    await seedUser(app, { role: 'super_manager', isOwner: true });
    const smTarget = await seedUser(app, { role: 'super_manager', status: 'invited' });
    const deps = { db: app.db, clock: app.clock, config: app.config, mailer: app.mailer };
    const actor = { userId: stale.id, ip: '10.0.0.1', requestId: 'r' };
    const refused = async (run: () => unknown) => {
      let thrown: unknown;
      try {
        await run();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toMatchObject({ status: 403 });
    };
    await refused(() => updateUser(deps, actor, smTarget.id, { fullName: 'Nope' }));
    await refused(() => suspendUser(deps, actor, smTarget.id, {}));
    await refused(() => reactivateUser(deps, actor, smTarget.id, {}));
    await refused(() => revokeSessions(deps, actor, smTarget.id, {}));
    await refused(() => resendInvite(deps, actor, smTarget.id, {}));
    await refused(() => createUser(deps, actor, { email: 'sm2@example.test', fullName: 'Sm Two', role: 'super_manager' }));
    expect(audits()).toHaveLength(0);
  });

  it('an unknown actor id is refused too', async () => {
    const { suspendUser } = await import('./users');
    const target = await seedUser(app, { role: 'affiliate' });
    const deps = { db: app.db, clock: app.clock, config: app.config, mailer: app.mailer };
    expect(() => suspendUser(deps, { userId: '018f0000-0000-7000-8000-000000000000', ip: 'x', requestId: 'r' }, target.id, {})).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe('sessions are revoked on every status change (old cookie then answers 401)', () => {
  it('suspend: 204, no login, existing session dead, audited', async () => {
    const admin = await manager();
    const target = await seedAndLogin('affiliate');
    expect(liveSessions(target.id)).toBe(1);
    const res = await action(admin.cookie, target.id, 'suspend', { reason: 'fraud suspicion' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(row(target.id).status).toBe('suspended');
    expect((await me(target.cookie)).status).toBe(401);
    expect(liveSessions(target.id)).toBe(0);
    const attempt = await app.call('/api/auth/login', { body: { email: target.email, password: target.password } });
    expect(attempt.status).toBe(401);
    const [entry] = auditsFor('user.suspended', target.id);
    expect(entry?.actor_user_id).toBe(admin.id);
    expect(entry?.reason).toBe('fraud suspicion');
    expect(JSON.parse(entry?.before ?? '{}')).toMatchObject({ status: 'active' });
    expect(JSON.parse(entry?.after ?? '{}')).toMatchObject({ status: 'suspended' });
  });

  it('suspends twice with a single audit row', async () => {
    const admin = await manager();
    const target = await seedUser(app, { role: 'affiliate' });
    expect((await action(admin.cookie, target.id, 'suspend')).status).toBe(204);
    expect((await action(admin.cookie, target.id, 'suspend')).status).toBe(204);
    expect(auditsFor('user.suspended')).toHaveLength(1);
  });

  it('accepts a body-less request, an empty object, and refuses an over-long reason', async () => {
    const admin = await manager();
    const t = [await seedUser(app, { role: 'affiliate' }), await seedUser(app, { role: 'affiliate' }), await seedUser(app, { role: 'affiliate' })];
    expect((await action(admin.cookie, t[0]!.id, 'revoke-sessions')).status).toBe(204);
    expect((await action(admin.cookie, t[1]!.id, 'revoke-sessions', {})).status).toBe(204);
    expect((await action(admin.cookie, t[2]!.id, 'revoke-sessions', { reason: 'x'.repeat(501) })).status).toBe(400);
  });

  it('reactivates a suspended user with a password to active, who can log in again', async () => {
    const admin = await manager();
    const target = await seedAndLogin('affiliate');
    await action(admin.cookie, target.id, 'suspend');
    const res = await action(admin.cookie, target.id, 'reactivate');
    expect(res.status).toBe(204);
    expect(row(target.id).status).toBe('active');
    expect((await me(target.cookie)).status).toBe(401); // the old session stays dead
    expect(await login(app, target.email, target.password)).toBeTruthy();
    expect(auditsFor('user.reactivated', target.id)).toHaveLength(1);
  });

  it('returns a never-activated user to invited on reactivation, and resending the invitation works (502 on mail failure, audit kept)', async () => {
    const admin = await manager();
    const created = await json(await create(admin.cookie, { email: 'late@example.test', fullName: 'Late User', role: 'affiliate' }));
    const id = created.id as string;
    await settleBackgroundWork();
    expect((await action(admin.cookie, id, 'suspend')).status).toBe(204);
    expect((await action(admin.cookie, id, 'reactivate')).status).toBe(204);
    expect(row(id).status).toBe('invited');

    app.mailer.sent.length = 0;
    expect((await action(admin.cookie, id, 'resend-invite')).status).toBe(204);
    expect(app.mailer.sent).toHaveLength(1);
    const firstLink = /token=([A-Za-z0-9_-]{43})/.exec(app.mailer.sent[0]?.text ?? '')?.[1];
    expect(auditsFor('user.invite_resent', id)).toHaveLength(1);

    app.mailer.send = async () => {
      throw new Error('boom');
    };
    const failed = await action(admin.cookie, id, 'resend-invite');
    expect(failed.status).toBe(502);
    expect(await json(failed)).toEqual({ code: 'mail_failed' });
    expect(auditsFor('user.invite_resent', id)).toHaveLength(2);
    // the first link was replaced by the second issue (only the newest link is live)
    const old = await app.call('/api/auth/invite/accept', { body: { token: firstLink, password: 'Rose-gloss-2026' } });
    expect(old.status).toBe(400);
  });

  it('refuses to reactivate a user who is not suspended and to resend an invitation to an active one', async () => {
    const admin = await manager();
    const active = await seedUser(app, { role: 'affiliate' });
    const r1 = await action(admin.cookie, active.id, 'reactivate');
    expect(r1.status).toBe(409);
    expect(await json(r1)).toEqual({ code: 'not_suspended' });
    const r2 = await action(admin.cookie, active.id, 'resend-invite');
    expect(r2.status).toBe(409);
    expect(await json(r2)).toEqual({ code: 'not_invited' });
  });

  it('suspends an invited user, and a deactivated user is neither suspended nor reactivated', async () => {
    const admin = await manager();
    const invited = await seedUser(app, { role: 'affiliate', status: 'invited' });
    expect((await action(admin.cookie, invited.id, 'suspend')).status).toBe(204);
    const gone = await seedUser(app, { role: 'affiliate', status: 'deactivated' });
    const s = await action(admin.cookie, gone.id, 'suspend');
    expect(s.status).toBe(409);
    expect(await json(s)).toEqual({ code: 'invalid_status' });
    expect((await action(admin.cookie, gone.id, 'reactivate')).status).toBe(409);
  });

  it('lets an owner suspend, reactivate and revoke sessions of a super manager', async () => {
    const boss = await owner();
    const sm = await seedAndLogin('super_manager', { permissions: ['audit.read'] });
    expect((await action(boss.cookie, sm.id, 'suspend')).status).toBe(204);
    expect((await action(boss.cookie, sm.id, 'reactivate')).status).toBe(204);
    const again = await login(app, sm.email, sm.password);
    expect((await action(boss.cookie, sm.id, 'revoke-sessions')).status).toBe(204);
    expect((await me(again)).status).toBe(401);
  });

  it('revokes every session of the target with revoke-sessions and leaves the actor and others alone', async () => {
    const admin = await manager();
    const target = await seedAndLogin('affiliate');
    const second = await login(app, target.email, target.password);
    const bystander = await seedAndLogin('affiliate');
    expect(liveSessions(target.id)).toBe(2);
    expect((await action(admin.cookie, target.id, 'revoke-sessions', { reason: 'lost phone' })).status).toBe(204);
    expect((await me(target.cookie)).status).toBe(401);
    expect((await me(second)).status).toBe(401);
    expect((await me(bystander.cookie)).status).toBe(200);
    expect((await me(admin.cookie)).status).toBe(200);
    expect(auditsFor('user.sessions_revoked', target.id)[0]?.reason).toBe('lost phone');
    expect(row(target.id).status).toBe('active');
  });
});

describe('GET /api/users', () => {
  function insertUsers(n: number, make: (i: number) => { name: string; email?: string; phone?: string | null; role?: Role; status?: string }) {
    for (let i = 0; i < n; i += 1) {
      const u = make(i);
      app.db.run(
        `INSERT INTO users (id, email, full_name, phone, role, status, created_at, updated_at)
         VALUES (:id, :email, :name, :phone, :role, :status, :at, :at)`,
        { id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`, email: u.email ?? `u${i}@list.test`, name: u.name, phone: u.phone ?? null, role: u.role ?? 'affiliate', status: u.status ?? 'invited', at: 1_000 + i },
      );
    }
  }
  const list = async (cookie: string, query = '') => {
    const res = await get(`/api/users${query}`, cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as { items: { id: string; fullName: string; email: string }[]; total: number };
  };

  it('pages by 50, newest first, and reports the total', async () => {
    const admin = await manager();
    insertUsers(55, (i) => ({ name: `Person ${i}` }));
    const p1 = await list(admin.cookie);
    expect(p1.total).toBe(56);
    expect(p1.items).toHaveLength(50);
    expect(p1.items[0]?.fullName).toBe('Test User'); // the manager, created last (clock is fixed in tests: tie broken by id)
    const p2 = await list(admin.cookie, '?page=2');
    expect(p2.items).toHaveLength(6);
    expect(new Set([...p1.items, ...p2.items].map((u) => u.id)).size).toBe(56);
    expect((await list(admin.cookie, '?page=3')).items).toHaveLength(0);
  });

  it('orders by creation time descending with the id as tie-break', async () => {
    const admin = await manager();
    insertUsers(3, (i) => ({ name: `Ordered ${i}` }));
    const res = await list(admin.cookie, '?q=Ordered');
    expect(res.items.map((u) => u.fullName)).toEqual(['Ordered 2', 'Ordered 1', 'Ordered 0']);
  });

  it('filters by role and status', async () => {
    const admin = await manager();
    insertUsers(4, (i) => ({ name: `F${i}`, role: i % 2 ? 'sub_manager' : 'affiliate', status: i < 2 ? 'suspended' : 'invited' }));
    expect((await list(admin.cookie, '?role=sub_manager')).total).toBe(2);
    expect((await list(admin.cookie, '?status=suspended')).total).toBe(2);
    expect((await list(admin.cookie, '?role=sub_manager&status=suspended')).total).toBe(1);
  });

  it('searches name, email and phone case-insensitively as a substring', async () => {
    const admin = await manager();
    insertUsers(3, (i) => ({ name: ['Amina Haddad', 'Karim Zerrouki', 'Lina Ait'][i]!, email: ['a@list.test', 'k@mail.test', 'l@list.test'][i]!, phone: [null, '0550123456', '0661999888'][i]! }));
    expect((await list(admin.cookie, '?q=HADDAD')).items.map((u) => u.fullName)).toEqual(['Amina Haddad']);
    expect((await list(admin.cookie, '?q=zerr')).total).toBe(1);
    expect((await list(admin.cookie, '?q=MAIL.test')).items.map((u) => u.fullName)).toEqual(['Karim Zerrouki']);
    expect((await list(admin.cookie, '?q=0661')).items.map((u) => u.fullName)).toEqual(['Lina Ait']);
    expect((await list(admin.cookie, '?q=%20%20')).total).toBe(4); // whitespace only = no filter (3 + the manager)
  });

  it('treats %, _ and backslash in the search literally', async () => {
    const admin = await manager();
    insertUsers(4, (i) => ({ name: ['100% Cotton', 'Under_score', 'Back\\slash', 'Plain Name'][i]! }));
    expect((await list(admin.cookie, `?q=${encodeURIComponent('%')}`)).items.map((u) => u.fullName)).toEqual(['100% Cotton']);
    expect((await list(admin.cookie, `?q=${encodeURIComponent('_')}`)).items.map((u) => u.fullName)).toEqual(['Under_score']);
    expect((await list(admin.cookie, `?q=${encodeURIComponent('\\')}`)).items.map((u) => u.fullName)).toEqual(['Back\\slash']);
    expect((await list(admin.cookie, `?q=${encodeURIComponent('P_ain')}`)).total).toBe(0);
    expect((await list(admin.cookie, `?q=${encodeURIComponent("x' OR 1=1 --")}`)).total).toBe(0);
  });

  it('rejects an unknown role, status, a bad page or an over-long search with 400 validation', async () => {
    const admin = await manager();
    for (const q of ['?role=boss', '?status=gone', '?page=0', '?page=abc', '?page=1.5', '?page=1&page=2', `?q=${'x'.repeat(101)}`]) {
      const res = await get(`/api/users${q}`, admin.cookie);
      expect(res.status, q).toBe(400);
      expect((await json(res)).code).toBe('validation');
    }
  });

  it('includes grants only for non-owner super managers and every permission for owners', async () => {
    const boss = await owner();
    await seedUser(app, { role: 'super_manager', permissions: ['audit.read'], fullName: 'Grantee' });
    const res = await list(boss.cookie);
    const all = res.items as unknown as { fullName: string; permissions: string[]; isOwner: boolean }[];
    expect(all.find((u) => u.fullName === 'Grantee')?.permissions).toEqual(['audit.read']);
    expect(all.find((u) => u.isOwner)?.permissions).toHaveLength(PERMISSIONS.length);
  });
});
