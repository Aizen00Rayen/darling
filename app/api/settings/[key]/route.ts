import { z } from 'zod';
import { respond } from '@/server/admin/errors';
import { updateSetting } from '@/server/admin/settings';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'settings.manage' } as const;

// The value is checked against the key's own schema in the service, after the key is known to exist.
const patchBody = z.object({ value: z.unknown() });

export const PATCH = withAccess<typeof access, { key: string }>(access, ({ request, ctx, auth, ip, requestId, params }) =>
  respond(async () => {
    const body = await parseBody(request, patchBody);
    if (!body.ok) return body.response;
    return json(200, updateSetting(ctx, { userId: auth.userId, ip, requestId }, params.key, body.data.value));
  }),
);
