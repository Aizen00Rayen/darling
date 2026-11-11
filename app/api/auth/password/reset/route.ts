import { passwordResetInput } from '@/shared';
import { resetPassword } from '@/server/auth/recovery';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';
import { json, noContent, parseBody, validationFailed, withAccess } from '@/server/security/access';

export const access = { kind: 'public' } as const;

export const POST = withAccess(access, async ({ request, ctx, ip, requestId }) => {
  const limited = rateLimited(ctx, LIMITS.token, ip);
  if (limited) return limited;
  const body = await parseBody(request, passwordResetInput);
  if (!body.ok) return body.response;

  const outcome = await resetPassword(ctx, { token: body.data.token, password: body.data.password, ip, requestId });
  if (outcome.kind === 'ok') return noContent();
  if (outcome.kind === 'validation') return validationFailed(outcome.errors);
  return json(400, { code: 'invalid_token' });
});
