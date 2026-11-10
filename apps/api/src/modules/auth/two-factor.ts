import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  apiErrorSchema,
  changePasswordInput,
  passwordProblem,
  twoFactorDisableInput,
  twoFactorEnableInput,
} from '@darling/shared';
import type { AppDeps } from '../../app';
import type { DbExecutor } from '../../db/client';
import { users } from '../../db/schema';
import {
  decryptSecret,
  DUMMY_HASH,
  encryptSecret,
  hashPassword,
  verifyPassword,
} from '../../lib/crypto';
import { newTotpSecret, totpUri, verifyTotp } from '../../lib/totp';
import { tooManyAttempts } from '../../plugins/errors';
import { recordAudit } from '../audit/service';
import { getSetting } from '../settings/service';
import { revokeUserSessions } from './sessions';

/** Every route that checks a password or a code: 5 a minute, counted per user, not per address. */
const VERIFICATIONS_PER_MINUTE = 5;

const SAME_PASSWORD_MESSAGE = 'Le nouveau mot de passe doit être différent de l’ancien.';

/** Who is asking, as the audit trail needs it. */
type Actor = { userId: string; sessionId: string; role: string; ip: string; requestId: string };

type Outcome<T extends string> = { kind: 'ok' } | { kind: T };
type FieldError = { kind: 'validation'; errors: Record<string, string> };

type Deps = Pick<AppDeps, 'config' | 'db' | 'clock'>;

function readSecret(enc: string | null, deps: Deps): string | null {
  if (enc === null) return null;
  try {
    return decryptSecret(enc, deps.config.encryptionKey);
  } catch {
    return null; // unreadable secret: fail closed
  }
}

/**
 * Checks `password` against the user's real hash. A user without a hash (not possible for an
 * authenticated user, but never assumed) is checked against the dummy hash so the cost is the same,
 * and never passes.
 */
async function passwordMatches(hash: string | null, password: string): Promise<boolean> {
  const ok = await verifyPassword(hash ?? DUMMY_HASH, password);
  return hash !== null && ok;
}

async function loadUser(db: DbExecutor, userId: string) {
  const [user] = await db
    .select({
      email: users.email,
      passwordHash: users.passwordHash,
      totpEnabled: users.totpEnabled,
      totpSecretEnc: users.totpSecretEnc,
      totpLastStep: users.totpLastStep,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ?? null;
}

async function isTotpEnabled(db: DbExecutor, userId: string): Promise<boolean> {
  const [row] = await db.select({ enabled: users.totpEnabled }).from(users).where(eq(users.id, userId));
  return row?.enabled === true;
}

/**
 * Starts (or restarts) enrolment: a fresh secret each time, stored encrypted and not yet active.
 * The plaintext leaves only in this return value. Refused once 2FA is on.
 */
export async function startTwoFactorSetup(
  deps: Deps,
  actor: Actor,
): Promise<
  { kind: 'ok'; secret: string; otpauthUrl: string } | { kind: 'already_enabled' } | { kind: 'unauthenticated' }
> {
  const { db, config, clock } = deps;
  const user = await loadUser(db, actor.userId);
  if (!user) return { kind: 'unauthenticated' };
  if (user.totpEnabled) return { kind: 'already_enabled' };

  const secret = newTotpSecret();
  // The guard keeps a setup that races with a successful enable from replacing the live secret.
  const updated = await db
    .update(users)
    .set({
      totpSecretEnc: encryptSecret(secret, config.encryptionKey),
      totpLastStep: null,
      updatedAt: clock(),
    })
    .where(and(eq(users.id, actor.userId), eq(users.totpEnabled, false)))
    .returning({ id: users.id });
  if (updated.length === 0) return { kind: 'already_enabled' };
  return { kind: 'ok', secret, otpauthUrl: totpUri(secret, user.email) };
}

/**
 * Turns 2FA on when `code` matches the pending secret. The matched step is stored in the same
 * statement, so the code cannot also be used at login; the statement is guarded on the secret that
 * was verified, so a parallel setup or enable cannot make a different secret go live.
 */
export async function enableTwoFactor(
  deps: Deps,
  actor: Actor,
  code: string,
): Promise<Outcome<'already_enabled' | 'no_pending_setup' | 'totp_invalid' | 'unauthenticated'>> {
  const { db, clock } = deps;
  const now = clock();
  const user = await loadUser(db, actor.userId);
  if (!user) return { kind: 'unauthenticated' };
  if (user.totpEnabled) return { kind: 'already_enabled' };
  if (user.totpSecretEnc === null) return { kind: 'no_pending_setup' };

  const secret = readSecret(user.totpSecretEnc, deps);
  const step = secret === null ? null : verifyTotp(secret, code, now, user.totpLastStep);
  if (step === null) return { kind: 'totp_invalid' };

  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(users)
      .set({ totpEnabled: true, totpLastStep: step, updatedAt: now })
      .where(
        and(
          eq(users.id, actor.userId),
          eq(users.totpEnabled, false),
          eq(users.totpSecretEnc, user.totpSecretEnc as string),
          or(isNull(users.totpLastStep), lt(users.totpLastStep, step)),
        ),
      )
      .returning({ id: users.id });
    if (claimed.length === 0) {
      return { kind: (await isTotpEnabled(tx, actor.userId)) ? 'already_enabled' : 'totp_invalid' } as const;
    }
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'auth.2fa_enabled',
      entityType: 'user',
      entityId: actor.userId,
      before: { twoFactorEnabled: false },
      after: { twoFactorEnabled: true },
      ip: actor.ip,
      requestId: actor.requestId,
    });
    return { kind: 'ok' } as const;
  });
}

