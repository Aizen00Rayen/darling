import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Permission, Role } from '@darling/shared';
import { auditLog, loginEvents, settings } from '../../db/schema';
import {
  createTestContext,
  csrfHeaders,
  freshAddress,
  login,
  seedUser,
  type TestContext,
} from '../../../test/context';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  // Super managers in these tests have no authenticator; do not make them enrol first.
  await ctx.db.insert(settings).values({ key: 'security.require_2fa_super_managers', value: false });
});
afterEach(async () => {
  await ctx.close();
});

type Query = Record<string, string | string[]>;

function get(url: string, cookie?: string, query?: Query) {
  return ctx.app.inject({
    method: 'GET',
    url,
    headers: { ...csrfHeaders(ctx), ...(cookie ? { cookie } : {}) },
    remoteAddress: freshAddress(),
    ...(query ? { query } : {}),
  });
}

async function actor(role: Role, extra: { isOwner?: boolean; permissions?: Permission[] } = {}) {
  const user = await seedUser(ctx, { role, ...extra });
  return { ...user, cookie: await login(ctx, user.email, user.password) };
}
const reader = () => actor('super_manager', { permissions: ['audit.read'] });

type AuditInput = Partial<typeof auditLog.$inferInsert>;
async function addAudit(rows: AuditInput[]) {
  await ctx.db.insert(auditLog).values(
    rows.map((r) => ({
      action: 'thing.done',
      entityType: 'probe',
      entityId: 'e-1',
      ...r,
    })),
  );
}

type LoginInput = Partial<typeof loginEvents.$inferInsert>;
async function addLogin(rows: LoginInput[]) {
  await ctx.db.insert(loginEvents).values(
    rows.map((r) => ({ emailTried: 'someone@example.test', success: true, ...r })),
  );
}

const ids = (body: { items: { entityId: string }[] }) => body.items.map((i) => i.entityId);

