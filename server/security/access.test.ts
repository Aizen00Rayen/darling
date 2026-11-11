import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Permission } from '@/shared';
import { login, seedUser, createTestApp, type TestApp } from '../test/app';
import { json, parseBody } from '../http';
import { decide, withAccess, type Access } from './access';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => {
  vi.restoreAllMocks();
  app.close();
});

const PATH = 'http://localhost:3000/api/probe';
const noParams = { params: Promise.resolve({}) };

function request(method: string, cookie?: string, extra: Record<string, string | null> = {}, body?: string) {
  const headers = new Headers({ 'X-Requested-With': 'fetch', Origin: 'http://localhost:3000' });
  if (cookie) headers.set('Cookie', cookie);
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) headers.delete(k);
    else headers.set(k, v);
  }
  return new Request(PATH, { method, headers, body });
}

function probe(access: Access) {
  const handler = vi.fn(async () => json(200, { ok: true }));
  return { handler, route: withAccess(access, handler) };
}

type Principal = 'anonymous' | 'affiliate' | 'sub_manager' | 'sm_none' | 'sm_orders_read' | 'owner' | 'sm_unenrolled';
async function cookieFor(p: Principal): Promise<string | undefined> {
  if (p === 'anonymous') return undefined;
  const make = async () => {
    switch (p) {
      case 'affiliate': return seedUser(app, { role: 'affiliate' });
      case 'sub_manager': return seedUser(app, { role: 'sub_manager' });
      case 'sm_none': return seedUser(app, { role: 'super_manager', totp: true });
      case 'sm_orders_read': return seedUser(app, { role: 'super_manager', totp: true, permissions: ['orders.read'] });
      case 'owner': return seedUser(app, { role: 'super_manager', isOwner: true, totp: true });
      default: return seedUser(app, { role: 'super_manager', permissions: ['orders.read'] }); // no 2FA: must enrol
    }
  };
  const u = await make();
  return login(app, u.email, u.password, u.totpSecret ? { totpCode: (await import('../test/app')).totpCodeAt(u.totpSecret, app.clock.now()) } : {});
}

const ALL: Principal[] = ['anonymous', 'affiliate', 'sub_manager', 'sm_none', 'sm_orders_read', 'owner', 'sm_unenrolled'];
const U = { code: 'unauthenticated' };
const F = { code: 'forbidden' };
const E = { code: '2fa_enrollment_required' };
type Expect = 200 | typeof U | typeof F | typeof E;

const MATRIX: { name: string; access: Access; expected: Record<Principal, Expect> }[] = [
  {
    name: 'public',
    access: { kind: 'public' },
    expected: { anonymous: 200, affiliate: 200, sub_manager: 200, sm_none: 200, sm_orders_read: 200, owner: 200, sm_unenrolled: 200 },
  },
  {
    name: 'authenticated',
    access: { kind: 'authenticated' },
    expected: { anonymous: U, affiliate: 200, sub_manager: 200, sm_none: 200, sm_orders_read: 200, owner: 200, sm_unenrolled: E },
  },
  {
    name: 'authenticated (allowDuring2faEnrollment)',
    access: { kind: 'authenticated', allowDuring2faEnrollment: true },
    expected: { anonymous: U, affiliate: 200, sub_manager: 200, sm_none: 200, sm_orders_read: 200, owner: 200, sm_unenrolled: 200 },
  },
  {
    name: 'role super_manager',
    access: { kind: 'role', roles: ['super_manager'] },
    expected: { anonymous: U, affiliate: F, sub_manager: F, sm_none: 200, sm_orders_read: 200, owner: 200, sm_unenrolled: E },
  },
  {
    name: 'role sub_manager+affiliate',
    access: { kind: 'role', roles: ['sub_manager', 'affiliate'] },
    expected: { anonymous: U, affiliate: 200, sub_manager: 200, sm_none: F, sm_orders_read: F, owner: F, sm_unenrolled: E },
  },
  {
    name: 'permission orders.read',
    access: { kind: 'permission', permission: 'orders.read' },
    expected: { anonymous: U, affiliate: F, sub_manager: F, sm_none: F, sm_orders_read: 200, owner: 200, sm_unenrolled: E },
  },
  {
    name: 'permission users.manage',
    access: { kind: 'permission', permission: 'users.manage' },
    expected: { anonymous: U, affiliate: F, sub_manager: F, sm_none: F, sm_orders_read: F, owner: 200, sm_unenrolled: E },
  },
  {
    name: 'owner',
    access: { kind: 'owner' },
    expected: { anonymous: U, affiliate: F, sub_manager: F, sm_none: F, sm_orders_read: F, owner: 200, sm_unenrolled: E },
  },
];

