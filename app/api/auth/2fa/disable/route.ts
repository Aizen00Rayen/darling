import { twoFactorDisableInput } from '@/shared';
import { disableTwoFactor } from '@/server/auth/two-factor';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';
import { json, noContent, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'authenticated', allowDuring2faEnrollment: true } as const;

export const POST = withAccess(access, async ({ request, ctx, auth, ip, requestId }) => {
  const limited = rateLimited(ctx, LIMITS.passwordVerify, `user:${auth.userId}`);
  if (limited) return limited;
  const body = await parseBody(request, twoFactorDisableInput);
  if (!body.ok) return body.response;

  const result = await disableTwoFactor(ctx, { userId: auth.userId, sessionId: auth.sessionId, role: auth.role, ip, requestId }, body.data);
  switch (result.kind) {
    case 'ok':
      return noContent();
    case 'role_required':
      return json(403, { code: '2fa_required_for_role' });
    case 'not_enabled':
      return json(409, { code: 'not_enabled' });
    case 'invalid_credentials':
    case 'unauthenticated':
      return json(401, { code: result.kind });
    case 'totp_invalid':
      return json(400, { code: 'totp_invalid' });
  }
});
