import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  apiErrorSchema,
  forgotPasswordInput,
  inviteAcceptInput,
  passwordProblem,
  passwordResetInput,
} from '@darling/shared';
import type { AppDeps } from '../../app';
import { users } from '../../db/schema';
import { hashPassword } from '../../lib/crypto';
import { tooManyAttempts } from '../../plugins/errors';
import { recordAudit } from '../audit/service';
import { revokeUserSessions } from './sessions';
import { consumeToken, invalidateTokens, peekToken, sendPasswordReset } from './tokens';

/** Invitation lookup, invitation acceptance and password reset share one budget per address. */
const TOKEN_REQUESTS_PER_WINDOW = 10;
const FORGOT_REQUESTS_PER_WINDOW = 5;
const RATE_WINDOW = '15 minutes';

type Service = Pick<AppDeps, 'db' | 'clock'> & {
  /** Test seam: runs once the token and the password have been checked, just before the transaction. */
  afterChecks?: () => Promise<void>;
};

type Request = { token: string; password: string; ip: string; requestId: string };
type Outcome = { kind: 'ok' } | { kind: 'invalid_token' } | { kind: 'validation'; errors: Record<string, string> };

/** Thrown inside a transaction to roll it back, token consumption included. */
class Refused extends Error {}

/**
 * Sets the first password of an invited user. The token is checked without being spent, then the
 * password policy, so a weak password does not burn the link. The token is finally spent in the same
 * transaction that activates the account, and only an `invited` user can be activated: if anything
 * refuses, the whole transaction rolls back and the token stays usable.
 */
export async function acceptInvite(deps: Service, req: Request): Promise<Outcome> {
  const { db, clock } = deps;
  const now = clock();
  const found = await peekToken(db, { token: req.token, type: 'invite', now });
  if (!found || found.status !== 'invited') return { kind: 'invalid_token' };

  const problem = passwordProblem(req.password);
  if (problem !== null) return { kind: 'validation', errors: { password: problem } };
  const passwordHash = await hashPassword(req.password);
  await deps.afterChecks?.();

  try {
    await db.transaction(async (tx) => {
      const consumed = await consumeToken(tx, { token: req.token, type: 'invite', now });
      if (!consumed) throw new Refused();
      const [activated] = await tx
        .update(users)
        .set({ passwordHash, status: 'active', failedLogins: 0, lockedUntil: null, updatedAt: now })
        .where(and(eq(users.id, consumed.userId), eq(users.status, 'invited')))
        .returning({ id: users.id });
      if (!activated) throw new Refused();
      await recordAudit(tx, {
        actorUserId: activated.id,
        action: 'auth.invite_accepted',
        entityType: 'user',
        entityId: activated.id,
        before: { status: 'invited' },
        after: { status: 'active' },
        ip: req.ip,
        requestId: req.requestId,
      });
    });
  } catch (err) {
    if (err instanceof Refused) return { kind: 'invalid_token' };
    throw err;
  }
  return { kind: 'ok' };
}

/**
 * Replaces the password of an ACTIVE user from a reset link, ends all their sessions and clears a
 * lockout. Same shape as `acceptInvite`; a user suspended after the mail was sent is refused and
 * stays suspended. Two-factor is left exactly as it was.
 */
export async function resetPassword(deps: Service, req: Request): Promise<Outcome> {
  const { db, clock } = deps;
  const now = clock();
  const found = await peekToken(db, { token: req.token, type: 'password_reset', now });
  if (!found || found.status !== 'active') return { kind: 'invalid_token' };

  const problem = passwordProblem(req.password);
  if (problem !== null) return { kind: 'validation', errors: { password: problem } };
  const passwordHash = await hashPassword(req.password);
  await deps.afterChecks?.();

  try {
    await db.transaction(async (tx) => {
      const consumed = await consumeToken(tx, { token: req.token, type: 'password_reset', now });
      if (!consumed) throw new Refused();
      const [updated] = await tx
        .update(users)
        .set({ passwordHash, failedLogins: 0, lockedUntil: null, updatedAt: now })
        .where(and(eq(users.id, consumed.userId), eq(users.status, 'active')))
        .returning({ id: users.id });
      if (!updated) throw new Refused();
      await revokeUserSessions(tx, updated.id, undefined, now);
      await invalidateTokens(tx, { userId: updated.id, type: 'password_reset', now });
      await recordAudit(tx, {
        actorUserId: updated.id,
        action: 'auth.password_reset',
        entityType: 'user',
        entityId: updated.id,
        after: { passwordReset: true },
        ip: req.ip,
        requestId: req.requestId,
      });
    });
  } catch (err) {
    if (err instanceof Refused) return { kind: 'invalid_token' };
    throw err;
  }
  return { kind: 'ok' };
}

