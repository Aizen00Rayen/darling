import { startTwoFactorSetup } from '@/server/auth/two-factor';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'authenticated', allowDuring2faEnrollment: true } as const;

/** The secret is shown once, in this response: json() already forbids caching it. */
export const POST = withAccess(access, ({ ctx, auth, ip, requestId }) => {
  const result = startTwoFactorSetup(ctx, { userId: auth.userId, sessionId: auth.sessionId, role: auth.role, ip, requestId });
  if (result.kind === 'unauthenticated') return json(401, { code: 'unauthenticated' });
  if (result.kind === 'already_enabled') return json(409, { code: 'already_enabled' });
  return json(200, { otpauthUrl: result.otpauthUrl, secret: result.secret });
});