describe('access matrix: every kind against every principal', () => {
  for (const { name, access, expected } of MATRIX) {
    it.each(ALL)(`${name} / %s`, async (principal) => {
      const { handler, route } = probe(access);
      const res = await route(request('GET', await cookieFor(principal)), noParams);
      const want = expected[principal];
      if (want === 200) {
        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
      } else {
        expect(res.status).toBe(want === U ? 401 : 403);
        expect(await res.json()).toEqual(want);
        expect(handler).not.toHaveBeenCalled();
      }
    });
  }

  it('covers every Access kind', () => {
    expect(new Set(MATRIX.map((m) => m.access.kind))).toEqual(new Set(['public', 'authenticated', 'role', 'permission', 'owner']));
  });
});

describe('decide()', () => {
  const auth = (over: Partial<Parameters<typeof decide>[1] & object> = {}) => ({
    sessionId: 's', userId: 'u', email: 'e', fullName: 'n', role: 'super_manager' as const, isOwner: false,
    permissions: [] as Permission[], twoFactorEnabled: true, mustEnroll2fa: false, ...over,
  });

  it('an unknown access kind fails closed', () => {
    expect(decide({ kind: 'bogus' } as unknown as Access, auth())).toEqual({ status: 403, code: 'forbidden' });
  });

  it('only a super_manager can pass a permission check, even with a stray permission row', () => {
    const access: Access = { kind: 'permission', permission: 'orders.read' };
    expect(decide(access, auth({ role: 'affiliate', permissions: ['orders.read'] }))).toEqual({ status: 403, code: 'forbidden' });
    expect(decide(access, auth({ permissions: ['orders.read'] }))).toBeNull();
  });

  it('owner means an owner who is a super_manager', () => {
    expect(decide({ kind: 'owner' }, auth({ role: 'affiliate', isOwner: true }))).toEqual({ status: 403, code: 'forbidden' });
    expect(decide({ kind: 'owner' }, auth({ isOwner: true }))).toBeNull();
  });
});

describe('enforcement happens before the handler parses anything', () => {
  const schema = z.object({ name: z.string().min(3, 'secret-validation-message') });
  const handler = vi.fn(async ({ request }: { request: Request }) => {
    const body = await parseBody(request, schema);
    if (!body.ok) return body.response;
    return json(200, { ok: true });
  });

  it.each([
    ['anonymous + authenticated', { kind: 'authenticated' } as Access, 'anonymous' as Principal, 401],
    ['affiliate + owner', { kind: 'owner' } as Access, 'affiliate' as Principal, 403],
    ['sub_manager + permission', { kind: 'permission', permission: 'users.manage' } as Access, 'sub_manager' as Principal, 403],
    ['unenrolled SM + role', { kind: 'role', roles: ['super_manager'] } as Access, 'sm_unenrolled' as Principal, 403],
  ])('%s: an invalid body is refused with no field names and the handler never runs', async (_n, access, principal, status) => {
    handler.mockClear();
    const route = withAccess(access, handler);
    const bad = request('POST', await cookieFor(principal), {}, JSON.stringify({ name: 'x' }));
    const res = await route(bad, noParams);
    expect(res.status).toBe(status);
    const text = await res.text();
    expect(text).not.toContain('secret-validation-message');
    expect(text).not.toContain('errors');
    expect(handler).not.toHaveBeenCalled();
    expect(bad.bodyUsed).toBe(false); // the body was never even read
  });

  it('a malformed JSON body from a refused caller is also just 401, not 400', async () => {
    const route = withAccess({ kind: 'authenticated' }, handler);
    const res = await route(request('POST', undefined, {}, '{broken'), noParams);
    expect(res.status).toBe(401);
  });

  it('an authorised caller with an invalid body gets 400 validation with one message per field', async () => {
    const route = withAccess({ kind: 'authenticated' }, handler);
    const u = await seedUser(app, { role: 'affiliate' });
    const res = await route(request('POST', await login(app, u.email, u.password), {}, JSON.stringify({ name: 'x' })), noParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'validation', errors: { name: 'secret-validation-message' } });
  });

  it('a public route still returns the normal 400 for an anonymous caller', async () => {
    const route = withAccess({ kind: 'public' }, handler);
    const res = await route(request('POST', undefined, {}, JSON.stringify({ name: 'x' })), noParams);
    expect(res.status).toBe(400);
  });
});

