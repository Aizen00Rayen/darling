import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { homePathFor, meSchema } from '@/shared';
import type { Me, Role } from '@/shared';
import { loadMeFromCookie } from '@/server/auth/principal';
import { getServerContext } from '@/server/context';
import { logError } from '@/server/log';
import { safeNextPath } from './next-path';

const ENROLLMENT_PATH = '/compte/securite?setup=1';

/** The signed-in user, or null (no/expired session, database error, or a malformed result). Calls the principal loader in-process: no HTTP. */
export async function getMe(): Promise<Me | null> {
  // cookies() is outside the try: during prerendering it signals "dynamic" by throwing, which must propagate.
  const cookieHeader = (await cookies()).toString();
  await connection(); // request-time: the loader reads the clock and the database
  try {
    const me = loadMeFromCookie(getServerContext(), cookieHeader);
    const parsed = meSchema.safeParse(me);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    logError('session.load_failed', err);
    return null;
  }
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
