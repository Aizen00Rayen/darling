import { effectivePermissions, type Me, type Permission, type Role } from '@/shared';
import type { Db } from '../db/sqlite';
import type { ServerContext } from '../context';
import { getSetting } from '../settings';
import { readSessionCookie, TOKEN_SHAPE } from './cookie';
import { resolveSession } from './sessions';

export interface Principal {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  isOwner: boolean;
  /** In catalogue order. Empty for every role but super_manager; an owner holds all of them. */
  permissions: Permission[];
  twoFactorEnabled: boolean;
  mustEnroll2fa: boolean;
}

/** A principal plus the session that proved it. This is `auth` in route handlers. */
export interface AuthContext extends Principal {
  sessionId: string;
}

/**
 * The current state of an active user, read from the database. Returns null when the user does not exist or is
 * not `active` (invited, suspended, deactivated): such a user is anonymous. Nothing here is cached; role,
 * permission, status and setting changes apply to the next request.
 */
export function loadPrincipal(db: Db, userId: string): Principal | null {
  const user = db.get<{
    id: string;
    email: string;
    full_name: string;
    role: Role;
    status: string;
    is_owner: number;
    totp_enabled: number;
  }>('SELECT id, email, full_name, role, status, is_owner, totp_enabled FROM users WHERE id = ?', userId);
  if (!user || user.status !== 'active') return null;

  const isOwner = user.is_owner === 1;
  // Only a non-owner Super Manager has grants worth reading; effectivePermissions ignores the rest.
  const granted =
    user.role === 'super_manager' && !isOwner
      ? db.all<{ permission: Permission }>('SELECT permission FROM user_permissions WHERE user_id = ?', user.id).map((r) => r.permission)
      : [];
  const totpEnabled = user.totp_enabled === 1;
  const mustEnroll2fa =
    user.role === 'super_manager' && !totpEnabled && getSetting(db, 'security.require_2fa_super_managers');

  return {
    userId: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    isOwner,
    permissions: effectivePermissions({ role: user.role, isOwner, granted }),
    twoFactorEnabled: totpEnabled,
    mustEnroll2fa,
  };
}

export function toMe(p: Principal): Me {
  return {
    id: p.userId,
    email: p.email,
    fullName: p.fullName,
    role: p.role,
    isOwner: p.isOwner,
    permissions: p.permissions,
    twoFactorEnabled: p.twoFactorEnabled,
    mustEnroll2fa: p.mustEnroll2fa,
  };
}

export interface Resolved {
  auth: AuthContext | null;
  /** A session cookie was presented (valid or not). When `auth` is null it is stale and should be cleared. */
  presented: boolean;
}

/**
 * Who a request is, from its Cookie header: session lookup, then the user's CURRENT state. A missing, malformed,
 * expired or revoked session, or a user who is not `active`, yields `auth: null` (anonymous).
 */
export function resolveAuth(ctx: Pick<ServerContext, 'db' | 'clock' | 'config'>, cookieHeader: string | null | undefined): Resolved {
  const token = readSessionCookie(cookieHeader, ctx.config);
  if (token === undefined) return { auth: null, presented: false };
  if (!TOKEN_SHAPE.test(token)) return { auth: null, presented: true };
  const session = resolveSession(ctx.db, token, ctx.clock.now());
  if (!session) return { auth: null, presented: true };
  const principal = loadPrincipal(ctx.db, session.userId);
  if (!principal) return { auth: null, presented: true };
  return { auth: { ...principal, sessionId: session.sessionId }, presented: true };
}

/** For server components: the signed-in user for a Cookie header, or null. No HTTP involved. */
export function loadMeFromCookie(ctx: Pick<ServerContext, 'db' | 'clock' | 'config'>, cookieHeader: string | null | undefined): Me | null {
  const { auth } = resolveAuth(ctx, cookieHeader);
  return auth ? toMe(auth) : null;
}