describe('parseBody', () => {
  const schema = z.object({ a: z.string(), n: z.object({ x: z.number() }) });
  const parse = (raw: string, headers: Record<string, string> = {}) =>
    parseBody(new Request(PATH, { method: 'POST', body: raw, headers }), schema);

  it('returns the data for a valid body', async () => {
    expect(await parse('{"a":"1","n":{"x":2}}')).toEqual({ ok: true, data: { a: '1', n: { x: 2 } } });
  });

  it('reports the first message per field, nested fields with dots, and root problems under _', async () => {
    const r = await parse('{"a":1,"n":{"x":"no"}}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      const body = (await r.response.json()) as { code: string; errors: Record<string, string> };
      expect(body.code).toBe('validation');
      expect(Object.keys(body.errors).sort()).toEqual(['a', 'n.x']);
    }
    const root = await parse('[]');
    if (!root.ok) expect(Object.keys(((await root.response.json()) as { errors: object }).errors)).toEqual(['_']);
  });

  it.each(['', '{', 'null-ish', '<xml/>'])('malformed JSON %j is 400 bad_request', async (raw) => {
    const r = await parse(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      expect(await r.response.json()).toEqual({ code: 'bad_request' });
    }
  });

  it('refuses a body over 64 KiB with 413, by header or by size', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(70_000), n: { x: 1 } });
    for (const headers of [{} as Record<string, string>, { 'content-length': '70000' }]) {
      const r = await parse(big, headers);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(413);
    }
  });

  it('a field that fails is reported with the schema message, not the value', async () => {
    const r = await parseBody(new Request(PATH, { method: 'POST', body: '{"pw":"TopSecret-123"}' }), z.object({ pw: z.string().min(50, 'Trop court.') }));
    if (!r.ok) expect(JSON.stringify(await r.response.json())).not.toContain('TopSecret-123');
  });
});

describe('CSRF', () => {
  const route = () => probe({ kind: 'public' }).route;
  const call = (h: Record<string, string | null>, method = 'POST') => route()(request(method, undefined, h), noParams);

  it('rejects a POST without x-requested-with, without Origin, or with neither, on public and protected routes', async () => {
    for (const access of [{ kind: 'public' }, { kind: 'authenticated' }] as Access[]) {
      const r = withAccess(access, async () => json(200, {}));
      for (const h of [{ 'x-requested-with': null }, { origin: null }, { 'x-requested-with': null, origin: null }] as Record<string, string | null>[]) {
        const res = await r(request('POST', undefined, h), noParams);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ code: 'csrf' });
      }
    }
  });

  it.each([
    ['wrong x-requested-with value', { 'x-requested-with': 'XMLHttpRequest' }],
    ['upper-case value', { 'x-requested-with': 'Fetch' }],
    ['value with extra token', { 'x-requested-with': 'fetch, fetch' }],
    ['foreign origin', { origin: 'https://evil.example' }],
    ['null origin (sandboxed iframe / redirect)', { origin: 'null' }],
    ['origin with trailing slash', { origin: 'http://localhost:3000/' }],
    ['origin with path', { origin: 'http://localhost:3000/x' }],
    ['upper-case host', { origin: 'http://LOCALHOST:3000' }],
    ['other port', { origin: 'http://localhost:3001' }],
    ['other scheme', { origin: 'https://localhost:3000' }],
    ['look-alike suffix', { origin: 'http://localhost:3000.evil.example' }],
    ['look-alike prefix', { origin: 'http://evil.example/http://localhost:3000' }],
    ['empty origin', { origin: '' }],
  ])('rejects %s', async (_n, h) => {
    const res = await call(h);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'csrf' });
  });

  it('rejects duplicate Origin headers (even when one of them is right)', async () => {
    const headers = new Headers({ 'X-Requested-With': 'fetch' });
    headers.append('Origin', 'http://localhost:3000');
    headers.append('Origin', 'http://localhost:3000');
    const res = await route()(new Request(PATH, { method: 'POST', headers }), noParams);
    expect(res.status).toBe(403);
    const mixed = new Headers({ 'X-Requested-With': 'fetch' });
    mixed.append('Origin', 'https://evil.example');
    mixed.append('Origin', 'http://localhost:3000');
    expect((await route()(new Request(PATH, { method: 'POST', headers: mixed }), noParams)).status).toBe(403);
  });

  it('accepts the exact headers, and protects PUT, PATCH and DELETE as well', async () => {
    expect((await call({})).status).toBe(200);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect((await call({ origin: null }, method)).status, method).toBe(403);
      expect((await call({}, method)).status, method).toBe(200);
    }
  });

  it('checks CSRF before access and before any cookie lookup: a forged anonymous POST is csrf, not unauthenticated', async () => {
    const r = withAccess({ kind: 'owner' }, async () => json(200, {}));
    const res = await r(request('POST', undefined, { origin: 'https://evil.example' }), noParams);
    expect(await res.json()).toEqual({ code: 'csrf' });
    const spy = vi.spyOn(app.db, 'get');
    await r(request('POST', 'dl_session=' + 'a'.repeat(43), { 'x-requested-with': null }), noParams);
    expect(spy).not.toHaveBeenCalled();
  });

  it('lets GET, HEAD and OPTIONS through without either header', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await call({ 'x-requested-with': null, origin: null }, method);
      expect(res.status, method).toBe(200);
    }
  });

  it('compares against the configured origin, not a hard-coded one', async () => {
    const local = createTestApp({ config: { appOrigin: 'https://shop.example', cookieSecure: true } });
    try {
      const r = withAccess({ kind: 'public' }, async () => json(200, {}));
      const ok = new Request(PATH, { method: 'POST', headers: { 'X-Requested-With': 'fetch', Origin: 'https://shop.example' } });
      const bad = new Request(PATH, { method: 'POST', headers: { 'X-Requested-With': 'fetch', Origin: 'http://localhost:3000' } });
      expect((await r(ok, noParams)).status).toBe(200);
      expect((await r(bad, noParams)).status).toBe(403);
    } finally {
      local.close();
    }
  });
});