/** Mails still being sent after their request was answered; `onClose` and the tests wait for them. */
const pendingBackground = new Set<Promise<void>>();

/** Resolves once every reset mail started so far has been sent or has failed. Tests use it. */
export async function settleBackgroundWork(): Promise<void> {
  while (pendingBackground.size > 0) await Promise.allSettled([...pendingBackground]);
}

const noContent = { 204: z.undefined(), 400: apiErrorSchema, 404: apiErrorSchema };
const invitationResponse = z.object({ email: z.string(), fullName: z.string() });

/** Invitation lookup and acceptance, "forgot password" and password reset. All public. */
export async function recoveryRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, clock } = deps;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service: Service = { db, clock };

  // One instance per budget, so one store each: the three token routes draw on the same
  // per-address count, and "forgot" has a count of its own.
  const tokenLimit = app.rateLimit({
    max: TOKEN_REQUESTS_PER_WINDOW,
    timeWindow: RATE_WINDOW,
    errorResponseBuilder: tooManyAttempts,
  });
  const forgotLimit = app.rateLimit({
    max: FORGOT_REQUESTS_PER_WINDOW,
    timeWindow: RATE_WINDOW,
    errorResponseBuilder: tooManyAttempts,
  });

  app.addHook('onClose', async () => {
    await settleBackgroundWork();
  });

  typed.get(
    '/api/auth/invite/:token',
    {
      config: { access: { kind: 'public' } },
      onRequest: tokenLimit,
      schema: { response: { 200: invitationResponse, 404: apiErrorSchema } },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      reply.header('cache-control', 'no-store');
      const found = await peekToken(db, { token, type: 'invite', now: clock() });
      // Unknown, used, expired, wrong type and a user who is not `invited` look the same.
      if (!found || found.status !== 'invited') return reply.code(404).send({ code: 'not_found' });
      return reply.code(200).send({ email: found.email, fullName: found.fullName });
    },
  );

  typed.post(
    '/api/auth/invite/accept',
    {
      config: { access: { kind: 'public' } },
      onRequest: tokenLimit,
      schema: { body: inviteAcceptInput, response: noContent },
    },
    async (request, reply) => {
      const outcome = await acceptInvite(service, {
        token: request.body.token,
        password: request.body.password,
        ip: request.ip,
        requestId: request.id,
      });
      reply.header('cache-control', 'no-store');
      if (outcome.kind === 'ok') return reply.code(204).send();
      if (outcome.kind === 'validation') return reply.code(400).send({ code: 'validation', errors: outcome.errors });
      return reply.code(400).send({ code: 'invalid_token' });
    },
  );

  typed.post(
    '/api/auth/password/forgot',
    {
      config: { access: { kind: 'public' } },
      onRequest: forgotLimit,
      schema: { body: forgotPasswordInput, response: { 204: z.undefined(), 400: apiErrorSchema } },
    },
    async (request, reply) => {
      const { email } = request.body;
      reply.header('cache-control', 'no-store');
      // The answer never depends on the account, and nothing about the account (lookup, token,
      // mail) happens before it is sent: neither the body nor the response time says who exists.
      reply.code(204).send();

      const work: Promise<void> = (async () => {
        const [user] = await db
          .select({ id: users.id, email: users.email, fullName: users.fullName, role: users.role })
          .from(users)
          .where(and(eq(users.email, email), eq(users.status, 'active')))
          .limit(1);
        if (user) await sendPasswordReset(deps, user);
      })()
        .catch((err: unknown) => {
          // No address, no token: only what kind of failure this was.
          const code = (err as { code?: unknown } | null)?.code;
          app.log.error(
            { errName: err instanceof Error ? err.name : 'unknown', errCode: typeof code === 'string' ? code : undefined },
            'password reset could not be started or mailed',
          );
        })
        .finally(() => pendingBackground.delete(work));
      pendingBackground.add(work);
      return reply;
    },
  );

  typed.post(
    '/api/auth/password/reset',
    {
      config: { access: { kind: 'public' } },
      onRequest: tokenLimit,
      schema: { body: passwordResetInput, response: noContent },
    },
    async (request, reply) => {
      const outcome = await resetPassword(service, {
        token: request.body.token,
        password: request.body.password,
        ip: request.ip,
        requestId: request.id,
      });
      reply.header('cache-control', 'no-store');
      if (outcome.kind === 'ok') return reply.code(204).send();
      if (outcome.kind === 'validation') return reply.code(400).send({ code: 'validation', errors: outcome.errors });
      return reply.code(400).send({ code: 'invalid_token' });
    },
  );
}
