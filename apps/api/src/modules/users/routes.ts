import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { apiErrorSchema, createUserInput, ROLES, updateUserInput, USER_STATUSES, userSchema } from '@darling/shared';
import type { AppDeps } from '../../app';
import {
  createUser,
  getUser,
  listUsers,
  reactivateUser,
  resendInvite,
  revokeSessions,
  suspendUser,
  updateUser,
  type Actor,
} from './service';

const idParams = z.object({ id: z.string() });

const reasonField = z
  .string()
  .trim()
  .max(500, 'Le motif est trop long (500 caractères maximum).')
  .transform((value) => (value === '' ? undefined : value))
  .optional();
const actionBody = z.object({ reason: reasonField }).nullish();
const updateBody = updateUserInput.extend({ reason: reasonField });

const listQuery = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});
const listResponse = z.object({ items: z.array(userSchema), total: z.number() });

const ACCESS = { kind: 'permission', permission: 'users.manage' } as const;

function actorOf(request: FastifyRequest): Actor {
  const auth = request.auth;
  // The access plugin has already refused anonymous callers; this keeps the types honest.
  if (!auth) throw new Error('users route reached without a session');
  return { userId: auth.userId, isOwner: auth.isOwner, ip: request.ip, requestId: request.id };
}

/** User management: every route needs `users.manage`; the owner rules live in the service. */
export async function userRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/users',
    { config: { access: ACCESS }, schema: { querystring: listQuery, response: { 200: listResponse } } },
    async (request) => listUsers(deps.db, request.query),
  );

  typed.post(
    '/api/users',
    { config: { access: ACCESS }, schema: { body: createUserInput, response: { 201: userSchema } } },
    async (request, reply) => {
      const user = await createUser(deps, actorOf(request), request.body, request.log);
      return reply.code(201).send(user);
    },
  );

  typed.get(
    '/api/users/:id',
    { config: { access: ACCESS }, schema: { params: idParams, response: { 200: userSchema } } },
    async (request) => getUser(deps.db, request.params.id),
  );

  typed.patch(
    '/api/users/:id',
    {
      config: { access: ACCESS },
      schema: { params: idParams, body: updateBody, response: { 200: userSchema } },
    },
    async (request) => updateUser(deps, actorOf(request), request.params.id, request.body, request.log),
  );

  const noContent = { 204: z.undefined() };
  const actions = [
    ['suspend', suspendUser],
    ['reactivate', reactivateUser],
    ['revoke-sessions', revokeSessions],
  ] as const;
  for (const [verb, run] of actions) {
    typed.post(
      `/api/users/:id/${verb}`,
      { config: { access: ACCESS }, schema: { params: idParams, body: actionBody, response: noContent } },
      async (request, reply) => {
        await run(deps, actorOf(request), request.params.id, request.body ?? {}, request.log);
        return reply.code(204).send();
      },
    );
  }

  typed.post(
    '/api/users/:id/resend-invite',
    {
      config: { access: ACCESS },
      schema: { params: idParams, body: actionBody, response: { ...noContent, 502: apiErrorSchema } },
    },
    async (request, reply) => {
      const sent = await resendInvite(deps, actorOf(request), request.params.id, request.body ?? {}, request.log);
      // The mail transport refused: the invitation link was renewed but nobody received it.
      if (!sent) return reply.code(502).send({ code: 'mail_failed' });
      return reply.code(204).send(undefined);
    },
  );
}