describe('the principal is read from the database on every request', () => {
  const owner = async () => {
    const u = await seedUser(app, { role: 'super_manager', isOwner: true, totp: true });
    const { totpCodeAt } = await import('../test/app');
    return { u, cookie: await login(app, u.email, u.password, { totpCode: totpCodeAt(u.totpSecret as string, app.clock.now()) }) };
  };
  const hit = (access: Access, cookie: string) => probe(access).route(request('GET', cookie), noParams);

  it.each(['invited', 'suspended', 'deactivated'] as const)('a %s user with a live session is anonymous, and the stale cookie is cleared', async (status) => {
    const u = await seedUser(app, { role: 'affiliate' });
    const cookie = await login(app, u.email, u.password);
    app.db.run('UPDATE users SET status = ? WHERE id = ?', status, u.id);
    const res = await hit({ kind: 'authenticated' }, cookie);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()[0]).toMatch(/^dl_session=;.*Max-Age=0/i);
    // reactivating does not matter either way: the session was not revoked, so it works again
    app.db.run("UPDATE users SET status = 'active' WHERE id = ?", u.id);
    expect((await hit({ kind: 'authenticated' }, cookie)).status).toBe(200);
  });

  it('a public route treats a suspended user as anonymous too', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const cookie = await login(app, u.email, u.password);
    app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", u.id);
    let seen: unknown = 'unset';
    await withAccess({ kind: 'public' }, async ({ auth }) => {
      seen = auth;
      return json(200, {});
    })(request('GET', cookie), noParams);
    expect(seen).toBeNull();
  });

  it('removing a permission takes effect at the next request, and so does granting one', async () => {
    const u = await seedUser(app, { role: 'super_manager', totp: true, permissions: ['orders.read'] });
    const { totpCodeAt } = await import('../test/app');
    const cookie = await login(app, u.email, u.password, { totpCode: totpCodeAt(u.totpSecret as string, app.clock.now()) });
    const access: Access = { kind: 'permission', permission: 'orders.read' };
    expect((await hit(access, cookie)).status).toBe(200);
    app.db.run("DELETE FROM user_permissions WHERE user_id = ? AND permission = 'orders.read'", u.id);
    expect((await hit(access, cookie)).status).toBe(403);
    app.db.run("INSERT INTO user_permissions (user_id, permission) VALUES (?, 'orders.read')", u.id);
    expect((await hit(access, cookie)).status).toBe(200);
  });

  it('losing the owner flag or the Super Manager role takes effect at once', async () => {
    const { u, cookie } = await owner();
    expect((await hit({ kind: 'owner' }, cookie)).status).toBe(200);
    app.db.run('UPDATE users SET is_owner = 0 WHERE id = ?', u.id);
    expect((await hit({ kind: 'owner' }, cookie)).status).toBe(403);
    expect((await hit({ kind: 'permission', permission: 'users.manage' }, cookie)).status).toBe(403); // no grants left
    app.db.run("UPDATE users SET role = 'affiliate' WHERE id = ?", u.id);
    expect((await hit({ kind: 'role', roles: ['super_manager'] }, cookie)).status).toBe(403);
  });

  it('a deleted user’s cookie is simply anonymous', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const cookie = await login(app, u.email, u.password);
    app.db.run('DELETE FROM users WHERE id = ?', u.id);
    expect((await hit({ kind: 'authenticated' }, cookie)).status).toBe(401);
  });

  it('follows the 2FA setting and the user’s 2FA state live', async () => {
    const u = await seedUser(app, { role: 'super_manager' });
    const cookie = await login(app, u.email, u.password);
    expect((await hit({ kind: 'authenticated' }, cookie)).status).toBe(403);
    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('security.require_2fa_super_managers', 'false', 1)");
    expect((await hit({ kind: 'authenticated' }, cookie)).status).toBe(200);
    app.db.run("UPDATE settings SET value = '\"false\"'"); // corrupt value: falls back to the safe default (required)
    expect((await hit({ kind: 'authenticated' }, cookie)).status).toBe(403);
    app.db.run("UPDATE settings SET value = 'false'");
    app.db.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', u.id);
    app.db.run("UPDATE settings SET value = 'true'");
    expect((await hit({ kind: 'authenticated' }, cookie)).status).toBe(200);
  });

  it('never asks a sous-manager or an influenceuse to enrol', async () => {
    for (const role of ['sub_manager', 'affiliate'] as const) {
      const u = await seedUser(app, { role });
      expect((await hit({ kind: 'authenticated' }, await login(app, u.email, u.password))).status).toBe(200);
    }
  });

  it('a stale cookie is cleared on the response unless the handler sets its own session cookie', async () => {
    const stale = 'dl_session=' + 'a'.repeat(43);
    const plain = await probe({ kind: 'public' }).route(request('GET', stale), noParams);
    expect(plain.headers.getSetCookie()).toHaveLength(1);
    const own = await withAccess({ kind: 'public' }, async () => json(200, {}, { 'Set-Cookie': 'dl_session=fresh; Path=/' }))(request('GET', stale), noParams);
    expect(own.headers.getSetCookie()).toEqual(['dl_session=fresh; Path=/']);
    const none = await probe({ kind: 'public' }).route(request('GET'), noParams);
    expect(none.headers.getSetCookie()).toEqual([]);
  });
});

