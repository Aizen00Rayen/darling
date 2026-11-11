import { clearedSessionCookie } from '@/server/auth/cookie';
import { revokeSession } from '@/server/auth/sessions';
import { noContent, withAccess } from '@/server/security/access';

export const access = { kind: 'authenticated', allowDuring2faEnrollment: true } as const;

export const POST = withAccess(access, ({ ctx, auth }) => {
  revokeSession(ctx.db, auth.sessionId, ctx.clock.now());
  return noContent({ 'Set-Cookie': clearedSessionCookie(ctx.config) });
});
