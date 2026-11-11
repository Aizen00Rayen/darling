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
// Influenceuses and sous-managers must have a phone: tests that do not care about it get a default one.
const create = (cookie: string | undefined, body: Body) =>
  call('POST', '/api/users', { cookie, body: body.role === 'affiliate' || body.role === 'sub_manager' ? { phone: '0550123456', ...body } : body });
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
    const res = await patch(boss.cookie, sm.id, { role: 'sub_manager', phone: '0550123456' });
    expect(res.status).toBe(200);
    expect(grantsOf(sm.id)).toEqual([]);

    const o2 = await seedUser(app, { role: 'super_manager', isOwner: true });
    const blocked = await patch(boss.cookie, o2.id, { role: 'sub_manager', phone: '0550123456' });
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
    expect(JSON.parse(entry?.before ?? '{}')).toMatchObject({ fullName: 'Test User', phone: '0550000000' });
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
  it.each([[null], ['']])('PATCH phone %j clears it on a super manager, is audited, and leaves sessions alone', async (value) => {
    const boss = await owner();
    const target = await seedAndLogin('super_manager');
    await patch(boss.cookie, target.id, { phone: '0661 00 00 00' });
    const res = await patch(boss.cookie, target.id, { phone: value });
    expect(res.status).toBe(200);
    expect((await json(res)).phone).toBeNull();
    expect(row(target.id).phone).toBeNull();
    expect((await me(target.cookie)).status).toBe(200);
    const entries = auditsFor('user.updated', target.id);
    expect(JSON.parse(entries.at(-1)?.before ?? '{}').phone).toBe('0661000000');
    expect(JSON.parse(entries.at(-1)?.after ?? '{}').phone).toBeNull();
  });

  it('clearing an already empty phone is a no-op without an audit row; bad numbers are still refused', async () => {
    const boss = await owner();
    const target = await seedUser(app, { role: 'super_manager' });
    expect((await patch(boss.cookie, target.id, { phone: null })).status).toBe(200);
    expect(auditsFor('user.updated')).toHaveLength(0);
    expect((await patch(boss.cookie, target.id, { phone: 'abc' })).status).toBe(400);
    expect((await patch(boss.cookie, target.id, { phone: '   ' })).status).toBe(400);
  });

  it('create still refuses an empty phone', async () => {
    const admin = await manager();
    expect((await create(admin.cookie, { email: 'p@example.test', fullName: 'Pp Pp', role: 'affiliate', phone: null })).status).toBe(400);
  });
});

describe('a phone is required for influenceuses and sous-managers', () => {
  const MESSAGE = 'Téléphone obligatoire pour ce rôle.';
  it.each(['affiliate', 'sub_manager'] as const)('create %s without a phone: 400 validation on phone, nothing created', async (role) => {
    const admin = await manager();
    for (const body of [{ email: 'np@example.test', fullName: 'No Phone', role }, { email: 'np@example.test', fullName: 'No Phone', role, phone: null }, { email: 'np@example.test', fullName: 'No Phone', role, phone: '' }]) {
      const res = await call('POST', '/api/users', { cookie: admin.cookie, body: body as Body });
      expect(res.status).toBe(400);
      expect(((await json(res)).errors as Record<string, string>).phone).toBe(MESSAGE);
    }
    expect(app.db.get("SELECT 1 FROM users WHERE email = 'np@example.test'")).toBeUndefined();
    expect(app.db.get('SELECT count(*) AS n FROM affiliate_profiles')).toEqual({ n: 0 });
  });

  it('a super manager needs no phone', async () => {
    const boss = await owner();
    expect((await create(boss.cookie, { email: 'sm@example.test', fullName: 'Super Manager', role: 'super_manager' })).status).toBe(201);
  });

  it.each(['affiliate', 'sub_manager'] as const)('cannot clear the phone of a %s (null or empty), nothing changes', async (role) => {
    const admin = await manager();
    const target = await seedUser(app, { role, phone: '0550123456' });
    for (const phone of [null, '']) {
      const res = await patch(admin.cookie, target.id, { phone });
      expect(res.status).toBe(400);
      expect(((await json(res)).errors as Record<string, string>).phone).toBe(MESSAGE);
    }
    expect(row(target.id).phone).toBe('0550123456');
    expect(auditsFor('user.updated', target.id)).toHaveLength(0);
  });

  it('a role change to influenceuse or sous-manager needs a phone on file or in the same request', async () => {
    const boss = await owner();
    const target = await seedUser(app, { role: 'super_manager' });
    const refused = await patch(boss.cookie, target.id, { role: 'sub_manager' });
    expect([refused.status, ((await json(refused)).errors as Record<string, string>).phone]).toEqual([400, MESSAGE]);
    expect(row(target.id).role).toBe('super_manager');
    const ok = await patch(boss.cookie, target.id, { role: 'affiliate', phone: '0661 00 00 00' });
    expect(ok.status).toBe(200);
    expect(row(target.id)).toMatchObject({ role: 'affiliate', phone: '0661000000' });
    // an influenceuse who already has a phone keeps it through a role change without resending it
    const t2 = await seedUser(app, { role: 'sub_manager', phone: '0550999888' });
    expect((await patch(boss.cookie, t2.id, { role: 'affiliate' })).status).toBe(200);
  });

  it('editing the name of a legacy influenceuse WITHOUT a phone is refused until a phone is added', async () => {
    const admin = await manager();
    const legacy = await seedUser(app, { role: 'affiliate', phone: null });
    expect((await patch(admin.cookie, legacy.id, { fullName: 'Legacy Name' })).status).toBe(400);
    expect((await patch(admin.cookie, legacy.id, { fullName: 'Legacy Name', phone: '0550 11 22 33' })).status).toBe(200);
  });
});