describe('GET /api/audit-log', () => {
  it('returns entries newest first with the actor, and exactly the documented fields', async () => {
    const me = await reader();
    const who = await seedUser(ctx, { role: 'super_manager' });
    await addAudit([
      {
        actorUserId: who.id,
        action: 'user.updated',
        entityType: 'user',
        entityId: 'older',
        before: { role: 'affiliate' },
        after: { role: 'sub_manager' },
        reason: 'promotion',
        ip: '203.0.113.9',
        requestId: 'req-12345678',
        at: new Date('2026-11-01T10:00:00Z'),
      },
      { entityType: 'user', entityId: 'newer', at: new Date('2026-11-02T10:00:00Z') },
    ]);

    const res = await get('/api/audit-log', me.cookie, { entityType: 'user' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(ids(body)).toEqual(['newer', 'older']);
    expect(body.items[1]).toEqual({
      id: expect.any(Number),
      at: '2026-11-01T10:00:00.000Z',
      actor: { id: who.id, fullName: 'Test User' },
      action: 'user.updated',
      entityType: 'user',
      entityId: 'older',
      before: { role: 'affiliate' },
      after: { role: 'sub_manager' },
      reason: 'promotion',
    });
    // Neither the address nor the request id is part of the log's public shape.
    expect(res.body).not.toContain('203.0.113.9');
    expect(res.body).not.toContain('req-12345678');
    expect(body.items[0]).toMatchObject({ actor: null, before: null, after: null, reason: null });
  });

  it('breaks ties on the same instant by id, newest first', async () => {
    const me = await reader();
    const at = new Date('2026-11-01T10:00:00Z');
    await addAudit([
      { entityId: 'first', at },
      { entityId: 'second', at },
      { entityId: 'third', at },
    ]);
    const body = (await get('/api/audit-log', me.cookie, { entityType: 'probe' })).json();
    expect(ids(body)).toEqual(['third', 'second', 'first']);
  });

  it('gives actor null when the actor id matches no user', async () => {
    const me = await reader();
    await addAudit([{ entityId: 'ghost', actorUserId: '0190e3a0-0000-7000-8000-000000000000' }]);
    const body = (await get('/api/audit-log', me.cookie, { entityType: 'probe' })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].actor).toBeNull();
  });

  it('filters by entity type (exact, trimmed) and by actor', async () => {
    const me = await reader();
    const a = await seedUser(ctx, { role: 'super_manager' });
    const b = await seedUser(ctx, { role: 'super_manager' });
    await addAudit([
      { entityType: 'user', entityId: 'a-user', actorUserId: a.id },
      { entityType: 'setting', entityId: 'a-setting', actorUserId: a.id },
      { entityType: 'user', entityId: 'b-user', actorUserId: b.id },
      { entityType: 'users', entityId: 'plural', actorUserId: b.id },
    ]);

    const byType = (await get('/api/audit-log', me.cookie, { entityType: ' user ' })).json();
    expect(ids(byType).sort()).toEqual(['a-user', 'b-user']);
    expect(byType.total).toBe(2);

    const byActor = (await get('/api/audit-log', me.cookie, { actorId: a.id })).json();
    expect(ids(byActor).sort()).toEqual(['a-setting', 'a-user']);

    const both = (await get('/api/audit-log', me.cookie, { actorId: b.id, entityType: 'user' })).json();
    expect(ids(both)).toEqual(['b-user']);
    expect(both.total).toBe(1);
  });

  it('reads dates as Algiers calendar days (UTC+1) with inclusive bounds', async () => {
    const me = await reader();
    await addAudit([
      { entityId: 'before-day', at: new Date('2026-11-09T22:59:59Z') },
      { entityId: 'first-minute', at: new Date('2026-11-09T23:00:00Z') },
      { entityId: 'half-past-midnight', at: new Date('2026-11-09T23:30:00Z') },
      { entityId: 'last-second', at: new Date('2026-11-10T22:59:59Z') },
      { entityId: 'next-day', at: new Date('2026-11-10T23:00:00Z') },
    ]);
    const q = (extra: Query) => get('/api/audit-log', me.cookie, { entityType: 'probe', ...extra });

    const day = (await q({ from: '2026-11-10', to: '2026-11-10' })).json();
    expect(ids(day)).toEqual(['last-second', 'half-past-midnight', 'first-minute']);
    expect(day.total).toBe(3);

    expect(ids((await q({ from: '2026-11-10' })).json())).toEqual([
      'next-day',
      'last-second',
      'half-past-midnight',
      'first-minute',
    ]);
    expect(ids((await q({ to: '2026-11-10' })).json())).toEqual([
      'last-second',
      'half-past-midnight',
      'first-minute',
      'before-day',
    ]);
  });

  it('pages by 50 and reports the total', async () => {
    const me = await reader();
    await addAudit(
      Array.from({ length: 60 }, (_, i) => ({
        entityType: 'bulk',
        entityId: `row-${String(i).padStart(2, '0')}`,
        at: new Date(Date.UTC(2026, 10, 1, 0, i)),
      })),
    );
    const page1 = (await get('/api/audit-log', me.cookie, { entityType: 'bulk' })).json();
    expect(page1.items).toHaveLength(50);
    expect(page1.total).toBe(60);
    expect(page1.items[0].entityId).toBe('row-59');
    const page2 = (await get('/api/audit-log', me.cookie, { entityType: 'bulk', page: '2' })).json();
    expect(page2.items).toHaveLength(10);
    expect(page2.total).toBe(60);
    expect(page2.items[0].entityId).toBe('row-09');
    expect(page2.items[9].entityId).toBe('row-00');
    const page3 = (await get('/api/audit-log', me.cookie, { entityType: 'bulk', page: '3' })).json();
    expect(page3).toEqual({ items: [], total: 60 });
  });

  it('returns before and after exactly as stored (jsonb is not decoded twice)', async () => {
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
    await addAudit(
      cases.map(([entityId, before, after], i) => ({
        entityId,
        before,
        after,
        at: new Date(Date.UTC(2026, 10, 1, 0, i)),
      })),
    );
    const body = (await get('/api/audit-log', me.cookie, { entityType: 'probe' })).json();
    for (const [entityId, before, after] of cases) {
      const item = body.items.find((i: { entityId: string }) => i.entityId === entityId);
      expect(item.before, `${entityId} before`).toStrictEqual(before);
      expect(item.after, `${entityId} after`).toStrictEqual(after);
    }
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
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('validation');
    expect(Object.keys(body.errors).length).toBeGreaterThan(0);
  });

  it('accepts from equal to to, and page 10000', async () => {
    const me = await reader();
    expect((await get('/api/audit-log', me.cookie, { from: '2026-11-10', to: '2026-11-10' })).statusCode).toBe(200);
    expect((await get('/api/audit-log', me.cookie, { page: '10000' })).statusCode).toBe(200);
  });

  it('names the offending field in the errors', async () => {
    const me = await reader();
    const bad = (await get('/api/audit-log', me.cookie, { from: '2026-02-30' })).json();
    expect(Object.keys(bad.errors)).toEqual(['from']);
    const order = (await get('/api/audit-log', me.cookie, { from: '2026-11-11', to: '2026-11-10' })).json();
    expect(Object.keys(order.errors)).toEqual(['to']);
  });
});

describe('GET /api/login-events', () => {
  it('returns the documented fields only (no user agent), newest first', async () => {
    const me = await reader();
    await addLogin([
      {
        emailTried: 'old@example.test',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/secret-agent',
        success: false,
        reason: 'bad_password',
        at: new Date('2026-11-01T08:00:00Z'),
      },
      { emailTried: 'new@example.test', ip: null, reason: 'ok', at: new Date('2026-11-02T08:00:00Z') },
    ]);
    const res = await get('/api/login-events', me.cookie, { email: 'old@example.test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          id: expect.any(Number),
          at: '2026-11-01T08:00:00.000Z',
          email: 'old@example.test',
          success: false,
          reason: 'bad_password',
          ip: '203.0.113.7',
        },
      ],
      total: 1,
    });
    expect(res.body).not.toContain('secret-agent');
    expect(res.body).not.toContain('user_agent');
    expect(res.body).not.toContain('userAgent');

    const all = (await get('/api/login-events', me.cookie, { email: 'new@example.test' })).json();
    expect(all.items[0]).toMatchObject({ ip: null, success: true, reason: 'ok' });
  });

  it('filters by normalised email, success and Algiers dates', async () => {
    const me = await reader();
    await addLogin([
      { emailTried: 'a@example.test', success: true, reason: 'ok', ip: '1.1.1.1', at: new Date('2026-11-09T23:30:00Z') },
      { emailTried: 'a@example.test', success: false, reason: 'bad_password', ip: '1.1.1.1', at: new Date('2026-11-10T22:59:59Z') },
      { emailTried: 'a@example.test', success: false, reason: 'bad_password', ip: '1.1.1.1', at: new Date('2026-11-10T23:00:00Z') },
      { emailTried: 'b@example.test', success: false, reason: 'unknown_user', ip: '2.2.2.2', at: new Date('2026-11-10T10:00:00Z') },
      { emailTried: 'ab@example.test', success: true, reason: 'ok', ip: '3.3.3.3', at: new Date('2026-11-10T11:00:00Z') },
    ]);
    const list = async (query: Query) => (await get('/api/login-events', me.cookie, query)).json();

    // The address is trimmed and lower-cased like at login; the match is exact (not a prefix).
    const byEmail = await list({ email: '  A@Example.TEST ' });
    expect(byEmail.total).toBe(3);
    expect(byEmail.items.map((i: { ip: string }) => i.ip)).toEqual(['1.1.1.1', '1.1.1.1', '1.1.1.1']);

    const failures = await list({ success: 'false', from: '2026-11-01' });
    expect(failures.total).toBe(3);
    expect(failures.items.every((i: { success: boolean }) => i.success === false)).toBe(true);
    const successes = await list({ success: 'true', from: '2026-11-01' });
    expect(successes.total).toBe(2);

    const day = await list({ from: '2026-11-10', to: '2026-11-10' });
    expect(day.total).toBe(4);
    expect(day.items.map((i: { at: string }) => i.at)).toEqual([
      '2026-11-10T22:59:59.000Z',
      '2026-11-10T11:00:00.000Z',
      '2026-11-10T10:00:00.000Z',
      '2026-11-09T23:30:00.000Z',
    ]);

    const combined = await list({ email: 'a@example.test', success: 'false', from: '2026-11-10', to: '2026-11-10' });
    expect(combined.total).toBe(1);
    expect(combined.items[0].reason).toBe('bad_password');
  });

  it('pages by 50', async () => {
    const me = await reader();
    await addLogin(
      Array.from({ length: 55 }, (_, i) => ({
        emailTried: 'bulk@example.test',
        at: new Date(Date.UTC(2026, 10, 1, 0, i)),
      })),
    );
    const one = (await get('/api/login-events', me.cookie, { email: 'bulk@example.test' })).json();
    expect(one.items).toHaveLength(50);
    expect(one.total).toBe(55);
    const two = (await get('/api/login-events', me.cookie, { email: 'bulk@example.test', page: '2' })).json();
    expect(two.items).toHaveLength(5);
    expect(two.total).toBe(55);
  });

  it('includes the logins made through the API', async () => {
    const me = await reader();
    const res = (await get('/api/login-events', me.cookie, { email: me.email })).json();
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
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation');
    expect(Object.keys(res.json().errors).length).toBeGreaterThan(0);
  });
});

describe.each(['/api/audit-log', '/api/login-events'])('access to %s', (url) => {
  it('refuses anonymous callers with 401', async () => {
    const res = await get(url);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated' });
  });

  it.each<[string, () => Promise<{ cookie: string }>]>([
    ['an affiliate', () => actor('affiliate')],
    ['a sous-manager', () => actor('sub_manager')],
    ['a super manager without audit.read', () => actor('super_manager', { permissions: ['users.manage', 'settings.manage'] })],
  ])('refuses %s with 403 and no data', async (_who, make) => {
    const me = await make();
    const res = await get(url, me.cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'forbidden' });
  });

  it('serves a super manager with audit.read', async () => {
    const me = await reader();
    expect((await get(url, me.cookie)).statusCode).toBe(200);
  });

  it('serves the owner', async () => {
    const me = await actor('super_manager', { isOwner: true });
    expect((await get(url, me.cookie)).statusCode).toBe(200);
  });
});