/**
 * Turns 2FA off. A Super Manager cannot while the requirement setting is on; that answer comes
 * first, before any credential is looked at, so it does not depend on them. Otherwise both the
 * current password and a code that is newer than the last step used (login or enable) are needed.
 */
export async function disableTwoFactor(
  deps: Deps,
  actor: Actor,
  input: { password: string; code: string },
): Promise<
  Outcome<'role_required' | 'not_enabled' | 'invalid_credentials' | 'totp_invalid' | 'unauthenticated'>
> {
  const { db, clock } = deps;
  const now = clock();

  if (actor.role === 'super_manager' && (await getSetting(db, 'security.require_2fa_super_managers'))) {
    return { kind: 'role_required' };
  }
  const user = await loadUser(db, actor.userId);
  if (!user) return { kind: 'unauthenticated' };
  if (!user.totpEnabled) return { kind: 'not_enabled' };

  if (!(await passwordMatches(user.passwordHash, input.password))) return { kind: 'invalid_credentials' };

  const secret = readSecret(user.totpSecretEnc, deps);
  const step = secret === null ? null : verifyTotp(secret, input.code, now, user.totpLastStep);
  if (step === null) return { kind: 'totp_invalid' };

  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(users)
      .set({ totpEnabled: false, totpSecretEnc: null, totpLastStep: null, updatedAt: now })
      .where(
        and(
          eq(users.id, actor.userId),
          eq(users.totpEnabled, true),
          eq(users.totpSecretEnc, user.totpSecretEnc as string),
          or(isNull(users.totpLastStep), lt(users.totpLastStep, step)),
        ),
      )
      .returning({ id: users.id });
    if (claimed.length === 0) {
      return { kind: (await isTotpEnabled(tx, actor.userId)) ? 'totp_invalid' : 'not_enabled' } as const;
    }
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'auth.2fa_disabled',
      entityType: 'user',
      entityId: actor.userId,
      before: { twoFactorEnabled: true },
      after: { twoFactorEnabled: false },
      ip: actor.ip,
      requestId: actor.requestId,
    });
    return { kind: 'ok' } as const;
  });
}

/**
 * Replaces the password after checking the current one, ends every OTHER session of the user and
 * keeps the caller's. The hash is swapped only if it is still the one that was verified, so two
 * parallel changes cannot both win.
 */
export async function changePassword(
  deps: Deps,
  actor: Actor,
  input: { currentPassword: string; newPassword: string },
): Promise<Outcome<'invalid_credentials' | 'conflict' | 'unauthenticated'> | FieldError> {
  const { db, clock } = deps;
  const now = clock();
  const user = await loadUser(db, actor.userId);
  if (!user) return { kind: 'unauthenticated' };

  if (!(await passwordMatches(user.passwordHash, input.currentPassword))) {
    return { kind: 'invalid_credentials' };
  }
  const problem = passwordProblem(input.newPassword);
  if (problem !== null) return { kind: 'validation', errors: { newPassword: problem } };
  if (input.newPassword === input.currentPassword) {
    return { kind: 'validation', errors: { newPassword: SAME_PASSWORD_MESSAGE } };
  }

  const newHash = await hashPassword(input.newPassword);
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(users)
      .set({ passwordHash: newHash, updatedAt: now })
      .where(and(eq(users.id, actor.userId), eq(users.passwordHash, user.passwordHash as string)))
      .returning({ id: users.id });
    if (claimed.length === 0) return { kind: 'conflict' } as const;
    await revokeUserSessions(tx, actor.userId, actor.sessionId, now);
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: actor.userId,
      after: { passwordChanged: true },
      ip: actor.ip,
      requestId: actor.requestId,
    });
    return { kind: 'ok' } as const;
  });
}

