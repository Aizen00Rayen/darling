import { cookies } from 'next/headers';
import { toApiResult } from './client';
import type { ApiInit, ApiResult } from './client';

/**
 * Server helper (server components, route handlers, server actions): calls the Fastify API directly,
 * forwarding the incoming session cookie. Request-time data: call it inside <Suspense> / a dynamic
 * component. The cookie header is only ever forwarded, never logged or returned.
 */
export async function apiServer<T>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  const base = process.env.API_INTERNAL_URL;
  const origin = process.env.APP_ORIGIN;
  if (!base || !origin) return { ok: false, status: 0, code: 'misconfigured' };

  const headers: Record<string, string> = {
    Origin: origin,
    'X-Requested-With': 'fetch',
    Accept: 'application/json',
  };
  const cookieHeader = (await cookies()).toString();
  if (cookieHeader) headers.Cookie = cookieHeader;
  const hasBody = init.body !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(new URL(path, base), {
      method: init.method ?? 'GET',
      headers,
      body: hasBody ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, code: 'network' };
  }
  return toApiResult<T>(res);
}
