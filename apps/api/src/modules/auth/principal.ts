import { eq } from 'drizzle-orm';
import { effectivePermissions, type Me, type Permission, type Role } from '@darling/shared';
import type { DbExecutor } from '../../db/client';
import { userPermissions, users } from '../../db/schema';
import { getSetting } from '../settings/service';

export type Principal = {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  isOwner: boolean;
  /** In catalogue order. Empty for every role but super_manager; an owner holds all of them. */
  permissions: Permission[];
  twoFactorEnabled: boolean;
  mustEnroll2fa: boolean;
};

/**
 * The current state of an active user, read from the database. Returns null when the user does
 * not exist or is not `active` (invited, suspended, deactivated): such a user is anonymous.
 * Nothing here is cached; role, permission, status and setting changes apply to the next request.
 */
export async function loadPrincipal(db: DbExecutor, userId: string): Promise<Principal | null> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      status: users.status,
      isOwner: users.isOwner,
      totpEnabled: users.totpEnabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.status !== 'active') return null;

  // Only a non-owner Super Manager has grants worth reading; effectivePermissions ignores the rest.
  const granted =
    user.role === 'super_manager' && !user.isOwner
      ? (
          await db
            .select({ permission: userPermissions.permission })
            .from(userPermissions)
            .where(eq(userPermissions.userId, user.id))
        ).map((r) => r.permission)
      : [];

  const mustEnroll2fa =
    user.role === 'super_manager' &&
    !user.totpEnabled &&
    (await getSetting(db, 'security.require_2fa_super_managers'));

  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    isOwner: user.isOwner,
    permissions: effectivePermissions({ role: user.role, isOwner: user.isOwner, granted }),
    twoFactorEnabled: user.totpEnabled,
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