function actorOf(request: FastifyRequest): Actor | null {
  const auth = request.auth;
  if (!auth) return null;
  return { userId: auth.userId, sessionId: auth.sessionId, role: auth.role, ip: request.ip, requestId: request.id };
}

/** The key for the brute-force limit: the authenticated user, so a stolen session gets 5 tries a minute in total. */
function limitKey(request: FastifyRequest): string {
  return request.auth ? `user:${request.auth.userId}` : `ip:${request.ip}`;
}

const verifyingRoute = {
  access: { kind: 'authenticated', allowDuring2faEnrollment: true },
  rateLimit: {
    max: VERIFICATIONS_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: limitKey,
    errorResponseBuilder: tooManyAttempts,
  },
} as const;

const setupResponse = z.object({ otpauthUrl: z.string(), secret: z.string() });
const errorResponses = { 204: z.undefined(), 400: apiErrorSchema, 401: apiErrorSchema, 403: apiErrorSchema, 409: apiErrorSchema };

/** Two-factor enrolment, 2FA removal and password change for the signed-in user. */
export async function accountSecurityRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config, db, clock } = deps;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service: Deps = { config, db, clock };

  typed.post(
    '/api/auth/2fa/setup',
    {
      config: { access: { kind: 'authenticated', allowDuring2faEnrollment: true } },
      schema: { response: { 200: setupResponse, ...errorResponses } },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: 'unauthenticated' });
      const result = await startTwoFactorSetup(service, actor);
      // The secret is shown once: nothing may keep a copy of this response.
      reply.header('cache-control', 'no-store');
      if (result.kind === 'unauthenticated') return reply.code(401).send({ code: 'unauthenticated' });
      if (result.kind === 'already_enabled') return reply.code(409).send({ code: 'already_enabled' });
      return reply.code(200).send({ otpauthUrl: result.otpauthUrl, secret: result.secret });
    },
  );

  typed.post(
    '/api/auth/2fa/enable',
    { config: verifyingRoute, schema: { body: twoFactorEnableInput, response: errorResponses } },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: 'unauthenticated' });
      const result = await enableTwoFactor(service, actor, request.body.code);
      if (result.kind === 'ok') return reply.code(204).send();
      if (result.kind === 'already_enabled') return reply.code(409).send({ code: 'already_enabled' });
      if (result.kind === 'unauthenticated') return reply.code(401).send({ code: 'unauthenticated' });
      return reply.code(400).send({ code: result.kind });
    },
  );

  typed.post(
    '/api/auth/2fa/disable',
    { config: verifyingRoute, schema: { body: twoFactorDisableInput, response: errorResponses } },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: 'unauthenticated' });
      const result = await disableTwoFactor(service, actor, request.body);
      switch (result.kind) {
        case 'ok':
          return reply.code(204).send();
        case 'role_required':
          return reply.code(403).send({ code: '2fa_required_for_role' });
        case 'not_enabled':
          return reply.code(409).send({ code: 'not_enabled' });
        case 'invalid_credentials':
        case 'unauthenticated':
          return reply.code(401).send({ code: result.kind });
        case 'totp_invalid':
          return reply.code(400).send({ code: 'totp_invalid' });
      }
    },
  );

  typed.post(
    '/api/auth/password/change',
    { config: verifyingRoute, schema: { body: changePasswordInput, response: errorResponses } },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: 'unauthenticated' });
      const result = await changePassword(service, actor, request.body);
      switch (result.kind) {
        case 'ok':
          return reply.code(204).send();
        case 'validation':
          return reply.code(400).send({ code: 'validation', errors: result.errors });
        case 'conflict':
          return reply.code(409).send({ code: 'conflict' });
        case 'invalid_credentials':
        case 'unauthenticated':
          return reply.code(401).send({ code: result.kind });
      }
    },
  );
}
