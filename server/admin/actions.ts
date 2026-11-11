import { z } from 'zod';
import { noContent, parseBody, type ParsedBody } from '../http';
import type { HandlerArgs } from '../security/access';
import { respond } from './errors';
import type { ActionInput, Actor, UsersDeps } from './users';

const actionBody = z
  .object({
    reason: z
      .string()
      .trim()
      .max(500, 'Le motif est trop long (500 caractères maximum).')
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
  })
  .nullish();

/** The optional `{ reason }` body of an action route; an empty body is fine. Read only after the access decision. */
export async function readReason(request: Request): Promise<ParsedBody<string | undefined>> {
  const body = await parseBody(request, actionBody, { allowEmpty: true });
  return body.ok ? { ok: true, data: body.data?.reason } : body;
}

type Args = HandlerArgs<{ id: string }, { kind: 'permission'; permission: 'users.manage' }>;

/** Shared body of the POST /api/users/[id]/<verb> routes that answer 204. */
export function userAction(run: (deps: UsersDeps, actor: Actor, id: string, input: ActionInput) => void) {
  return ({ request, ctx, auth, ip, requestId, params }: Args): Promise<Response> =>
    respond(async () => {
      const reason = await readReason(request);
      if (!reason.ok) return reason.response;
      run(ctx, { userId: auth.userId, ip, requestId }, params.id, { reason: reason.data });
      return noContent();
    });
}
