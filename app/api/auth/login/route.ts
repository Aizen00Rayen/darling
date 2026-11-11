import { loginInput } from '@/shared';
import { sessionCookie } from '@/server/auth/cookie';
import { attemptLogin } from '@/server/auth/login';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'public' } as const;

export const POST = withAccess(access, async ({ request, ctx, ip, auth }) => {
  const limited = rateLimited(ctx, LIMITS.login, ip);
  if (limited) return limited;

  const body = await parseBody(request, loginInput);
  if (!body.ok) return body.response;

  const outcome = await attemptLogin(ctx, {
    email: body.data.email,
    password: body.data.password,
    remember: body.data.remember === true,
    totpCode: body.data.totpCode,
    ip,
    userAgent: request.headers.get('user-agent') ?? undefined,
    presentedSessionId: auth?.sessionId,
  });
  // One body per outcome, nothing about the account: invalid_credentials covers an unknown email, a wrong
  // password, a lock and a suspended account alike.
  if (outcome.kind !== 'ok') return json(401, { code: outcome.kind });
  return json(200, { user: outcome.me }, { 'Set-Cookie': sessionCookie(ctx.config, outcome.token, outcome.remember) });
});
