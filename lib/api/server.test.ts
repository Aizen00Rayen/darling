import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, login, seedUser, type TestApp } from '@/server/test/app';

const cookieJar = { value: '' };
vi.mock('next/headers', () => ({ cookies: async () => ({ toString: () => cookieJar.value }) }));

import { apiServer } from './server';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
  cookieJar.value = '';
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

  it('maps errors like the browser helper: status, code and field errors', async () => {
    const unauth = await apiServer('/api/auth/me');
    expect(unauth).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
    const missing = await apiServer('/api/users');
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
