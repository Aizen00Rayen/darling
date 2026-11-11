import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from '../http';
import { createTestApp, seedUser, login, type TestApp } from '../test/app';
import { withAccess } from './access';
import { bearerMatches, bearerTokenOf } from './bearer';

const TOKEN = 't'.repeat(16) + 'K'.repeat(16) + '0123456789';
let app: TestApp;
const handler = vi.fn(async () => json(200, { ran: true }));

beforeEach(() => {
  handler.mockClear();
  app = createTestApp({ config: { cronToken: TOKEN } });
});
afterEach(() => app.close());

const route = () => withAccess({ kind: 'public' } as const, handler, { csrf: 'bearer' });
const noParams = { params: Promise.resolve({}) };
function req(headers: Record<string, string | undefined>, method = 'POST') {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) h.set(k, v);
  if (!h.has('x-forwarded-for')) h.set('x-forwarded-for', '203.0.113.7');
  return new Request('http://localhost:3000/api/cron/probe', { method, headers: h });
}

describe('bearerTokenOf / bearerMatches', () => {
  it('parses exactly "Bearer <token>"', () => {
    expect(bearerTokenOf('Bearer abc')).toBe('abc');
    expect(bearerTokenOf('bearer abc')).toBe('abc');
    for (const bad of [null, '', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer a b', 'abc', 'Bearer  abc']) expect(bearerTokenOf(bad)).toBeNull();
  });
  it('compares in constant time on digests: equal and different lengths', () => {
    expect(bearerMatches(TOKEN, TOKEN)).toBe(true);
    expect(bearerMatches(TOKEN + 'x', TOKEN)).toBe(false);
    expect(bearerMatches('', TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(bearerMatches(null, TOKEN)).toBe(false);
  });
});

describe("withAccess(..., { csrf: 'bearer' })", () => {
  it('runs the handler for a valid bearer token without Origin or X-Requested-With', async () => {
    const res = await route()(req({ authorization: `Bearer ${TOKEN}` }), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('still refuses a missing, malformed or wrong token with 401 and never runs the handler', async () => {
    for (const authorization of [undefined, 'Bearer', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Basic ${TOKEN}`, TOKEN]) {
      const res = await route()(req({ authorization, 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200)}` }), noParams);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'unauthenticated' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses any request that carries an Origin header (a browser), even with the right token', async () => {
    for (const origin of ['http://localhost:3000', 'https://evil.example', 'null']) {
      const res = await route()(req({ authorization: `Bearer ${TOKEN}`, origin }), noParams);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'csrf' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('is disabled (404, not 401) when no CRON_TOKEN is configured, whatever is sent', async () => {
    app.close();
    app = createTestApp({ config: { cronToken: undefined } });
    for (const authorization of [undefined, `Bearer ${TOKEN}`, 'Bearer ']) {
      const res = await route()(req({ authorization }), noParams);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'not_found' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('rate limits per client address: 10 an hour, failed attempts included', async () => {
    const wrong = { authorization: 'Bearer nope', 'x-forwarded-for': '203.0.113.50' };
    for (let i = 0; i < 10; i += 1) expect((await route()(req(wrong), noParams)).status).toBe(401);
    const limited = await route()(req(wrong), noParams);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    // the right token from the same address is throttled as well; another address is not
    expect((await route()(req({ authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '203.0.113.50' }), noParams)).status).toBe(429);
    expect((await route()(req({ authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '203.0.113.51' }), noParams)).status).toBe(200);
  });

  it('does not accept a session cookie in place of the token', async () => {
    const owner = await seedUser(app, { role: 'super_manager', isOwner: true, totp: true });
    const { totpCodeAt } = await import('../test/app');
    const cookie = await login(app, owner.email, owner.password, { totpCode: totpCodeAt(owner.totpSecret!, app.clock.now()) });
    const res = await route()(req({ cookie }), noParams);
    expect(res.status).toBe(401);
  });

  it('only exists for public routes', () => {
    expect(() => withAccess({ kind: 'owner' } as never, handler, { csrf: 'bearer' })).toThrow(/public/);
  });

  it('leaves the default (Origin + X-Requested-With) untouched for routes without the option', async () => {
    const plain = withAccess({ kind: 'public' } as const, handler);
    const res = await plain(req({ authorization: `Bearer ${TOKEN}` }), noParams);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'csrf' });
  });
});
