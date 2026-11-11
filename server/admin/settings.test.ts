import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS, type Permission, type Role } from '@/shared';
import { createTestApp, login, seedUser, totpCodeAt, type TestApp } from '../test/app';
import { getSetting } from '../settings';
import { updateSetting } from './settings';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => app.close());

const json = async (res: Response) => (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (cookie?: string) => app.call('/api/settings', { cookie });
const patch = (cookie: string | undefined, key: string, body: unknown) => app.call(`/api/settings/${key}`, { method: 'PATCH', cookie, body: body as object });

async function actor(role: Role, extra: { isOwner?: boolean; permissions?: Permission[]; totp?: boolean } = {}) {
  const user = await seedUser(app, { role, ...extra });
  const totpCode = user.totpSecret ? totpCodeAt(user.totpSecret, app.clock.now()) : undefined;
  return { ...user, cookie: await login(app, user.email, user.password, { totpCode }) };
}
// Super managers sign in with an authenticator while the 2FA requirement is on (the default).
const owner = () => actor('super_manager', { isOwner: true, totp: true });
const settingsManager = () => actor('super_manager', { permissions: ['settings.manage'], totp: true });
const stored = (key: string) => app.db.get<{ value: string; updated_by: string | null }>('SELECT value, updated_by FROM settings WHERE key = ?', key);
const settingAudits = () =>
  app.db
    .all<{ actor_user_id: string; entity_id: string; before: string; after: string; ip: string | null }>("SELECT * FROM audit_log WHERE action = 'setting.updated' ORDER BY id")
    .map((a) => ({ ...a, before: JSON.parse(a.before) as unknown, after: JSON.parse(a.after) as unknown }));

describe('GET /api/settings', () => {
  it('returns every key of the registry with its default when nothing is stored', async () => {
    const me = await owner();
    const res = await get(me.cookie);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual(SETTING_DEFAULTS);
  });

  it('overlays stored values on the defaults, and a corrupt value falls back to the default (never to "off")', async () => {
    const me = await owner();
    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('company.name', '\"Maison Rose\"', 1)");
    expect(await json(await get(me.cookie))).toEqual({ ...SETTING_DEFAULTS, 'company.name': 'Maison Rose' });
    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', '\"false\"', 1)");
    expect((await json(await get(me.cookie)))['security.require_2fa_super_managers']).toBe(true);
  });

  it('returns a stored string that looks like another JSON type as a string', async () => {
    const me = await owner();
    for (const text of ['false', '2026', 'null']) {
      app.db.run('DELETE FROM settings');
      app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('company.name', ?, 1)", JSON.stringify(text));
      expect((await json(await get(me.cookie)))['company.name']).toBe(text);
    }
  });
});

