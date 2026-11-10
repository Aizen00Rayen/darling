import fp from 'fastify-plugin';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Clock } from '../lib/clock';
import { clearSessionCookie, sessionCookieName } from '../modules/auth/cookie';
import { loadPrincipal } from '../modules/auth/principal';
import { resolveSession } from '../modules/auth/sessions';
import type { AuthContext } from './access';

export type AuthPluginOptions = { config: Config; db: Db; clock: Clock };

/** A token we issued is exactly 43 base64url characters; anything else is not worth a query. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Sets `request.auth` on every request, in `onRequest` (access is enforced later, in
 * `preValidation`). The user, status, role and permissions are read from the database each time:
 * nothing about them lives in the session. A missing, malformed, expired or revoked session, or a
 * user who is not `active`, yields `null` (anonymous) and clears the stale cookie.
 */
export const authPlugin = fp<AuthPluginOptions>(
  async (app, { config, db, clock }) => {
    const cookieName = sessionCookieName(config);

    app.addHook('onRequest', async (request, reply) => {
      request.auth = null;
      const token = request.cookies[cookieName];
      if (token === undefined) return;

      let auth: AuthContext | null = null;
      if (TOKEN_SHAPE.test(token)) {
        const session = await resolveSession(db, token, clock());
        if (session) {
          const principal = await loadPrincipal(db, session.userId);
          if (principal) {
            auth = {
              sessionId: session.sessionId,
              userId: principal.userId,
              role: principal.role,
              isOwner: principal.isOwner,
              permissions: new Set(principal.permissions),
              mustEnroll2fa: principal.mustEnroll2fa,
            };
          }
        }
      }
      if (!auth) clearSessionCookie(reply, config);
      request.auth = auth;
    });
  },
  { name: 'darling-auth' },
);

export type { AuthContext } from './access';