describe('handler contract', () => {
  it('passes request, resolved params, auth, ctx and the client address; adds no-store', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const cookie = await login(app, u.email, u.password);
    let received: Record<string, unknown> = {};
    const route = withAccess<{ kind: 'authenticated' }, { id: string }>({ kind: 'authenticated' }, async (args) => {
      received = args as unknown as Record<string, unknown>;
      return new Response('plain', { status: 200 });
    });
    const res = await route(request('GET', cookie, { 'x-forwarded-for': '203.0.113.9' }), { params: Promise.resolve({ id: '42' }) });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(received.params).toEqual({ id: '42' });
    expect(received.ip).toBe('203.0.113.9');
    expect((received.auth as { userId: string }).userId).toBe(u.id);
    expect(received.ctx).toBeTruthy();
    expect(received.request).toBeInstanceOf(Request);
  });

  it('keeps a Cache-Control the handler chose to set', async () => {
    const res = await withAccess({ kind: 'public' }, async () => new Response('x', { headers: { 'Cache-Control': 'private, max-age=5' } }))(request('GET'), noParams);
    expect(res.headers.get('cache-control')).toBe('private, max-age=5');
  });

  it('an unexpected error is 500 internal with no detail, and is logged without body or params', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    const route = withAccess({ kind: 'public' }, async () => {
      throw new Error('boom while handling password=hunter2');
    });
    const res = await route(request('POST', undefined, {}, '{"password":"hunter2-body"}'), { params: Promise.resolve({ token: 'tok-param-123' }) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 'internal' });
    const log = lines.join('');
    expect(log).toContain('boom while handling');
    expect(log).not.toContain('hunter2');
    expect(log).not.toContain('hunter2-body');
    expect(log).not.toContain('tok-param-123');
  });

  it('a failure while resolving the session is a 500 too, never a pass', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(app.db, 'get').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    const { handler, route } = probe({ kind: 'authenticated' });
    const res = await route(request('GET', 'dl_session=' + 'a'.repeat(43)), noParams);
    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });
});
