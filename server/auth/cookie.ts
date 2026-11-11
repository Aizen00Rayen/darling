import type { Config } from '../config';
import { REMEMBER_MS } from './sessions';

const NAME = 'dl_session';
/** The `__Host-` prefix makes browsers insist on Secure, Path=/ and no Domain. */
const SECURE_NAME = `__Host-${NAME}`;

type CookieConfig = Pick<Config, 'cookieSecure'>;

export function sessionCookieName(config: CookieConfig): string {
  return config.cookieSecure ? SECURE_NAME : NAME;
}

function attributes(config: CookieConfig): string {
  return `Path=/; HttpOnly; SameSite=Lax${config.cookieSecure ? '; Secure' : ''}`;
}

/** The Set-Cookie value of a new session. Max-Age only with "remember me" (otherwise a browser-session cookie). */
export function sessionCookie(config: CookieConfig, token: string, remember: boolean): string {
  return `${sessionCookieName(config)}=${token}; ${attributes(config)}${remember ? `; Max-Age=${REMEMBER_MS / 1000}` : ''}`;
}

/** Expires the cookie with the same name and attributes it was set with. */
export function clearedSessionCookie(config: CookieConfig): string {
  return `${sessionCookieName(config)}=; ${attributes(config)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** A token we issued is exactly 43 base64url characters; anything else is not worth a query. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The raw value of the session cookie in a Cookie header, or undefined when absent. Only the configured
 * cookie name counts (a plain `dl_session` is ignored when the `__Host-` name is in use). When the cookie
 * appears twice the first one wins, like browsers send them (most specific path first).
 */
export function readSessionCookie(cookieHeader: string | null | undefined, config: CookieConfig): string | undefined {
  if (!cookieHeader) return undefined;
  const name = sessionCookieName(config);
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
