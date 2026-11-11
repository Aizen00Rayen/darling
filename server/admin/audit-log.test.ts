import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Permission, Role } from '@/shared';
import { createTestApp, login, seedUser, type TestApp } from '../test/app';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
  app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
});
afterEach(() => app.close());

type Query = Record<string, string>;
const qs = (query?: Query) => (query ? `?${new URLSearchParams(query).toString()}` : '');
const get = (url: string, cookie?: string, query?: Query) => app.call(`${url}${qs(query)}`, { cookie });
const json = async (res: Response) => (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function actor(role: Role, extra: { isOwner?: boolean; permissions?: Permission[] } = {}) {
  const user = await seedUser(app, { role, ...extra });
  return { ...user, cookie: await login(app, user.email, user.password) };
}
const reader = () => actor('super_manager', { permissions: ['audit.read'] });

interface AuditInput {
  actorUserId?: string | null;
  action?: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  requestId?: string | null;
  at?: string;
}
function addAudit(rows: AuditInput[]) {
  for (const r of rows) {
    app.db.run(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before, after, reason, ip, request_id, at)
       VALUES (:actor, :action, :type, :id, :before, :after, :reason, :ip, :req, :at)`,
      {
        actor: r.actorUserId ?? null,
        action: r.action ?? 'thing.done',
        type: r.entityType ?? 'probe',
        id: r.entityId ?? 'e-1',
        before: r.before === undefined ? null : JSON.stringify(r.before),
        after: r.after === undefined ? null : JSON.stringify(r.after),
        reason: r.reason ?? null,
        ip: r.ip ?? null,
        req: r.requestId ?? null,
        at: Date.parse(r.at ?? '2026-11-01T00:00:00Z'),
      },
    );
  }
}
interface LoginInput {
  emailTried?: string;
  success?: boolean;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  at?: string;
}
function addLogin(rows: LoginInput[]) {
  for (const r of rows) {
    app.db.run('INSERT INTO login_events (email_tried, ip, user_agent, success, reason, at) VALUES (:e, :ip, :ua, :ok, :reason, :at)', {
      e: r.emailTried ?? 'someone@example.test',
      ip: r.ip ?? null,
      ua: r.userAgent ?? null,
      ok: r.success ?? true,
      reason: r.reason ?? null,
      at: Date.parse(r.at ?? '2026-11-01T00:00:00Z'),
    });
  }
}
const ids = (body: { items: { entityId: string }[] }) => body.items.map((i) => i.entityId);

describe('GET /api/audit-log', () => {
  it('returns entries newest first with the actor, and exactly the documented fields', async () => {
    const me = await reader();
    const who = await seedUser(app, { role: 'super_manager', fullName: 'Who Did It' });
    addAudit([
      { actorUserId: who.id, action: 'user.updated', entityType: 'user', entityId: 'older', before: { role: 'affiliate' }, after: { role: 'sub_manager' }, reason: 'promotion', ip: '203.0.113.9', requestId: 'req-12345678', at: '2026-11-01T10:00:00Z' },
      { entityType: 'user', entityId: 'newer', at: '2026-11-02T10:00:00Z' },
    ]);
    const res = await get('/api/audit-log', me.cookie, { entityType: 'user' });
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    const body = await json(res);
    expect(body.total).toBe(2);
    expect(ids(body)).toEqual(['newer', 'older']);
    expect(body.items[1]).toEqual({
      id: expect.any(Number),
      at: '2026-11-01T10:00:00.000Z',
      actor: { id: who.id, fullName: 'Who Did It' },
      action: 'user.updated',
      entityType: 'user',
      entityId: 'older',
      before: { role: 'affiliate' },
      after: { role: 'sub_manager' },
      reason: 'promotion',
    });
    // Neither the address nor the request id is part of the log's public shape.
    expect(text).not.toContain('203.0.113.9');
    expect(text).not.toContain('req-12345678');
    expect(body.items[0]).toMatchObject({ actor: null, before: null, after: null, reason: null });
  });

  it('breaks ties on the same instant by id, newest first', async () => {
    const me = await reader();
    addAudit([{ entityId: 'first' }, { entityId: 'second' }, { entityId: 'third' }]);
    expect(ids(await json(await get('/api/audit-log', me.cookie, { entityType: 'probe' })))).toEqual(['third', 'second', 'first']);
  });

  it('gives actor null when the actor id matches no user', async () => {
    const me = await reader();
    addAudit([{ entityId: 'ghost', actorUserId: '0190e3a0-0000-7000-8000-000000000000' }]);
    const body = await json(await get('/api/audit-log', me.cookie, { entityType: 'probe' }));
    expect(body.items).toHaveLength(1);
    expect(body.items[0].actor).toBeNull();
  });

  it('filters by entity type (exact, trimmed) and by actor', async () => {
    const me = await reader();
    const a = await seedUser(app, { role: 'super_manager' });
    const b = await seedUser(app, { role: 'super_manager' });
    addAudit([
      { entityType: 'user', entityId: 'a-user', actorUserId: a.id },
      { entityType: 'setting', entityId: 'a-setting', actorUserId: a.id },
      { entityType: 'user', entityId: 'b-user', actorUserId: b.id },
      { entityType: 'users', entityId: 'plural', actorUserId: b.id },
    ]);
    const byType = await json(await get('/api/audit-log', me.cookie, { entityType: ' user ' }));
    expect(ids(byType).sort()).toEqual(['a-user', 'b-user']);
    expect(byType.total).toBe(2);
    expect(ids(await json(await get('/api/audit-log', me.cookie, { actorId: a.id }))).sort()).toEqual(['a-setting', 'a-user']);
    const both = await json(await get('/api/audit-log', me.cookie, { actorId: b.id, entityType: 'user' }));
    expect(ids(both)).toEqual(['b-user']);
    expect(both.total).toBe(1);
  });

  it('treats LIKE wildcards in the entity type literally (exact match only)', async () => {
    const me = await reader();
    addAudit([{ entityType: 'user', entityId: 'x' }]);
    expect((await json(await get('/api/audit-log', me.cookie, { entityType: 'us%' }))).total).toBe(0);
    expect((await json(await get('/api/audit-log', me.cookie, { entityType: 'u_er' }))).total).toBe(0);
  });

  it('reads dates as Algiers calendar days (UTC+1) with inclusive bounds', async () => {
    const me = await reader();
    addAudit([
      { entityId: 'before-day', at: '2026-11-09T22:59:59Z' },
      { entityId: 'first-minute', at: '2026-11-09T23:00:00Z' },
      { entityId: 'half-past-midnight', at: '2026-11-09T23:30:00Z' },
      { entityId: 'last-second', at: '2026-11-10T22:59:59Z' },
      { entityId: 'next-day', at: '2026-11-10T23:00:00Z' },
    ]);
    const q = async (extra: Query) => json(await get('/api/audit-log', me.cookie, { entityType: 'probe', ...extra }));
    const day = await q({ from: '2026-11-10', to: '2026-11-10' });
    expect(ids(day)).toEqual(['last-second', 'half-past-midnight', 'first-minute']);
    expect(day.total).toBe(3);
    expect(ids(await q({ from: '2026-11-10' }))).toEqual(['next-day', 'last-second', 'half-past-midnight', 'first-minute']);
    expect(ids(await q({ to: '2026-11-10' }))).toEqual(['last-second', 'half-past-midnight', 'first-minute', 'before-day']);
  });

  it('pages by 50 and reports the total', async () => {
    const me = await reader();
    addAudit(Array.from({ length: 60 }, (_, i) => ({ entityType: 'bulk', entityId: `row-${String(i).padStart(2, '0')}`, at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() })));
    const page1 = await json(await get('/api/audit-log', me.cookie, { entityType: 'bulk' }));
    expect(page1.items).toHaveLength(50);
    expect(page1.total).toBe(60);
    expect(page1.items[0].entityId).toBe('row-59');
    const page2 = await json(await get('/api/audit-log', me.cookie, { entityType: 'bulk', page: '2' }));
    expect(page2.items).toHaveLength(10);
    expect(page2.items[0].entityId).toBe('row-09');
    expect(page2.items[9].entityId).toBe('row-00');
    expect(await json(await get('/api/audit-log', me.cookie, { entityType: 'bulk', page: '3' }))).toEqual({ items: [], total: 60 });
  });

  it('returns before and after exactly as stored (parsed once from the JSON text)', async () => {
    const me = await reader();
    const cases: [string, unknown, unknown][] = [
      ['object', { a: 1, nested: { b: [1, 'two', null] } }, { c: true }],
      ['array', [1, 2, { x: 'y' }], []],
      ['string-false', 'false', 'true'],
      ['string-number', '2026', '42'],
      ['string-null', 'null', '{"json":"text"}'],
      ['number', 42, 0],
      ['boolean', false, true],
      ['empty-string', '', 'text'],
    ];
    addAudit(cases.map(([entityId, before, after], i) => ({ entityId, before, after, at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() })));
    const body = await json(await get('/api/audit-log', me.cookie, { entityType: 'probe' }));
    for (const [entityId, before, after] of cases) {
      const item = body.items.find((i: { entityId: string }) => i.entityId === entityId);
      expect(item.before, `${entityId} before`).toStrictEqual(before);
      expect(item.after, `${entityId} after`).toStrictEqual(after);
    }
  });

  it('shows the entries the user management writes', async () => {
    const me = await actor('super_manager', { isOwner: true });
    await app.call('/api/users', { cookie: me.cookie, body: { email: 'new@example.test', fullName: 'New Person', role: 'affiliate' } });
    const body = await json(await get('/api/audit-log', me.cookie, { entityType: 'user' }));
    expect(body.items[0]).toMatchObject({ action: 'user.created', actor: { id: me.id } });
  });

  it.each([
    ['from=2026-02-30', { from: '2026-02-30' }],
    ['from in the wrong format', { from: '10/11/2026' }],
    ['to with a time', { to: '2026-11-10T00:00:00Z' }],
    ['to=2026-13-01', { to: '2026-13-01' }],
    ['from after to', { from: '2026-11-11', to: '2026-11-10' }],
    ['page=0', { page: '0' }],
    ['page=-1', { page: '-1' }],
    ['page=abc', { page: 'abc' }],
    ['page=1.5', { page: '1.5' }],
    ['page above 10000', { page: '10001' }],
    ['actorId not a uuid', { actorId: 'not-a-uuid' }],
    ['empty entityType', { entityType: '   ' }],
  ] as [string, Query][])('rejects %s with 400 validation', async (_name, query) => {
    const me = await reader();
    const res = await get('/api/audit-log', me.cookie, query);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('validation');
    expect(Object.keys(body.errors).length).toBeGreaterThan(0);
  });

  it('rejects a repeated parameter', async () => {
    const me = await reader();
    expect((await app.call('/api/audit-log?page=1&page=2', { cookie: me.cookie })).status).toBe(400);
  });

  it('accepts from equal to to, page 10000, and leap days; names the offending field', async () => {
    const me = await reader();
    expect((await get('/api/audit-log', me.cookie, { from: '2026-11-10', to: '2026-11-10' })).status).toBe(200);
    expect((await get('/api/audit-log', me.cookie, { page: '10000' })).status).toBe(200);
    expect((await get('/api/audit-log', me.cookie, { from: '2028-02-29' })).status).toBe(200);
    expect((await get('/api/audit-log', me.cookie, { from: '2026-02-29' })).status).toBe(400);
    expect(Object.keys((await json(await get('/api/audit-log', me.cookie, { from: '2026-02-30' }))).errors)).toEqual(['from']);
    expect(Object.keys((await json(await get('/api/audit-log', me.cookie, { from: '2026-11-11', to: '2026-11-10' }))).errors)).toEqual(['to']);
  });
});

describe('GET /api/login-events', () => {
  it('returns the documented fields only (no user agent), newest first', async () => {
    const me = await reader();
    addLogin([
      { emailTried: 'old@example.test', ip: '203.0.113.7', userAgent: 'Mozilla/secret-agent', success: false, reason: 'bad_password', at: '2026-11-01T08:00:00Z' },
      { emailTried: 'new@example.test', ip: null, reason: 'ok', at: '2026-11-02T08:00:00Z' },
    ]);
    const res = await get('/api/login-events', me.cookie, { email: 'old@example.test' });
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    expect(await json(res)).toEqual({
      items: [{ id: expect.any(Number), at: '2026-11-01T08:00:00.000Z', email: 'old@example.test', success: false, reason: 'bad_password', ip: '203.0.113.7' }],
      total: 1,
    });
    for (const secret of ['secret-agent', 'user_agent', 'userAgent']) expect(text).not.toContain(secret);
    expect((await json(await get('/api/login-events', me.cookie, { email: 'new@example.test' }))).items[0]).toMatchObject({ ip: null, success: true, reason: 'ok' });
  });

  it('filters by normalised email, success and Algiers dates', async () => {
    const me = await reader();
    addLogin([
      { emailTried: 'a@example.test', success: true, reason: 'ok', ip: '1.1.1.1', at: '2026-11-09T23:30:00Z' },
      { emailTried: 'a@example.test', success: false, reason: 'bad_password', ip: '1.1.1.1', at: '2026-11-10T22:59:59Z' },
      { emailTried: 'a@example.test', success: false, reason: 'bad_password', ip: '1.1.1.1', at: '2026-11-10T23:00:00Z' },
      { emailTried: 'b@example.test', success: false, reason: 'unknown_email', ip: '2.2.2.2', at: '2026-11-10T10:00:00Z' },
      { emailTried: 'ab@example.test', success: true, reason: 'ok', ip: '3.3.3.3', at: '2026-11-10T11:00:00Z' },
    ]);
    const list = async (query: Query) => json(await get('/api/login-events', me.cookie, query));
    const byEmail = await list({ email: '  A@Example.TEST ' });
    expect(byEmail.total).toBe(3); // trimmed and lower-cased like at login; exact, not a prefix
    expect((await list({ success: 'false', from: '2026-11-01' })).total).toBe(3);
    expect((await list({ success: 'true', from: '2026-11-01' })).total).toBe(2);
    const day = await list({ from: '2026-11-10', to: '2026-11-10' });
    expect(day.total).toBe(4);
    expect(day.items.map((i: { at: string }) => i.at)).toEqual(['2026-11-10T22:59:59.000Z', '2026-11-10T11:00:00.000Z', '2026-11-10T10:00:00.000Z', '2026-11-09T23:30:00.000Z']);
    const combined = await list({ email: 'a@example.test', success: 'false', from: '2026-11-10', to: '2026-11-10' });
    expect(combined.total).toBe(1);
    expect(combined.items[0].reason).toBe('bad_password');
  });

  it('pages by 50', async () => {
    const me = await reader();
    addLogin(Array.from({ length: 55 }, (_, i) => ({ emailTried: 'bulk@example.test', at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() })));
    const one = await json(await get('/api/login-events', me.cookie, { email: 'bulk@example.test' }));
    expect(one.items).toHaveLength(50);
    expect(one.total).toBe(55);
    expect((await json(await get('/api/login-events', me.cookie, { email: 'bulk@example.test', page: '2' }))).items).toHaveLength(5);
  });

  it('includes the logins made through the API', async () => {
    const me = await reader();
    const res = await json(await get('/api/login-events', me.cookie, { email: me.email }));
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.items[0]).toMatchObject({ email: me.email, success: true, reason: 'ok' });
  });

  it.each([
    ['from=2026-02-30', { from: '2026-02-30' }],
    ['from after to', { from: '2026-11-11', to: '2026-11-10' }],
    ['success=yes', { success: 'yes' }],
    ['success=1', { success: '1' }],
    ['email not an address', { email: 'nobody' }],
    ['page=0', { page: '0' }],
    ['page=-3', { page: '-3' }],
    ['page=x', { page: 'x' }],
    ['page above 10000', { page: '10001' }],
  ] as [string, Query][])('rejects %s with 400 validation', async (_name, query) => {
    const me = await reader();
    const res = await get('/api/login-events', me.cookie, query);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('validation');
    expect(Object.keys(body.errors).length).toBeGreaterThan(0);
  });
});

describe.each(['/api/audit-log', '/api/login-events'])('access to %s', (url) => {
  it('refuses anonymous callers with 401', async () => {
    const res = await get(url);
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ code: 'unauthenticated' });
  });

  it.each<[string, () => Promise<{ cookie: string }>]>([
    ['an affiliate', () => actor('affiliate')],
    ['a sous-manager', () => actor('sub_manager')],
    ['a super manager without audit.read', () => actor('super_manager', { permissions: ['users.manage', 'settings.manage'] })],
  ])('refuses %s with 403 and no data', async (_who, make) => {
    const me = await make();
    const res = await get(url, me.cookie);
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ code: 'forbidden' });
  });

  it('serves a super manager with audit.read and the owner', async () => {
    expect((await get(url, (await reader()).cookie)).status).toBe(200);
    expect((await get(url, (await actor('super_manager', { isOwner: true })).cookie)).status).toBe(200);
  });

  it('is read-only', async () => {
    const me = await reader();
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect((await app.call(url, { method, cookie: me.cookie, body: {} })).status).toBe(405);
    }
  });
});
