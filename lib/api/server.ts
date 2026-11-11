import { cookies, headers } from 'next/headers';
import { connection } from 'next/server';
import { callApi } from '@/server/api-registry';
import { logError } from '@/server/log';
import { toApiResult } from './client';
import type { ApiInit, ApiResult } from './client';

/**
 * Server helper (server components, route handlers, server actions): runs the registered API handler IN-PROCESS
 * (no HTTP, no internal URL), forwarding the incoming session cookie and client-address headers. `path` must be
 * built by the calling code (encode parameters with encodeURIComponent), never taken raw from user input; see callApi. Request-time data: call it inside
 * <Suspense> / a dynamic component. The cookie header is only ever forwarded, never logged or returned.
 */
export async function apiServer<T>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  // cookies() is outside the try: during prerendering it signals "dynamic" by throwing, which must propagate.
  const cookieHeader = (await cookies()).toString();
  const incoming = await headers();
  const clientHeaders = { 'x-forwarded-for': incoming.get('x-forwarded-for'), 'x-real-ip': incoming.get('x-real-ip') };
  await connection(); // request-time: handlers read the clock and the database
  try {
    const res = await callApi(path, init, { cookieHeader, clientHeaders });
    return await toApiResult<T>(res);
  } catch (err) {
    logError('api_server.failed', err);
    return { ok: false, status: 0, code: 'network' };
  }
}
