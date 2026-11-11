import type { Access, RouteHandler } from './security/access';
import { getServerContext } from './context';
import { json } from './http';
import * as health from '@/app/api/health/route';
import * as login from '@/app/api/auth/login/route';
import * as logout from '@/app/api/auth/logout/route';
import * as me from '@/app/api/auth/me/route';
import * as twoFactorSetup from '@/app/api/auth/2fa/setup/route';
import * as twoFactorEnable from '@/app/api/auth/2fa/enable/route';
import * as twoFactorDisable from '@/app/api/auth/2fa/disable/route';
import * as passwordChange from '@/app/api/auth/password/change/route';
import * as passwordForgot from '@/app/api/auth/password/forgot/route';
import * as passwordReset from '@/app/api/auth/password/reset/route';
import * as inviteLookup from '@/app/api/auth/invite/[token]/route';
import * as inviteAccept from '@/app/api/auth/invite/accept/route';
import * as orders from '@/app/api/orders/route';
import * as auditLog from '@/app/api/audit-log/route';
import * as loginEvents from '@/app/api/login-events/route';
import * as settings from '@/app/api/settings/route';
import * as settingByKey from '@/app/api/settings/[key]/route';
import * as setup from '@/app/api/setup/route';
import * as users from '@/app/api/users/route';
import * as userById from '@/app/api/users/[id]/route';
import * as userSuspend from '@/app/api/users/[id]/suspend/route';
import * as userReactivate from '@/app/api/users/[id]/reactivate/route';
import * as userResend from '@/app/api/users/[id]/resend-invite/route';
import * as userRevoke from '@/app/api/users/[id]/revoke-sessions/route';

// Static table of EVERY route handler in app/api/**/route.ts. It lets server components call the API in-process
// (callApi) with exactly the same pipeline as an HTTP request, and lets tests dispatch without a server.
// server/security/access-matrix.test.ts fails when a route file is missing from this table (or from the matrix).

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
const METHODS: readonly Method[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = RouteHandler<any>;

export interface RegisteredRoute {
  /** `/api/auth/invite/:token` style: `:name` segments are route params. */
  pattern: string;
  methods: Partial<Record<Method, AnyHandler>>;
  access: Access;
}

function route(pattern: string, mod: { access: Access } & Partial<Record<Method, unknown>>): RegisteredRoute {
  const methods: Partial<Record<Method, AnyHandler>> = {};
  for (const m of METHODS) {
    const handler = mod[m];
    if (typeof handler === 'function') methods[m] = handler as AnyHandler;
  }
  return { pattern, methods, access: mod.access };
}

export const ROUTES: readonly RegisteredRoute[] = [
  route('/api/health', health),
  route('/api/orders', orders),
  route('/api/audit-log', auditLog),
  route('/api/login-events', loginEvents),
  route('/api/settings', settings),
  route('/api/settings/:key', settingByKey),
  route('/api/setup', setup),
  route('/api/users', users),
  route('/api/users/:id', userById),
  route('/api/users/:id/suspend', userSuspend),
  route('/api/users/:id/reactivate', userReactivate),
  route('/api/users/:id/resend-invite', userResend),
  route('/api/users/:id/revoke-sessions', userRevoke),
  route('/api/auth/login', login),
  route('/api/auth/logout', logout),
  route('/api/auth/me', me),
  route('/api/auth/2fa/setup', twoFactorSetup),
  route('/api/auth/2fa/enable', twoFactorEnable),
  route('/api/auth/2fa/disable', twoFactorDisable),
  route('/api/auth/password/change', passwordChange),
  route('/api/auth/password/forgot', passwordForgot),
  route('/api/auth/password/reset', passwordReset),
  route('/api/auth/invite/accept', inviteAccept),
  route('/api/auth/invite/:token', inviteLookup),
];

const compiled = ROUTES.map((r) => ({ route: r, segments: r.pattern.split('/').filter(Boolean) }));

export function matchRoute(pathname: string): { route: RegisteredRoute; params: Record<string, string> } | null {
  if (!pathname.startsWith('/')) return null;
  const parts = pathname.split('/').filter(Boolean); // a trailing slash is ignored, like Next does
  let best: { route: RegisteredRoute; params: Record<string, string>; statics: number } | null = null;
  for (const { route: r, segments } of compiled) {
    if (segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let statics = 0;
    let ok = true;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i] as string;
      const part = parts[i] as string;
      if (seg.startsWith(':')) {
        try {
          params[seg.slice(1)] = decodeURIComponent(part);
        } catch {
          return null; // malformed percent-escape
        }
      } else if (seg === part) {
        statics += 1;
      } else {
        ok = false;
        break;
      }
    }
    if (ok && (!best || statics > best.statics)) best = { route: r, params, statics };
  }
  return best ? { route: best.route, params: best.params } : null;
}

