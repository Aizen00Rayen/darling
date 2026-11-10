import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS, SETTINGS, type Permission, type Role } from '@darling/shared';
import { auditLog, settings } from '../../db/schema';
import {
  connectAsOwner,
  createTestContext,
  csrfHeaders,
  freshAddress,
  login,
  seedUser,
  totpCodeAt,
  type TestContext,
} from '../../../test/context';
import { updateSetting } from './service';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

function call(method: 'GET' | 'PATCH', url: string, cookie?: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    headers: { ...csrfHeaders(ctx), ...(cookie ? { cookie } : {}) },
    remoteAddress: freshAddress(),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}
const getAll = (cookie?: string) => call('GET', '/api/settings', cookie);
const patch = (cookie: string | undefined, key: string, payload: unknown) =>
  call('PATCH', `/api/settings/${key}`, cookie, payload);

type Actor = { id: string; email: string; cookie: string };

/** Seeds and signs in a user; Super Managers get an authenticator so the 2FA requirement never gets in the way. */
async function actor(role: Role, extra: { isOwner?: boolean; permissions?: Permission[]; totp?: boolean } = {}): Promise<Actor> {
  const totp = extra.totp ?? role === 'super_manager';
  const user = await seedUser(ctx, { role, ...extra, totp });
  const code = user.totpSecret ? totpCodeAt(user.totpSecret, ctx.clock.now) : undefined;
  return { id: user.id, email: user.email, cookie: await login(ctx, user.email, user.password, code) };
}
const owner = () => actor('super_manager', { isOwner: true });
const settingsManager = () => actor('super_manager', { permissions: ['settings.manage'] });

async function storedText(key: string): Promise<string | undefined> {
  const [row] = await ctx.db
    .select({ json: sql<string>`${settings.value}::text` })
    .from(settings)
    .where(eq(settings.key, key));
  return row?.json;
}

/** Audit rows for `setting.updated`, oldest first, with before/after parsed once from their JSON text. */
async function settingAudits() {
  const rows = await ctx.db
    .select({
      id: auditLog.id,
      actorUserId: auditLog.actorUserId,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      before: sql<string | null>`${auditLog.before}::text`,
      after: sql<string | null>`${auditLog.after}::text`,
      ip: auditLog.ip,
      requestId: auditLog.requestId,
    })
    .from(auditLog)
    .where(eq(auditLog.action, 'setting.updated'))
    .orderBy(auditLog.id);
  return rows.map((r) => ({
    ...r,
    before: r.before === null ? null : (JSON.parse(r.before) as unknown),
    after: r.after === null ? null : (JSON.parse(r.after) as unknown),
  }));
}

describe('GET /api/settings', () => {
  it('returns every key of the registry with its default when nothing is stored', async () => {
    const me = await settingsManager();
    const res = await getAll(me.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SETTING_DEFAULTS);
    expect(Object.keys(res.json()).sort()).toEqual(Object.keys(SETTINGS).sort());
  });

  it('overlays stored values on the defaults', async () => {
    const me = await settingsManager();
    await ctx.db.insert(settings).values({ key: 'company.name', value: 'Maison Rose' });
    expect((await getAll(me.cookie)).json()).toEqual({ ...SETTING_DEFAULTS, 'company.name': 'Maison Rose' });
  });

  it('returns a stored string that looks like another JSON type as a string', async () => {
    const me = await settingsManager();
    await ctx.db.insert(settings).values({ key: 'company.name', value: '2026' });
    expect((await getAll(me.cookie)).json()['company.name']).toBe('2026');
  });
});

