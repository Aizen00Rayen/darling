import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { homePathFor, meSchema } from '@darling/shared';
import type { Me, Role } from '@darling/shared';
import { apiServer } from '../api/server';
import { safeNextPath } from './next-path';

const ENROLLMENT_PATH = '/compte/securite?setup=1';

/** The signed-in user, or null (no/expired session, API down, or a malformed API response). */
export async function getMe(): Promise<Me | null> {
  const res = await apiServer<unknown>('/api/auth/me');
  if (!res.ok) return null;
  const parsed = meSchema.safeParse(res.data);
  return parsed.success ? parsed.data : null;
}

export type RequireUserOptions = {
  /** Set only on the 2FA enrolment page itself, so it does not redirect to itself. */
  allowDuring2faEnrollment?: boolean;
};

/**
 * Session gate for portal layouts and pages. Redirects (never returns) when there is no session, the
 * role is not allowed, or the account still has to enrol in 2FA.
 */
export async function requireUser(allowed: Role[], options: RequireUserOptions = {}): Promise<Me> {
  const me = await getMe();
  if (!me) {
    // proxy.ts records the requested path; only use it when it is a safe same-site path.
    const current = safeNextPath((await headers()).get('x-dl-path'), '');
    redirect(current ? `/connexion?next=${encodeURIComponent(current)}` : '/connexion');
  }
  if (!allowed.includes(me.role)) redirect(homePathFor(me.role));
  if (me.mustEnroll2fa && !options.allowDuring2faEnrollment) redirect(ENROLLMENT_PATH);
  return me;
}
