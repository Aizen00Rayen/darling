import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app';
import { LOG_REDACT_PATHS } from './plugins/logging';
import { testConfig, testDeps } from './test-helpers';

function captureStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      cb();
    },
  });
  return { stream, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('GET /api/health', () => {
  it('returns 200 { ok: true, db: "up" } with an x-request-id header', async () => {
    let executed = 0;
    const app = await buildApp(
      testDeps({
        db: {
          execute: async () => {
            executed += 1;
            return [];
          },
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: 'up' });
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(executed).toBe(1);
    await app.close();
  });

  it('returns 503 { ok: false, db: "down" } when the database check rejects', async () => {
    const app = await buildApp(
      testDeps({
        db: {
          execute: async () => {
            throw new Error('connection refused');
          },
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: 'down' });
    expect(res.headers['x-request-id']).toBeTruthy();
    await app.close();
  });
});

describe('request id', () => {
  it('generates a UUID when none is supplied', async () => {
    const app = await buildApp(testDeps());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    await app.close();
  });

  it('echoes a well-formed incoming x-request-id', async () => {
    const app = await buildApp(testDeps());
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'req_ABC-12345' },
    });
    expect(res.headers['x-request-id']).toBe('req_ABC-12345');
    await app.close();
  });

  it('replaces malformed incoming ids with a generated UUID', async () => {
    const app = await buildApp(testDeps());
    for (const bad of ['short', 'has spaces in it!', 'x'.repeat(65), 'badéchar12345']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { 'x-request-id': bad },
      });
      expect(res.headers['x-request-id']).not.toBe(bad);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
    await app.close();
  });
});

describe('security plugins', () => {
  it('sends helmet headers with a default-src none CSP', async () => {
    const app = await buildApp(testDeps());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('registers @fastify/cookie', async () => {
    const app = await buildApp(testDeps());
    app.get('/t/cookie', async (_req, reply) => {
      reply.setCookie('probe', '1', { httpOnly: true, path: '/' });
      return { ok: true };
    });
    app.get('/t/read-cookie', async (req) => ({ probe: req.cookies.probe ?? null }));
    const set = await app.inject({ method: 'GET', url: '/t/cookie' });
    expect(String(set.headers['set-cookie'])).toContain('probe=1');
    const read = await app.inject({
      method: 'GET',
      url: '/t/read-cookie',
      headers: { cookie: 'probe=abc' },
    });
    expect(read.json()).toEqual({ probe: 'abc' });
    await app.close();
  });

  it('registers rate limiting with global off and per-route opt-in', async () => {
    const app = await buildApp(testDeps());
    app.get('/t/open', async () => ({ ok: true }));
    app.get('/t/limited', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({
      ok: true,
    }));
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/t/open' })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/t/limited' })).statusCode).toBe(200);
    const limited = await app.inject({ method: 'GET', url: '/t/limited' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: 'rate_limited' });
    await app.close();
  });
});

describe('error handling', () => {
  it('maps unknown routes to 404 { code: "not_found" }', async () => {
    const app = await buildApp(testDeps());
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'not_found' });
    expect(res.headers['x-request-id']).toBeTruthy();
    await app.close();
  });

  it('maps Zod validation failures to 400 with the first message per field', async () => {
    const app = await buildApp(testDeps());
    app.post(
      '/t/validate',
      {
        schema: {
          body: z.object({
            email: z.string().email('Enter a valid email').min(50, 'Too short'),
            age: z.number({ error: 'Age must be a number' }),
            address: z.object({ city: z.string().min(1, 'City is required') }),
          }),
        },
      },
      async () => ({ ok: true }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/t/validate',
      payload: { email: 'nope', age: 'x', address: { city: '' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      code: 'validation',
      errors: {
        email: 'Enter a valid email',
        age: 'Age must be a number',
        'address.city': 'City is required',
      },
    });
    await app.close();
  });

  it('maps malformed JSON to a 400 without leaking parser details', async () => {
    const app = await buildApp(testDeps());
    app.post('/t/json', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/t/json',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: 'bad_request' });
    await app.close();
  });

  it('maps unexpected errors to 500 { code: "internal" } and logs them with the request id', async () => {
    const { stream, records } = captureStream();
    const app = await buildApp(testDeps(), { logStream: stream });
    app.get('/t/boom', async () => {
      throw new Error('kaboom secret detail');
    });
    const res = await app.inject({
      method: 'GET',
      url: '/t/boom',
      headers: { 'x-request-id': 'boom-request-1' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'internal' });
    expect(res.body).not.toContain('kaboom');
    expect(res.body).not.toContain('at ');
    expect(res.headers['x-request-id']).toBe('boom-request-1');
    const logged = records().find((r) => r.reqId === 'boom-request-1' && r.err);
    expect(logged).toBeTruthy();
    expect(JSON.stringify(logged)).toContain('kaboom secret detail');
    await app.close();
  });

  it('maps response serialization failures to 500 { code: "internal" }', async () => {
    const app = await buildApp(testDeps());
    app.get(
      '/t/bad-response',
      { schema: { response: { 200: z.object({ n: z.number() }) } } },
      async () => ({ n: 'not a number' as unknown as number }),
    );
    const res = await app.inject({ method: 'GET', url: '/t/bad-response' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'internal' });
    await app.close();
  });
});

describe('logging', () => {
  it('lists the sensitive paths for redaction', () => {
    expect(LOG_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.cookie',
        'req.headers.authorization',
        'password',
        'newPassword',
        'currentPassword',
        'token',
      ]),
    );
  });

  it('censors sensitive fields in log lines', async () => {
    const { stream, records } = captureStream();
    const app = await buildApp(testDeps({ config: testConfig() }), { logStream: stream });
    app.post('/t/log', async (req) => {
      req.log.info(
        { password: 'hunter2-pw', token: 'tok-123', body: { newPassword: 'np-456', currentPassword: 'cp-789' } },
        'probe',
      );
      return { ok: true };
    });
    await app.inject({ method: 'POST', url: '/t/log', payload: {} });
    const raw = JSON.stringify(records());
    expect(raw).toContain('probe');
    for (const secret of ['hunter2-pw', 'tok-123', 'np-456', 'cp-789']) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain('[Redacted]');
    await app.close();
  });
});
