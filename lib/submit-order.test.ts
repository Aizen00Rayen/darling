import { describe, expect, it } from 'vitest';
import type { OrderInput } from './order-schema';
import { hasHiddenErrors, newIdempotencyKey, submitOrder } from './submit-order';

const order: OrderInput = {
  productSlug: 'wet-kiss',
  shadeCode: '*02',
  quantity: 1,
  fullName: 'Amel B',
  phone: '0612345678',
  wilayaCode: 16,
  commune: 'Hydra',
  mode: 'desk',
};

const json = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('submitOrder', () => {
  it('posts the order as JSON to /api/orders', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await submitOrder(order, { fetch: spy, timeoutMs: 1000 })).toEqual({ kind: 'ok' });
    expect(seen?.url).toBe('/api/orders');
    expect(seen?.init.method).toBe('POST');
    expect((seen?.init.headers as Record<string, string>)['X-Requested-With']).toBe('fetch'); // CSRF header of withAccess
    expect(JSON.parse(seen?.init.body as string)).toEqual(order);
  });

  it('returns field errors from a 400 response', async () => {
    const result = await submitOrder(order, {
      fetch: json(400, { ok: false, errors: { phone: 'Numéro invalide' } }),
      timeoutMs: 1000,
    });
    expect(result).toEqual({ kind: 'invalid', errors: { phone: 'Numéro invalide' } });
  });

  it('treats a 400 without field errors as a failure', async () => {
    const result = await submitOrder(order, { fetch: json(400, { ok: false, errors: {} }), timeoutMs: 1000 });
    expect(result).toEqual({ kind: 'failed' });
  });

  it('treats a server error as a failure', async () => {
    expect(await submitOrder(order, { fetch: json(500, { ok: false }), timeoutMs: 1000 })).toEqual({ kind: 'failed' });
  });

  it('treats a 200 that does not say ok as a failure', async () => {
    expect(await submitOrder(order, { fetch: json(200, { ok: false }), timeoutMs: 1000 })).toEqual({ kind: 'failed' });
  });

  it('treats a non-JSON response as a failure', async () => {
    const html = (async () => new Response('<html>Bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    expect(await submitOrder(order, { fetch: html, timeoutMs: 1000 })).toEqual({ kind: 'failed' });
  });

  it('treats a network error as a failure', async () => {
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await submitOrder(order, { fetch: offline, timeoutMs: 1000 })).toEqual({ kind: 'failed' });
  });

  it('aborts and reports a timeout when the server does not answer in time', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    expect(await submitOrder(order, { fetch: hang, timeoutMs: 20 })).toEqual({ kind: 'timeout' });
  });
});

describe('submitOrder: idempotency key, honeypot, order number, rate limit', () => {
  const capture = () => {
    const seen: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const spy = (async (_url: string, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ ok: true, order: { number: 'DL-26-000042' } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, spy };
  };

  it('sends a fresh Idempotency-Key per submit attempt', async () => {
    const { seen, spy } = capture();
    await submitOrder(order, { fetch: spy, timeoutMs: 1000 });
    await submitOrder(order, { fetch: spy, timeoutMs: 1000 });
    const keys = seen.map((s) => s.headers['Idempotency-Key']);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(keys[1]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('uses the injected key generator', async () => {
    const { seen, spy } = capture();
    await submitOrder(order, { fetch: spy, timeoutMs: 1000, newKey: () => 'fixed-key-12345' });
    expect(seen[0]?.headers['Idempotency-Key']).toBe('fixed-key-12345');
  });

  it('returns the order number from the response, only when it has the right shape', async () => {
    const { spy } = capture();
    expect(await submitOrder(order, { fetch: spy, timeoutMs: 1000 })).toEqual({ kind: 'ok', number: 'DL-26-000042' });
    for (const number of ['x', '<img src=x>', 'DL-26-42', 5, null]) {
      const odd = (async () => new Response(JSON.stringify({ ok: true, order: { number } }), { status: 200 })) as unknown as typeof fetch;
      expect(await submitOrder(order, { fetch: odd, timeoutMs: 1000 })).toEqual({ kind: 'ok' });
    }
  });

  it('sends the honeypot value only when something was typed into it', async () => {
    const { seen, spy } = capture();
    await submitOrder(order, { fetch: spy, timeoutMs: 1000 });
    await submitOrder(order, { fetch: spy, timeoutMs: 1000, honeypot: '' });
    await submitOrder(order, { fetch: spy, timeoutMs: 1000, honeypot: 'http://spam.example' });
    expect('website' in (seen[0]?.body ?? {})).toBe(false);
    expect('website' in (seen[1]?.body ?? {})).toBe(false);
    expect(seen[2]?.body.website).toBe('http://spam.example');
  });

  it('reports a 429 as rate_limited', async () => {
    expect(await submitOrder(order, { fetch: json(429, { code: 'too_many_attempts' }), timeoutMs: 1000 })).toEqual({ kind: 'rate_limited' });
  });

  it('a replayed key (409 conflict) is a plain failure', async () => {
    expect(await submitOrder(order, { fetch: json(409, { code: 'idempotency_conflict' }), timeoutMs: 1000 })).toEqual({ kind: 'failed' });
  });
});

describe('newIdempotencyKey', () => {
  it('is UUID-like, at most 64 characters and different every time', () => {
    const keys = new Set(Array.from({ length: 50 }, newIdempotencyKey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('works without crypto.randomUUID (insecure contexts)', () => {
    const original = globalThis.crypto.randomUUID;
    // @ts-expect-error simulate a browser on plain http
    globalThis.crypto.randomUUID = undefined;
    try {
      expect(newIdempotencyKey()).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      globalThis.crypto.randomUUID = original;
    }
  });
});

describe('hasHiddenErrors', () => {
  it('is false when every error belongs to a field the form shows', () => {
    expect(hasHiddenErrors({ phone: 'x', commune: 'y' }, ['phone', 'commune'])).toBe(false);
  });

  it('is true when an error has nowhere to be shown', () => {
    expect(hasHiddenErrors({ shadeCode: 'x' }, ['phone', 'commune'])).toBe(true);
    expect(hasHiddenErrors({ phone: 'x', productSlug: 'y' }, ['phone'])).toBe(true);
  });
});