/** Runs the registered handler for a request's path and method, in-process. */
export async function dispatchApi(request: Request): Promise<Response> {
  const matched = matchRoute(new URL(request.url).pathname);
  if (!matched) return json(404, { code: 'not_found' });
  const method = request.method.toUpperCase() as Method;
  const handler = matched.route.methods[method];
  if (!handler) {
    const allow = Object.keys(matched.route.methods).join(', ');
    return json(405, { code: 'method_not_allowed' }, { Allow: allow });
  }
  return handler(request, { params: Promise.resolve(matched.params) });
}

export interface CallApiInit {
  method?: string;
  body?: unknown;
}

export interface CallApiOptions {
  /** The CURRENT user's Cookie header, forwarded as is. */
  cookieHeader: string;
  /** The incoming request's client-address headers, so in-process calls carry the real client address. */
  clientHeaders?: { 'x-forwarded-for'?: string | null; 'x-real-ip'?: string | null };
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validates the path part of a callApi path. Rejected (400 `bad_request`): dot segments (`.`/`..`, also
 * percent-encoded), encoded slashes and backslashes, control characters, fragments, empty inner segments, a
 * malformed percent escape, and anything `new URL()` would normalise differently from the text given (so the
 * route that is dispatched is always the one the path literally names).
 */
function badPath(pathname: string, base: string): boolean {
  if (CONTROL_CHARS.test(pathname) || pathname.includes('\\') || pathname.includes('#')) return true;
  if (/%2f|%5c/i.test(pathname)) return true;
  const segments = pathname.split('/').slice(1);
  for (const [i, seg] of segments.entries()) {
    if (seg === '' && i !== segments.length - 1) return true; // "//" inside the path
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return true;
    }
    if (decoded === '.' || decoded === '..' || seg === '.' || seg === '..') return true;
    if (CONTROL_CHARS.test(decoded)) return true;
  }
  try {
    return new URL(pathname, base).pathname !== pathname;
  } catch {
    return true;
  }
}

/**
 * Server-side API call without HTTP: builds a Request the way the web app's own browser code would (Origin =
 * APP_ORIGIN, X-Requested-With: fetch, the caller's cookie) and runs the registered handler in-process.
 *
 * It is for server components acting for the CURRENT user (their own cookie) with paths the code itself
 * constructs; never pass a user-controlled raw path, and encode every interpolated parameter with
 * encodeURIComponent. What is guaranteed: the path must start with a single `/`, is never parsed as a URL for a
 * different host, and is refused (400) when it contains dot segments, encoded slashes/dots, backslashes, control
 * characters or anything the URL parser would rewrite, so the route dispatched is the route the path names.
 * What is NOT guaranteed: that the route is one the caller meant, or that a parameter value is safe for the
 * handler: the handlers' own access rules and validation still apply, exactly as for an HTTP request.
 */
export async function callApi(path: string, init: CallApiInit, opts: CallApiOptions): Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//')) return json(404, { code: 'not_found' });
  const q = path.indexOf('?');
  const pathname = q === -1 ? path : path.slice(0, q);
  const { config } = getServerContext();
  if (badPath(pathname, config.appOrigin)) return json(400, { code: 'bad_request' });

  const headers = new Headers({ Origin: config.appOrigin, 'X-Requested-With': 'fetch', Accept: 'application/json' });
  if (opts.cookieHeader) headers.set('Cookie', opts.cookieHeader);
  for (const name of ['x-forwarded-for', 'x-real-ip'] as const) {
    const value = opts.clientHeaders?.[name];
    if (value) headers.set(name, value);
  }
  const hasBody = init.body !== undefined;
  if (hasBody) headers.set('Content-Type', 'application/json');
  const request = new Request(`${config.appOrigin}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });
  return dispatchApi(request);
}
