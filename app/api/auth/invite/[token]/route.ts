import { lookupInvitation } from '@/server/auth/recovery';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'public' } as const;

export const GET = withAccess<typeof access, { token: string }>(access, ({ ctx, ip, params }) => {
  const limited = rateLimited(ctx, LIMITS.token, ip);
  if (limited) return limited;
  // Unknown, used, expired, wrong type and a user who is not `invited` look the same.
  const found = lookupInvitation(ctx, params.token);
  if (!found) return json(404, { code: 'not_found' });
  return json(200, found);
});
