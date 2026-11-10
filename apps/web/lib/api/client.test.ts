import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('api()', () => {
  it('sends X-Requested-With and a JSON body, same-origin credentials', async () => {
    const fetchMock = stubFetch(async () => Response.json({ user: { id: 'u1' } }));
    const result = await api<{ user: { id: string } }>('/api/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'x' } });
    expect(result).toEqual({ ok: true, data: { user: { id: 'u1' } } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    const headers = new Headers(init.headers);
    expect(headers.get('x-requested-with')).toBe('fetch');
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ email: 'a@b.co', password: 'x' }));
  });

  it('defaults to GET without a body or content-type', async () => {
    const fetchMock = stubFetch(async () => Response.json({ ok: 1 }));
    await api('/api/auth/me');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get('content-type')).toBeNull();
  });

  it('maps a 400 validation body to code and errors', async () => {
    stubFetch(async () => Response.json({ code: 'validation', errors: { password: 'Trop court.' } }, { status: 400 }));
    expect(await api('/api/auth/password/reset', { method: 'POST', body: {} })).toEqual({
      ok: false,
      status: 400,
      code: 'validation',
      errors: { password: 'Trop court.' },
    });
  });

  it('maps a code-only error body without an errors key', async () => {
    stubFetch(async () => Response.json({ code: 'invalid_credentials' }, { status: 401 }));
    expect(await api('/api/auth/login', { method: 'POST', body: {} })).toEqual({ ok: false, status: 401, code: 'invalid_credentials' });
  });

  it('maps a network failure to status 0 / network', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await api('/api/auth/me')).toEqual({ ok: false, status: 0, code: 'network' });
  });

  it('maps a 204 to ok with undefined data', async () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    expect(await api('/api/auth/logout', { method: 'POST' })).toEqual({ ok: true, data: undefined });
  });

  it('maps a non-JSON body to bad_response', async () => {
    stubFetch(async () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    expect(await api('/api/auth/me')).toEqual({ ok: false, status: 502, code: 'bad_response' });
  });

  it('maps a non-JSON 200 body to bad_response', async () => {
    stubFetch(async () => new Response('hello', { status: 200 }));
    expect(await api('/api/auth/me')).toEqual({ ok: false, status: 200, code: 'bad_response' });
  });

  it('falls back to bad_response for an error JSON without a code', async () => {
    stubFetch(async () => Response.json({ message: 'x' }, { status: 500 }));
    expect(await api('/api/x')).toEqual({ ok: false, status: 500, code: 'bad_response' });
  });
});