describe('PATCH /api/settings/:key', () => {
  it('rejects a value of the wrong type with 400 validation and changes nothing', async () => {
    const me = await owner();
    const res = await patch(me.cookie, 'security.require_2fa_super_managers', { value: 'yes' });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('validation');
    expect(body.errors.value.length).toBeGreaterThan(0);
    expect(stored('security.require_2fa_super_managers')).toBeUndefined();
    expect(settingAudits()).toHaveLength(0);
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
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('validation');
    expect(body.errors.value).toBeTruthy();
  });

  it('rejects a body that is not a JSON object with 400', async () => {
    const me = await owner();
    expect((await patch(me.cookie, 'company.name', [1])).status).toBe(400);
    expect((await app.call('/api/settings/company.name', { method: 'PATCH', cookie: me.cookie, rawBody: '{nope' })).status).toBe(400);
  });

  it('turns the 2FA requirement off and on: 200, audit rows, updated_by, and /me stops asking to enrol', async () => {
    const me = await owner();
    const sm = await seedUser(app, { role: 'super_manager', permissions: ['audit.read'] });
    const smCookie = await login(app, sm.email, sm.password);
    expect((await json(await app.call('/api/auth/me', { cookie: smCookie }))).mustEnroll2fa).toBe(true);

    const off = await patch(me.cookie, 'security.require_2fa_super_managers', { value: false });
    expect(off.status).toBe(200);
    expect(await json(off)).toEqual({ key: 'security.require_2fa_super_managers', value: false });
    expect(stored('security.require_2fa_super_managers')).toMatchObject({ value: 'false', updated_by: me.id });
    expect((await json(await app.call('/api/auth/me', { cookie: smCookie }))).mustEnroll2fa).toBe(false);
    expect((await app.call('/api/audit-log', { cookie: me.cookie })).status).toBe(200);

    expect((await patch(me.cookie, 'security.require_2fa_super_managers', { value: true })).status).toBe(200);
    expect((await json(await app.call('/api/auth/me', { cookie: smCookie }))).mustEnroll2fa).toBe(true);
    const audits = settingAudits();
    expect(audits.map((a) => [a.before, a.after])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(audits[0]).toMatchObject({ actor_user_id: me.id, entity_id: 'security.require_2fa_super_managers' });
  });

  it('records the effective old value, default included', async () => {
    const me = await owner();
    await patch(me.cookie, 'company.name', { value: 'First' });
    await patch(me.cookie, 'company.name', { value: 'Second' });
    expect(settingAudits().map((a) => [a.before, a.after])).toEqual([
      ['DARLING*', 'First'],
      ['First', 'Second'],
    ]);
  });

  it('stores a string that looks like a number or a boolean as a string, and returns it as one', async () => {
    const me = await owner();
    for (const text of ['false', '2026', 'null', '{"a":1}']) {
      const res = await patch(me.cookie, 'company.name', { value: text });
      expect(res.status).toBe(200);
      expect((await json(res)).value).toBe(text);
      expect(stored('company.name')?.value).toBe(JSON.stringify(text));
      expect((await json(await get(me.cookie)))['company.name']).toBe(text);
    }
  });

  it('stores the value after the registry schema has trimmed it', async () => {
    const me = await owner();
    const res = await patch(me.cookie, 'company.name', { value: '  Maison Rose  ' });
    expect((await json(res)).value).toBe('Maison Rose');
    expect(stored('company.name')?.value).toBe('"Maison Rose"');
  });

  it('answers 404 for an unknown key, including names that exist on every object', async () => {
    const me = await owner();
    for (const key of ['no.such.key', 'constructor', '__proto__', 'toString']) {
      const res = await patch(me.cookie, key, { value: true });
      expect(res.status, key).toBe(404);
      expect(await json(res), key).toEqual({ code: 'not_found' });
    }
    expect(app.db.all('SELECT * FROM settings')).toHaveLength(0);
    expect(settingAudits()).toHaveLength(0);
  });

  it('commits the setting and its audit row together: a failing audit insert leaves the setting unchanged', async () => {
    const me = await owner();
    expect((await patch(me.cookie, 'company.name', { value: 'Before' })).status).toBe(200);
    const real = app.db.transaction.bind(app.db);
    app.db.transaction = ((fn: (tx: typeof app.db) => unknown, mode?: 'immediate' | 'deferred') =>
      real((tx) => {
        const run = tx.run.bind(tx);
        tx.run = ((sql: string, ...p: never[]) => {
          if (/INSERT INTO audit_log/i.test(sql)) throw new Error('audit insert refused');
          return run(sql, ...p);
        }) as typeof tx.run;
        return fn(tx);
      }, mode)) as typeof app.db.transaction;

    const res = await patch(me.cookie, 'company.name', { value: 'After' });
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ code: 'internal' });
    expect(stored('company.name')?.value).toBe('"Before"');
    // The same holds for a first write: no row is left behind without its audit entry.
    expect((await patch(me.cookie, 'security.require_2fa_super_managers', { value: false })).status).toBe(500);
    expect(stored('security.require_2fa_super_managers')).toBeUndefined();
  });

  it('re-checks the caller inside the transaction, not only from the request-start snapshot', async () => {
    const me = await settingsManager();
    const stale = { userId: me.id, ip: '203.0.113.1', requestId: 'req-12345678' };
    const deps = { db: app.db, clock: app.clock };
    const refused = (value: string) => () => updateSetting(deps, stale, 'company.name', value);

    app.db.run('DELETE FROM user_permissions WHERE user_id = ?', me.id); // the grant is gone by the time the write runs
    expect(refused('Nope')).toThrow(expect.objectContaining({ status: 403 }));
    app.db.run("INSERT INTO user_permissions (user_id, permission) VALUES (?, 'settings.manage')", me.id);
    expect(updateSetting(deps, stale, 'company.name', 'Fine')).toEqual({ key: 'company.name', value: 'Fine' });
    app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", me.id);
    expect(refused('Nope')).toThrow(expect.objectContaining({ status: 403 }));
    app.db.run("UPDATE users SET status = 'active', role = 'sub_manager' WHERE id = ?", me.id);
    expect(refused('Nope')).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => updateSetting(deps, { ...stale, userId: '0190e3a0-0000-7000-8000-000000000000' }, 'company.name', 'Nope')).toThrow(expect.objectContaining({ status: 403 }));
    expect(getSetting(app.db, 'company.name')).toBe('Fine');
  });

  it('a request whose caller loses settings.manage between authentication and the write is refused (403)', async () => {
    const me = await settingsManager();
    const real = app.db.transaction.bind(app.db);
    let done = false;
    app.db.transaction = ((fn: never, mode?: 'immediate' | 'deferred') => {
      if (!done) {
        done = true;
        app.db.run('DELETE FROM user_permissions WHERE user_id = ?', me.id);
      }
      return real(fn, mode);
    }) as typeof app.db.transaction;
    const res = await patch(me.cookie, 'company.name', { value: 'Nope' });
    expect(res.status).toBe(403);
    expect(stored('company.name')).toBeUndefined();
  });

  it('serialises concurrent updates so each audit row sees the value it replaced', async () => {
    app.close();
    app = createTestApp({ file: true, connections: 3 });
    const me = await owner();
    const results = await Promise.all(['One', 'Two', 'Three', 'Four'].map((value) => patch(me.cookie, 'company.name', { value })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const audits = settingAudits();
    expect(audits).toHaveLength(4);
    expect(audits[0]?.before).toBe('DARLING*');
    for (let i = 1; i < audits.length; i += 1) expect(audits[i]?.before).toBe(audits[i - 1]?.after);
    expect(stored('company.name')?.value).toBe(JSON.stringify(audits[3]?.after));
  });
});

describe.each([
  ['GET', '/api/settings'],
  ['PATCH', '/api/settings/company.name'],
] as const)('access to %s %s', (method, url) => {
  const send = (cookie?: string) => app.call(url, { method, cookie, ...(method === 'PATCH' ? { body: { value: 'Allowed' } } : {}) });

  it('refuses anonymous callers with 401', async () => {
    const res = await send();
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ code: 'unauthenticated' });
  });

  it.each<[string, () => Promise<{ cookie: string }>]>([
    ['an affiliate', () => actor('affiliate')],
    ['a sous-manager', () => actor('sub_manager')],
    ['a super manager without settings.manage', () => actor('super_manager', { permissions: ['audit.read', 'users.manage'], totp: true })],
  ])('refuses %s with 403', async (_who, make) => {
    const me = await make();
    const res = await send(me.cookie);
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ code: 'forbidden' });
    expect(stored('company.name')).toBeUndefined();
  });

  it('serves a super manager with settings.manage and the owner', async () => {
    expect((await send((await settingsManager()).cookie)).status).toBe(200);
    expect((await send((await owner()).cookie)).status).toBe(200);
  });
});
