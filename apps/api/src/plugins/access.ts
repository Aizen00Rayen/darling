import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Permission, Role } from '@darling/shared';

/**
 * What a route requires. Every route must declare one in `config.access`; a route without it
 * cannot be registered (see the onRoute hook below).
 */
export type Access =
  | { kind: 'public' }
  | { kind: 'authenticated'; allowDuring2faEnrollment?: boolean }
  | { kind: 'role'; roles: Role[] }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'owner' };

/**
 * Set on `request.auth` by the auth plugin once it has resolved a valid session. The auth plugin
 * must do this in an `onRequest` hook: access is enforced in `preValidation`, which runs after every
 * `onRequest` hook.
 */
export type AuthContext = {
  sessionId: string;
  userId: string;
  role: Role;
  isOwner: boolean;
  /** For an owner, every permission. Roles other than super_manager hold none. */
  permissions: Set<Permission>;
  /** A Super Manager who must set up two-factor before using anything else. */
  mustEnroll2fa: boolean;
};

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

function describeMethod(method: string | readonly string[]): string {
  return Array.isArray(method) ? method.join(',') : String(method);
}

/**
 * Denials are always a bare `{ code }`. A caller with the wrong role or permission gets a 403 and
 * nothing else: the handler never runs, so no data (not even a count) can leak through the refusal.
 */
function deny(reply: FastifyReply, status: 401 | 403, code: string): FastifyReply {
  return reply.code(status).send({ code });
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
      return auth.role === 'super_manager' && auth.permissions.has(access.permission);
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

// Enforced in `preValidation`, not `preHandler`, so a refused request is turned away before the body
// schema runs (its messages and refinements must not reach callers who may not use the route) and
// before any route-level preValidation hook. Global hooks of a type run before route-level ones.
async function enforce(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  const access = request.routeOptions.config.access;
  if (!access) {
    // Fastify's own not-found route has no rule and nothing to protect: the handler answers 404.
    if (request.is404) return;
    // Unreachable for registered routes (onRoute refuses them), so fail closed.
    return deny(reply, 403, 'forbidden');
  }
  if (access.kind === 'public') return;

  const auth = request.auth;
  if (!auth) return deny(reply, 401, 'unauthenticated');

  const enrollmentAllowed = access.kind === 'authenticated' && access.allowDuring2faEnrollment === true;
  if (auth.mustEnroll2fa && !enrollmentAllowed) {
    return deny(reply, 403, '2fa_enrollment_required');
  }

  if (!allowed(access, auth)) return deny(reply, 403, 'forbidden');
}

/**
 * Registered without encapsulation (fastify-plugin) so the hooks apply to every route in the app,
 * including routes added by child plugins. It must be registered before any route.
 */
export const accessPlugin = fp(
  async (app) => {
    app.decorateRequest('auth', null);

    app.addHook('onRoute', (route) => {
      if (route.config?.access) return;
      throw new Error(`Route ${describeMethod(route.method)} ${route.url} has no access rule`);
    });

    app.addHook('preValidation', enforce);
  },
  { name: 'darling-access' },
);
