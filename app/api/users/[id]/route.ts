import { z } from 'zod';
import { updateUserInput } from '@/shared';
import { respond } from '@/server/admin/errors';
import { getUser, updateUser } from '@/server/admin/users';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'users.manage' } as const;

const reasonField = z
  .string()
  .trim()
  .max(500, 'Le motif est trop long (500 caractères maximum).')
  .transform((value) => (value === '' ? undefined : value))
  .optional();
const updateBody = updateUserInput.extend({ reason: reasonField });

export const GET = withAccess<typeof access, { id: string }>(access, ({ ctx, params }) => respond(() => json(200, getUser(ctx.db, params.id))));

export const PATCH = withAccess<typeof access, { id: string }>(access, ({ request, ctx, auth, ip, requestId, params }) =>
  respond(async () => {
    const body = await parseBody(request, updateBody);
    if (!body.ok) return body.response;
    return json(200, updateUser(ctx, { userId: auth.userId, ip, requestId }, params.id, body.data));
  }),
);
