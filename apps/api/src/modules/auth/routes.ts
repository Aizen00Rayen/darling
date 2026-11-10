import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { apiErrorSchema, loginInput, meSchema } from '@darling/shared';
import type { AppDeps } from '../../app';
import { tooManyAttempts } from '../../plugins/errors';
import { clearSessionCookie, setSessionCookie } from './cookie';
import { attemptLogin } from './login';
import { loadPrincipal, toMe } from './principal';
import { recoveryRoutes } from './recovery';
import { revokeSession } from './sessions';
import { accountSecurityRoutes } from './two-factor';

const LOGIN_ATTEMPTS_PER_MINUTE = 5;

const loginResponse = z.object({ user: meSchema });

export async function authRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config, db, clock } = deps;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/api/auth/login',
    {
      config: {
        access: { kind: 'public' },
        rateLimit: {
          max: LOGIN_ATTEMPTS_PER_MINUTE,
          timeWindow: '1 minute',
          errorResponseBuilder: tooManyAttempts,
        },
      },
      schema: { body: loginInput, response: { 200: loginResponse, 401: apiErrorSchema } },
    },
    async (request, reply) => {
      const body = request.body;
      const outcome = await attemptLogin(
        { db, config, clock },
        {
          email: body.email,
          password: body.password,
          remember: body.remember === true,
          totpCode: body.totpCode,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          presentedSessionId: request.auth?.sessionId,
        },
      );
      if (outcome.kind !== 'ok') {
        // One body per outcome, nothing about the account: invalid_credentials covers an unknown
        // email, a wrong password, a lock and a suspended account alike.
        return reply.code(401).send({ code: outcome.kind });
      }
      setSessionCookie(reply, config, outcome.token, outcome.remember);
      return reply.code(200).send({ user: outcome.me });
    },
  );

  await app.register(accountSecurityRoutes, deps);
  await app.register(recoveryRoutes, deps);

  typed.post(
    '/api/auth/logout',
    {
      config: { access: { kind: 'authenticated', allowDuring2faEnrollment: true } },
    },
    async (request, reply) => {
      if (request.auth) await revokeSession(db, request.auth.sessionId, clock());
      clearSessionCookie(reply, config);
      return reply.code(204).send();
    },
  );

  typed.get(
    '/api/auth/me',
    {
      config: { access: { kind: 'authenticated', allowDuring2faEnrollment: true } },
      schema: { response: { 200: meSchema, 401: apiErrorSchema } },
    },
    async (request, reply) => {
      const principal = request.auth ? await loadPrincipal(db, request.auth.userId) : null;
      if (!principal) return reply.code(401).send({ code: 'unauthenticated' });
      return toMe(principal);
    },
  );
}
