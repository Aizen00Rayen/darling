import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, accessFor, callApi, dispatchApi, matchRoute, type Method } from './api-registry';
import { createTestApp, login, seedUser, type TestApp } from './test/app';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => app.close());

describe('matchRoute', () => {
  it('matches static paths, ignoring the query string and a trailing slash', () => {
    expect(matchRoute('/api/health')?.route.pattern).toBe('/api/health');
    expect(matchRoute('/api/health/')?.route.pattern).toBe('/api/health');
    expect(matchRoute('/api/auth/login')?.route.pattern).toBe('/api/auth/login');
  });

  it('extracts :param segments and decodes them', () => {
    expect(matchRoute('/api/auth/invite/abc_DEF-123')?.params).toEqual({ token: 'abc_DEF-123' });
    expect(matchRoute('/api/auth/invite/a%20b')?.params).toEqual({ token: 'a b' });
  });

  it('does not let a param swallow slashes, and static routes win over params', () => {
    expect(matchRoute('/api/auth/invite/a/b')).toBeNull();
    expect(matchRoute('/api/auth/invite/accept')?.route.pattern).toBe('/api/auth/invite/accept');
  });

  it('returns null for unknown paths and malformed escapes', () => {
    expect(matchRoute('/api/nope')).toBeNull();
    expect(matchRoute('/api/auth/invite/%E0%A4%A')).toBeNull();
    expect(matchRoute('/other')).toBeNull();
    expect(matchRoute('')).toBeNull();
  });
});

describe('registry', () => {
  it('has unique patterns, each starting with /api/, and an access rule for every entry', () => {
    const patterns = ROUTES.map((r) => r.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
    for (const r of ROUTES) {
      expect(r.pattern.startsWith('/api/')).toBe(true);
      const methods = Object.keys(r.methods) as Method[];
      expect(methods.length).toBeGreaterThan(0);
      // every registered method has a rule (its own, or the route's single one)
      for (const m of methods) expect(accessFor(r, m)?.kind, `${m} ${r.pattern}`).toMatch(/^(public|authenticated|role|permission|owner)$/);
      // per-method rules cover exactly the registered methods
      if (!('kind' in r.access)) expect(Object.keys(r.access).sort()).toEqual([...methods].sort());
    }
  });

  it('knows that /api/orders has a public POST and a permissioned GET', () => {
    const entry = ROUTES.find((r) => r.pattern === '/api/orders')!;
    expect(accessFor(entry, 'POST')).toEqual({ kind: 'public' });
    expect(accessFor(entry, 'GET')).toEqual({ kind: 'permission', permission: 'orders.read' });
    expect(accessFor(entry, 'DELETE')).toBeUndefined();
  });

  it('resolves the order routes, the static manual path winning over :id', () => {
    expect(matchRoute('/api/orders/manual')?.route.pattern).toBe('/api/orders/manual');
    expect(matchRoute('/api/orders/018f0000-0000-7000-8000-000000000000')?.route.pattern).toBe('/api/orders/:id');
    expect(matchRoute('/api/orders/018f0000-0000-7000-8000-000000000000/status')?.params).toEqual({ id: '018f0000-0000-7000-8000-000000000000' });
  });
});

describe('dispatchApi', () => {
  it('answers 404 not_found for an unknown route and 405 with Allow for a known path and a wrong method', async () => {
    const unknown = await dispatchApi(new Request('http://localhost:3000/api/nope'));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ code: 'not_found' });
    const wrong = await dispatchApi(new Request('http://localhost:3000/api/auth/login', { method: 'GET' }));
    expect(wrong.status).toBe(405);
    expect(await wrong.json()).toEqual({ code: 'method_not_allowed' });
    expect(wrong.headers.get('allow')).toBe('POST');
  });

  it('runs the handler with the real access rules (CSRF applies)', async () => {
    const res = await dispatchApi(new Request('http://localhost:3000/api/auth/login', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'csrf' });
  });
});

