import { describe, expect, it } from 'vitest';
import type { OrderInput } from './order-schema';
import { hasHiddenErrors, submitOrder } from './submit-order';

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

describe('hasHiddenErrors', () => {
  it('is false when every error belongs to a field the form shows', () => {
    expect(hasHiddenErrors({ phone: 'x', commune: 'y' }, ['phone', 'commune'])).toBe(false);
  });

  it('is true when an error has nowhere to be shown', () => {
    expect(hasHiddenErrors({ shadeCode: 'x' }, ['phone', 'commune'])).toBe(true);
    expect(hasHiddenErrors({ phone: 'x', productSlug: 'y' }, ['phone'])).toBe(true);
  });
});
