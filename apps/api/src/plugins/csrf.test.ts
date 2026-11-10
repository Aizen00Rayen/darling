import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { testConfig, testDeps } from '../test-helpers';

const ORIGIN = 'http://localhost:3000';
const GOOD = { 'x-requested-with': 'fetch', origin: ORIGIN };

let app: FastifyInstance;
let handled = 0;

beforeAll(async () => {
  app = await buildApp(testDeps({ config: testConfig({ appOrigin: ORIGIN }) }), {
    extend: (instance) => {
      const pub = { config: { access: { kind: 'public' as const } } };
      instance.get('/t', pub, async () => ({ ok: true }));
      instance.post('/t', pub, async () => {
        handled += 1;
        return { ok: true };
      });
      instance.put('/t', pub, async () => ({ ok: true }));
      instance.patch('/t', pub, async () => ({ ok: true }));
      instance.delete('/t', pub, async () => ({ ok: true }));
      instance.post('/private', { config: { access: { kind: 'authenticated' } } }, async () => ({ ok: true }));
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const csrf = { code: 'csrf' };

describe('CSRF protection', () => {
  it('rejects a POST without x-requested-with', async () => {
    const before = handled;
    const res = await app.inject({ method: 'POST', url: '/t', headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(csrf);
    expect(handled).toBe(before);
  });

  it('rejects a POST without an Origin header', async () => {
    const res = await app.inject({ method: 'POST', url: '/t', headers: { 'x-requested-with': 'fetch' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(csrf);
  });

  it('rejects a POST with no CSRF headers at all, on public and protected routes alike', async () => {
    for (const url of ['/t', '/private', '/api/health']) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toEqual(csrf);
    }
  });

  it('rejects an x-requested-with value other than exactly "fetch"', async () => {
    for (const value of ['XMLHttpRequest', 'Fetch', 'FETCH', 'fetch ', '', 'fetch, fetch', 'true']) {
      const res = await app.inject({
        method: 'POST',
        url: '/t',
        headers: { 'x-requested-with': value, origin: ORIGIN },
      });
      expect(res.statusCode, JSON.stringify(value)).toBe(403);
    }
  });

  it.each([
    ['another host', 'https://evil.example'],
    ['same host, different port', 'http://localhost:3001'],
    ['same host, no port', 'http://localhost'],
    ['different host, same port', 'http://127.0.0.1:3000'],
    ['different scheme', 'https://localhost:3000'],
    ['trailing slash', 'http://localhost:3000/'],
    ['upper-case origin', 'HTTP://LOCALHOST:3000'],
    ['suffix attack', 'http://localhost:3000.evil.example'],
    ['prefix attack', 'http://evil.example/http://localhost:3000'],
    ['null origin', 'null'],
    ['empty origin', ''],
  ])('rejects a POST whose Origin is %s', async (_name, origin) => {
    const res = await app.inject({
      method: 'POST',
      url: '/t',
      headers: { 'x-requested-with': 'fetch', origin },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(csrf);
  });

  it('accepts a POST with the correct headers', async () => {
    const before = handled;
    const res = await app.inject({ method: 'POST', url: '/t', headers: GOOD });
    expect(res.statusCode).toBe(200);
    expect(handled).toBe(before + 1);
  });

  it.each(['PUT', 'PATCH', 'DELETE'] as const)('protects %s as well', async (method) => {
    expect((await app.inject({ method, url: '/t' })).statusCode).toBe(403);
    expect((await app.inject({ method, url: '/t', headers: GOOD })).statusCode).toBe(200);
  });

  it('checks CSRF before access: a forged anonymous POST is csrf, not unauthenticated', async () => {
    const forged = await app.inject({ method: 'POST', url: '/private' });
    expect(forged.json()).toEqual(csrf);
    const real = await app.inject({ method: 'POST', url: '/private', headers: GOOD });
    expect(real.statusCode).toBe(401);
    expect(real.json()).toEqual({ code: 'unauthenticated' });
  });

  it('lets GET through without either header', async () => {
    const res = await app.inject({ method: 'GET', url: '/t' });
    expect(res.statusCode).toBe(200);
    // Even with a hostile Origin: GET carries no side effects.
    const hostile = await app.inject({ method: 'GET', url: '/t', headers: { origin: 'https://evil.example' } });
    expect(hostile.statusCode).toBe(200);
  });

  it('lets HEAD and OPTIONS through without either header', async () => {
    expect((await app.inject({ method: 'HEAD', url: '/t' })).statusCode).toBe(200);
    // No OPTIONS route exists, so the 404 handler answers: the point is that it is not a csrf 403.
    const options = await app.inject({ method: 'OPTIONS', url: '/t' });
    expect(options.statusCode).not.toBe(403);
    expect(options.json()).not.toEqual(csrf);
  });

  it('compares against the configured origin, not a hard-coded one', async () => {
    const other = await buildApp(testDeps({ config: testConfig({ appOrigin: 'https://app.darling7.store' }) }), {
      extend: (instance) => {
        instance.post('/t', { config: { access: { kind: 'public' } } }, async () => ({ ok: true }));
      },
    });
    const wrong = await other.inject({ method: 'POST', url: '/t', headers: GOOD });
    expect(wrong.statusCode).toBe(403);
    const right = await other.inject({
      method: 'POST',
      url: '/t',
      headers: { 'x-requested-with': 'fetch', origin: 'https://app.darling7.store' },
    });
    expect(right.statusCode).toBe(200);
    await other.close();
  });
});
