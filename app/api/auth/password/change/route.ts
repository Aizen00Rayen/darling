import { changePasswordInput } from '@/shared';
import { changePassword } from '@/server/auth/password';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';
import { json, noContent, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'authenticated', allowDuring2faEnrollment: true } as const;

export const POST = withAccess(access, async ({ request, ctx, auth, ip, requestId }) => {
  const limited = rateLimited(ctx, LIMITS.passwordVerify, `user:${auth.userId}`);
  if (limited) return limited;
  const body = await parseBody(request, changePasswordInput);
  if (!body.ok) return body.response;

  const result = await changePassword(ctx, { userId: auth.userId, sessionId: auth.sessionId, role: auth.role, ip, requestId }, body.data);
  switch (result.kind) {
    case 'ok':
      return noContent();
    case 'validation':
      return json(400, { code: 'validation', errors: result.errors });
    case 'conflict':
      return json(409, { code: 'conflict' });
    case 'invalid_credentials':
    case 'unauthenticated':
      return json(401, { code: result.kind });
  }
});