describe('callApi', () => {
  it('invokes a public handler in-process', async () => {
    const res = await callApi('/api/health', {}, { cookieHeader: '' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: 'up' });
  });

  it('adds the app Origin and X-Requested-With so a POST passes CSRF, and sends JSON bodies', async () => {
    const res = await callApi('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.test', password: 'Whatever-123' } }, { cookieHeader: '' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'invalid_credentials' });
  });

  it('forwards the cookie header', async () => {
    const u = await seedUser(app, { role: 'sub_manager' });
    const cookie = await login(app, u.email, u.password);
    const res = await callApi('/api/auth/me', {}, { cookieHeader: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: u.id });
    expect((await callApi('/api/auth/me', {}, { cookieHeader: '' })).status).toBe(401);
  });

  it('supports :param segments and query strings', async () => {
    expect((await callApi(`/api/auth/invite/${'q'.repeat(43)}`, {}, { cookieHeader: '' })).status).toBe(404);
    expect((await callApi('/api/health?probe=1', {}, { cookieHeader: '' })).status).toBe(200);
  });

  it('never lets a protocol-relative or absolute path steer the request elsewhere', async () => {
    for (const path of ['//evil.example/api/health', 'http://evil.example/api/health', 'api/health']) {
      const res = await callApi(path, {}, { cookieHeader: '' });
      expect(res.status, path).toBe(404);
    }
  });

  it('answers 404 for routes that do not exist, and runs the registered users route (401 without a session)', async () => {
    expect((await callApi('/api/not-a-route?page=1', {}, { cookieHeader: '' })).status).toBe(404);
    const res = await callApi('/api/users?page=1', {}, { cookieHeader: '' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'unauthenticated' });
  });
});

describe('callApi: path hygiene (the path is never trusted to resolve like a URL)', () => {
  const call = (path: string) => callApi(path, {}, { cookieHeader: '' });
  const bad = async (path: string) => {
    const res = await call(path);
    expect(res.status, path).toBe(400);
    expect(await res.json(), path).toEqual({ code: 'bad_request' });
  };

  it('refuses dot segments, so /api/users/../auth/me can never reach another route', async () => {
    for (const p of ['/api/users/../auth/me', '/api/auth/./me', '/api/auth/me/..', '/api/../api/health', '/api/auth/invite/..']) await bad(p);
  });

  it('refuses encoded dots, encoded slashes and backslashes (any case), control characters and fragments', async () => {
    for (const p of [
      '/api/users/%2e%2e/auth/me', '/api/users/%2E%2E/auth/me', '/api/users/.%2e/auth/me', '/api/users/%2e/x',
      '/api/auth%2fme', '/api/auth%2Fme', '/api/auth/invite/a%2fb', '/api/auth%5cme', '/api/auth%5Cme', '/api\\auth/me',
      '/api/health\n', '/api/hea\u0000lth', '/api/health\r\nX: y', '/api/health#frag', '/api/auth/in vite/x', '/api//health',
    ]) await bad(p);
  });

  it('refuses a malformed percent escape', async () => {
    await bad('/api/auth/invite/%E0%A4%A');
  });

  it('keeps a query string out of the path checks, and a dot-looking query is just a query', async () => {
    expect((await call('/api/health?probe=1')).status).toBe(200);
    expect((await call('/api/health?next=/../auth/me')).status).toBe(200);
    expect((await call('/api/health/?a=1')).status).toBe(200);
  });

  it('lets properly encoded parameters through', async () => {
    expect((await call(`/api/auth/invite/${encodeURIComponent('a b/c')}`)).status).toBe(400); // %2F is refused outright
    expect((await call(`/api/auth/invite/${encodeURIComponent('abc_déf')}`)).status).toBe(404);
  });

  it('never dispatches a different route than the one the path names', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    const cookie = await login(app, u.email, u.password);
    const res = await callApi('/api/users/../auth/me', {}, { cookieHeader: cookie });
    expect(res.status).toBe(400);
  });
});

describe('callApi: client address', () => {
  it('forwards X-Forwarded-For and X-Real-IP so in-process calls are rate limited by the real client', async () => {
    const send = (ip: string) =>
      callApi('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.test', password: 'Whatever-123' } }, { cookieHeader: '', clientHeaders: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 5; i += 1) expect((await send('198.51.100.30')).status).toBe(401);
    expect((await send('198.51.100.30')).status).toBe(429);
    expect((await send('198.51.100.31')).status).toBe(401);
    const real = (ip: string) =>
      callApi('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.test', password: 'Whatever-123' } }, { cookieHeader: '', clientHeaders: { 'x-real-ip': ip } });
    for (let i = 0; i < 5; i += 1) expect((await real('198.51.100.40')).status).toBe(401);
    expect((await real('198.51.100.40')).status).toBe(429);
  });

  it('sends nothing when no client headers are given', async () => {
    for (let i = 0; i < 6; i += 1) {
      const res = await callApi('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.test', password: 'Whatever-123' } }, { cookieHeader: '' });
      expect(res.status).toBe(401); // the shared "unknown" bucket has a 4x budget
    }
  });
});
