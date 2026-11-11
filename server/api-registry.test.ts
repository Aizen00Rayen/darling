import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, callApi, dispatchApi, matchRoute } from './api-registry';
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
      expect(r.access.kind).toMatch(/^(public|authenticated|role|permission|owner)$/);
      expect(Object.keys(r.methods).length).toBeGreaterThan(0);
    }
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
    for (const path of ['//evil.example/api/health', 'http://evil.example/api/health', '/\\evil.example/api/health', 'api/health']) {
      const res = await callApi(path, {}, { cookieHeader: '' });
      expect(res.status, path).toBe(404);
    }
  });

  it('answers 404 for routes that do not exist yet (M3 pages)', async () => {
    const res = await callApi('/api/users?page=1', {}, { cookieHeader: '' });
    expect(res.status).toBe(404);
  });
});