describe('PATCH /api/settings/:key', () => {
  it('rejects a value of the wrong type with 400 validation and changes nothing', async () => {
    const me = await owner();
    const res = await patch(me.cookie, 'security.require_2fa_super_managers', { value: 'yes' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('validation');
    expect(typeof body.errors.value).toBe('string');
    expect(body.errors.value.length).toBeGreaterThan(0);
    expect(await storedText('security.require_2fa_super_managers')).toBeUndefined();
    expect(await settingAudits()).toHaveLength(0);
  });

  it.each([
    ['security.require_2fa_super_managers', { value: null }],
    ['security.require_2fa_super_managers', {}],
    ['security.require_2fa_super_managers', { value: 0 }],
    ['company.name', { value: '   ' }],
    ['company.name', { value: 'x'.repeat(101) }],
    ['company.name', { value: 12 }],
    ['company.name', { value: false }],
  ])('rejects %s %j', async (key, payload) => {
    const me = await owner();
    const res = await patch(me.cookie, key, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation');
    expect(res.json().errors.value).toBeTruthy();
  });

  it('turns the 2FA requirement off: 200, audit row, updated_by, and /me stops asking to enrol', async () => {
    const me = await owner();
    // A Super Manager without an authenticator is told to enrol while the requirement is on.
    const manager = await actor('super_manager', { totp: false });
    const before = await call('GET', '/api/auth/me', manager.cookie);
    expect(before.json().mustEnroll2fa).toBe(true);

    ctx.clock.now = new Date('2026-01-01T05:06:07.000Z');
    const res = await patch(me.cookie, 'security.require_2fa_super_managers', { value: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ key: 'security.require_2fa_super_managers', value: false });

    const [row] = await ctx.db.select().from(settings).where(eq(settings.key, 'security.require_2fa_super_managers'));
    expect(row?.updatedBy).toBe(me.id);
    expect(row?.updatedAt.toISOString()).toBe('2026-01-01T05:06:07.000Z');
    expect(await storedText('security.require_2fa_super_managers')).toBe('false');

    const audits = await settingAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: me.id,
      entityType: 'setting',
      entityId: 'security.require_2fa_super_managers',
      before: true,
      after: false,
      ip: expect.any(String),
      requestId: expect.any(String),
    });
    expect(audits[0]?.requestId).toBe(res.headers['x-request-id']);

    const after = await call('GET', '/api/auth/me', manager.cookie);
    expect(after.json().mustEnroll2fa).toBe(false);
    expect((await getAll(me.cookie)).json()['security.require_2fa_super_managers']).toBe(false);
  });

  it('records the effective old value, default included, and the stored one afterwards', async () => {
    const me = await owner();
    await patch(me.cookie, 'company.name', { value: 'Maison Rose' });
    await patch(me.cookie, 'company.name', { value: 'Maison Rose 2' });
    const audits = await settingAudits();
    expect(audits.map((a) => [a.before, a.after])).toEqual([
      ['DARLING*', 'Maison Rose'],
      ['Maison Rose', 'Maison Rose 2'],
    ]);
  });

  it('stores a string that looks like a number or a boolean as a string, and returns it as one', async () => {
    const me = await owner();
    for (const text of ['2026', 'false', 'null', 'true']) {
      const res = await patch(me.cookie, 'company.name', { value: text });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ key: 'company.name', value: text });
      expect(await storedText('company.name')).toBe(JSON.stringify(text));
      expect((await getAll(me.cookie)).json()['company.name']).toBe(text);
    }
    // The audit trail keeps them as strings too.
    const audits = await settingAudits();
    expect(audits.map((a) => a.after)).toEqual(['2026', 'false', 'null', 'true']);
    expect(audits.map((a) => a.before)).toEqual(['DARLING*', '2026', 'false', 'null']);
  });

  it('stores the value after the registry schema has trimmed it', async () => {
    const me = await owner();
    const res = await patch(me.cookie, 'company.name', { value: '  Maison Rose  ' });
    expect(res.json()).toEqual({ key: 'company.name', value: 'Maison Rose' });
    expect(await storedText('company.name')).toBe('"Maison Rose"');
  });

  it('answers 404 for an unknown key, including names that exist on every object', async () => {
    const me = await owner();
    for (const key of ['no.such.key', 'constructor', '__proto__', 'toString']) {
      const res = await patch(me.cookie, key, { value: true });
      expect(res.statusCode, key).toBe(404);
      expect(res.json(), key).toEqual({ code: 'not_found' });
    }
    expect(await ctx.db.select().from(settings)).toHaveLength(0);
    expect(await settingAudits()).toHaveLength(0);
  });

  it('commits the setting and its audit row together: a failing audit insert leaves the setting unchanged', async () => {
    const me = await owner();
    expect((await patch(me.cookie, 'company.name', { value: 'Before' })).statusCode).toBe(200);

    const admin = await connectAsOwner(ctx.databaseName);
    try {
      await admin.query(`
        create function fail_setting_audit_fn() returns trigger language plpgsql as $$
        begin raise exception 'audit insert refused'; end $$;`);
      await admin.query(`
        create trigger fail_setting_audit before insert on audit_log
        for each row when (new.action = 'setting.updated') execute function fail_setting_audit_fn();`);
    } catch (err) {
      await admin.end();
      throw err;
    }

    try {
      const res = await patch(me.cookie, 'company.name', { value: 'After' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ code: 'internal' });
      expect(await storedText('company.name')).toBe('"Before"');

      // The same holds for a first write: no row is left behind without its audit entry.
      const first = await patch(me.cookie, 'security.require_2fa_super_managers', { value: false });
      expect(first.statusCode).toBe(500);
      expect(await storedText('security.require_2fa_super_managers')).toBeUndefined();
    } finally {
      await admin.end();
    }
  });

  it('re-checks the caller inside the transaction, not only from the request-start snapshot', async () => {
    const me = await settingsManager();
    const stale = { userId: me.id, ip: '203.0.113.1', requestId: 'req-12345678' };
    const deps = { db: ctx.db, clock: ctx.clock };

    // The grant is gone by the time the write runs.
    await ctx.db.execute(sql`delete from user_permissions where user_id = ${me.id}`);
    await expect(updateSetting(deps, stale, 'company.name', 'Nope')).rejects.toMatchObject({ statusCode: 403 });

    // A suspended user is refused even with the grant back.
    await ctx.db.execute(sql`insert into user_permissions (user_id, permission) values (${me.id}, 'settings.manage')`);
    await expect(updateSetting(deps, stale, 'company.name', 'Fine')).resolves.toEqual({ key: 'company.name', value: 'Fine' });
    await ctx.db.execute(sql`update users set status = 'suspended' where id = ${me.id}`);
    await expect(updateSetting(deps, stale, 'company.name', 'Nope')).rejects.toMatchObject({ statusCode: 403 });

    // An unknown actor is refused too.
    const ghost = { ...stale, userId: '0190e3a0-0000-7000-8000-000000000000' };
    await expect(updateSetting(deps, ghost, 'company.name', 'Nope')).rejects.toMatchObject({ statusCode: 403 });
    expect(await storedText('company.name')).toBe('"Fine"');
  });

  it('serialises concurrent updates so each audit row sees the value it replaced', async () => {
    const me = await owner();
    const values = ['One', 'Two', 'Three', 'Four'];
    const results = await Promise.all(values.map((value) => patch(me.cookie, 'company.name', { value })));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    const audits = await settingAudits();
    expect(audits).toHaveLength(4);
    // A chain: every "before" is the previous "after", starting from the default.
    expect(audits[0]?.before).toBe('DARLING*');
    for (let i = 1; i < audits.length; i += 1) expect(audits[i]?.before).toBe(audits[i - 1]?.after);
    expect(await storedText('company.name')).toBe(JSON.stringify(audits[3]?.after));
  });
});

describe.each([
  ['GET', '/api/settings'],
  ['PATCH', '/api/settings/company.name'],
] as const)('access to %s %s', (method, url) => {
  const send = (cookie?: string) => call(method, url, cookie, method === 'PATCH' ? { value: 'Allowed' } : undefined);

  it('refuses anonymous callers with 401', async () => {
    const res = await send();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated' });
  });

  it.each<[string, () => Promise<Actor>]>([
    ['an affiliate', () => actor('affiliate')],
    ['a sous-manager', () => actor('sub_manager')],
    ['a super manager without settings.manage', () => actor('super_manager', { permissions: ['audit.read', 'users.manage'] })],
  ])('refuses %s with 403', async (_who, make) => {
    const me = await make();
    const res = await send(me.cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'forbidden' });
    expect(await storedText('company.name')).toBeUndefined();
  });

  it('serves a super manager with settings.manage and the owner', async () => {
    expect((await send((await settingsManager()).cookie)).statusCode).toBe(200);
    expect((await send((await owner()).cookie)).statusCode).toBe(200);
  });
});
