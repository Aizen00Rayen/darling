import type { FastifyReply } from 'fastify';
import type { Config } from '../../config';
import { REMEMBER_MS } from './sessions';

const NAME = 'dl_session';
/** The `__Host-` prefix makes browsers insist on Secure, Path=/ and no Domain. */
const SECURE_NAME = `__Host-${NAME}`;

export function sessionCookieName(config: Pick<Config, 'cookieSecure'>): string {
  return config.cookieSecure ? SECURE_NAME : NAME;
}

function attributes(config: Pick<Config, 'cookieSecure'>) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: config.cookieSecure,
  };
}

/** A "remember me" cookie lives 30 days; otherwise it is a session cookie (no Max-Age). */
export function setSessionCookie(
  reply: FastifyReply,
  config: Pick<Config, 'cookieSecure'>,
  token: string,
  remember: boolean,
): void {
  reply.setCookie(sessionCookieName(config), token, {
    ...attributes(config),
    ...(remember ? { maxAge: REMEMBER_MS / 1000 } : {}),
  });
}

/** Expires the cookie with the same name and attributes it was set with. */
export function clearSessionCookie(reply: FastifyReply, config: Pick<Config, 'cookieSecure'>): void {
  reply.clearCookie(sessionCookieName(config), attributes(config));
}
