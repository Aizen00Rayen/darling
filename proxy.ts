import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { safeNextPath } from './lib/auth/next-path';

/** Header carrying the requested path to server components (so requireUser can build `?next=`). */
const PATH_HEADER = 'x-dl-path';

const SESSION_COOKIES = ['dl_session', '__Host-dl_session'];

/**
 * Portal gate: no session cookie at all -> login. It does NOT validate the session; the portal
 * layouts do that through requireUser().
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (!hasCookie) {
    const url = request.nextUrl.clone();
    url.pathname = '/connexion';
    url.search = '';
    const next = safeNextPath(pathname + search, '');
    if (next) url.searchParams.set('next', next);
    const redirect = NextResponse.redirect(url);
    redirect.headers.set('Cache-Control', 'no-store');
    return redirect;
  }

  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, pathname + search);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = {
  matcher: ['/admin/:path*', '/manager/:path*', '/affiliate/:path*', '/compte/:path*'],
};
