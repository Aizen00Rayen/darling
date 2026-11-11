import { randomUUID } from 'node:crypto';
import type { Permission, Role } from '@/shared';
import { clearedSessionCookie, sessionCookieName } from '../auth/cookie';
import { resolveAuth, type AuthContext } from '../auth/principal';
import { getServerContext, type ServerContext } from '../context';
import { json } from '../http';
import { logError } from '../log';
import { clientIp } from '../net/client-ip';

export { json, noContent, parseBody, validationFailed } from '../http';
export type { AuthContext } from '../auth/principal';

/**
 * What a route requires. Every route handler is built with `withAccess(access, handler)`; a test scans
 * app/api/**\/route.ts and fails when one is not (and when it is missing from the authorization matrix).
 */
export type Access =
  | { kind: 'public' }
  | { kind: 'authenticated'; allowDuring2faEnrollment?: boolean }
  | { kind: 'role'; roles: Role[] }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'owner' };

export interface Refusal {
  status: 401 | 403;
  code: 'unauthenticated' | 'forbidden' | '2fa_enrollment_required';
}

function allowed(access: Access, auth: AuthContext): boolean {
  switch (access.kind) {
    case 'public':
    case 'authenticated':
      return true;
    case 'role':
      return access.roles.includes(auth.role);
    // Only Super Managers hold permissions; owners hold all of them via `permissions`.
    case 'permission':
      return auth.role === 'super_manager' && auth.permissions.includes(access.permission);
    case 'owner':
      return auth.role === 'super_manager' && auth.isOwner;
    default: {
      // An unknown kind (a typo that slipped past the type checker) must fail closed.
      const _exhaustive: never = access;
      void _exhaustive;
      return false;
    }
  }
}

/** The access decision. Null = proceed. Denials are always a bare `{ code }`: no data leaks through a refusal. */
export function decide(access: Access, auth: AuthContext | null): Refusal | null {
  if (access.kind === 'public') return null;
  if (!auth) return { status: 401, code: 'unauthenticated' };
  const enrollmentAllowed = access.kind === 'authenticated' && access.allowDuring2faEnrollment === true;
  if (auth.mustEnroll2fa && !enrollmentAllowed) return { status: 403, code: '2fa_enrollment_required' };
  if (!allowed(access, auth)) return { status: 403, code: 'forbidden' };
  return null;
}

type AuthFor<A extends Access> = A extends { kind: 'public' } ? AuthContext | null : AuthContext;

export interface HandlerArgs<P, A extends Access> {
  request: Request;
  /** Route params, already awaited. */
  params: P;
  /** Null only on public routes. */
  auth: AuthFor<A>;
  ctx: ServerContext;
  /** Client address per TRUSTED_PROXY_HOPS ('unknown' when none can be determined). */
  ip: string;
  /** Opaque id for correlating audit rows with logs. */
  requestId: string;
}

export type RouteHandler<P> = (request: Request, routeCtx: { params: Promise<P> }) => Promise<Response>;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every state-changing request must come from our own web app: it sends `X-Requested-With: fetch` (which a
 * cross-site form cannot set) and a browser-supplied `Origin` exactly equal to the app origin. Public routes
 * are not exempt: login and password reset need it too. Exact string comparison, no pattern matching; duplicate
 * Origin headers arrive joined with ", " and therefore never match.
 */
function csrfOk(request: Request, appOrigin: string): boolean {
  return request.headers.get('x-requested-with') === 'fetch' && request.headers.get('origin') === appOrigin;
}

/**
 * Wraps a route handler with the whole request pipeline, in this order:
 *  1. CSRF (non-GET/HEAD/OPTIONS), before anything else is looked at
 *  2. the principal, read from the database from the session cookie on EVERY request
 *  3. the access decision (401 / 403 with a bare `{ code }`)
 *  4. only then the handler, which reads and validates the body itself (so refused callers never see validation)
 * Unexpected errors become 500 `{ code: 'internal' }`, logged without body, params or cookies.
 */
export function withAccess<A extends Access, P = Record<string, string>>(
  access: A,
  handler: (args: HandlerArgs<P, A>) => Response | Promise<Response>,
): RouteHandler<P> {
  return async (request, routeCtx) => {
    try {
      // First touch of the request: under Next's build-time prerender pass this is what marks the route dynamic,
      // before any configuration or database is read.
      const cookieHeader = request.headers.get('cookie');
      const ctx = getServerContext();

      if (!SAFE_METHODS.has(request.method) && !csrfOk(request, ctx.config.appOrigin)) {
        return json(403, { code: 'csrf' });
      }

      const { auth, presented } = resolveAuth(ctx, cookieHeader);
      const refusal = decide(access, auth);
      const finish = (response: Response): Response => {
        // A cookie that no longer maps to a live session is cleared, unless the handler issued its own.
        if (presented && !auth) {
          const own = response.headers.getSetCookie().some((c) => c.startsWith(`${sessionCookieName(ctx.config)}=`));
          if (!own) response.headers.append('Set-Cookie', clearedSessionCookie(ctx.config));
        }
        if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'no-store');
        return response;
      };
      if (refusal) return finish(json(refusal.status, { code: refusal.code }));

      const params = await routeCtx.params;
      const ip = clientIp(request.headers, undefined, ctx.config.trustedProxyHops);
      const response = await handler({ request, params, auth: auth as AuthFor<A>, ctx, ip, requestId: randomUUID() });
      return finish(mutable(response));
    } catch (err) {
      // Next.js control-flow errors (dynamic-usage bail-outs, redirects, not-found) are not failures: let them through.
      const digest = (err as { digest?: unknown } | null)?.digest;
      if (typeof digest === 'string' && /^(NEXT_|DYNAMIC_SERVER_USAGE|HANGING_PROMISE|BAILOUT)/.test(digest)) throw err;
      logError('api.unhandled', err);
      return json(500, { code: 'internal' });
    }
  };
}

/** Responses built by `Response.redirect()` and friends have immutable headers; copy those. */
function mutable(response: Response): Response {
  try {
    response.headers.set('X-Probe', '1');
    response.headers.delete('X-Probe');
    return response;
  } catch {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
  }
}
