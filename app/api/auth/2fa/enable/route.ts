import { twoFactorEnableInput } from '@/shared';
import { enableTwoFactor } from '@/server/auth/two-factor';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';
import { json, noContent, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'authenticated', allowDuring2faEnrollment: true } as const;

export const POST = withAccess(access, async ({ request, ctx, auth, ip, requestId }) => {
  const limited = rateLimited(ctx, LIMITS.passwordVerify, `user:${auth.userId}`);
  if (limited) return limited;
  const body = await parseBody(request, twoFactorEnableInput);
  if (!body.ok) return body.response;

  const result = await enableTwoFactor(ctx, { userId: auth.userId, sessionId: auth.sessionId, role: auth.role, ip, requestId }, body.data);
  if (result.kind === 'ok') return noContent();
  if (result.kind === 'already_enabled') return json(409, { code: 'already_enabled' });
  if (result.kind === 'invalid_credentials' || result.kind === 'unauthenticated') return json(401, { code: result.kind });
  return json(400, { code: result.kind });
});
