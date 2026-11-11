import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, login, seedUser, type TestApp } from '@/server/test/app';

const { cookieJar, incoming } = vi.hoisted(() => ({ cookieJar: { value: '' }, incoming: new Map<string, string>() }));
vi.mock('next/server', () => ({ connection: async () => undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => cookieJar.value }),
  headers: async () => ({ get: (k: string) => incoming.get(k) ?? null }),
}));

import { apiServer } from './server';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
  cookieJar.value = '';
  incoming.clear();
});
afterEach(() => app.close());

describe('apiServer (in-process)', () => {
  it('maps a 200 to { ok: true, data } without any HTTP and without API_INTERNAL_URL', async () => {
    vi.stubEnv('API_INTERNAL_URL', '');
    const res = await apiServer<{ ok: boolean }>('/api/health');
    expect(res).toEqual({ ok: true, data: { ok: true, db: 'up' } });
    vi.unstubAllEnvs();
  });

  it('forwards the session cookie of the incoming request', async () => {
    const u = await seedUser(app, { role: 'affiliate' });
    cookieJar.value = await login(app, u.email, u.password);
    const res = await apiServer<{ id: string }>('/api/auth/me');
    expect(res.ok && res.data.id).toBe(u.id);
  });

  it('forwards the incoming client address headers into the synthesized request', async () => {
    incoming.set('x-forwarded-for', '198.51.100.50');
    for (let i = 0; i < 5; i += 1) await apiServer('/api/auth/login', { method: 'POST', body: { email: 'x@example.test', password: 'Whatever-123' } });
    const sixth = await apiServer('/api/auth/login', { method: 'POST', body: { email: 'x@example.test', password: 'Whatever-123' } });
    expect(sixth).toMatchObject({ ok: false, status: 429 });
    incoming.set('x-forwarded-for', '198.51.100.51');
    expect(await apiServer('/api/auth/login', { method: 'POST', body: { email: 'x@example.test', password: 'Whatever-123' } })).toMatchObject({ status: 401 });
  });

  it('maps errors like the browser helper: status, code and field errors', async () => {
    const unauth = await apiServer('/api/auth/me');
    expect(unauth).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
    const missing = await apiServer('/api/not-a-route');
    expect(missing).toEqual({ ok: false, status: 404, code: 'not_found' });
    const bad = await apiServer('/api/auth/login', { method: 'POST', body: { email: 'x', password: '' } });
    expect(bad).toMatchObject({ ok: false, status: 400, code: 'validation', errors: expect.any(Object) });
  });

  it('maps a thrown error (database down) to a network-style failure instead of throwing', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(app.db, 'get').mockImplementation(() => {
      throw new Error('down');
    });
    cookieJar.value = `dl_session=${'a'.repeat(43)}`;
    const res = await apiServer('/api/auth/me');
    expect(res.ok).toBe(false);
  });
});
