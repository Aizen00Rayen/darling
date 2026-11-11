import { forgotPasswordInput } from '@/shared';
import { issueResetMail } from '@/server/auth/tokens';
import { runInBackground, sendMailInBackground } from '@/server/mail/outbox';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';
import { noContent, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'public' } as const;

export const POST = withAccess(access, async ({ request, ctx, ip }) => {
  const limited = rateLimited(ctx, LIMITS.forgot, ip);
  if (limited) return limited;
  const body = await parseBody(request, forgotPasswordInput);
  if (!body.ok) return body.response;

  // The answer never depends on the account, and nothing about the account (lookup, token, mail) happens before
  // the response is built: neither the body nor the response time says who exists. The work is deferred.
  const { email } = body.data;
  runInBackground('password_reset.start_failed', () => {
    const user = ctx.db.get<{ id: string; email: string; full_name: string; role: 'super_manager' | 'sub_manager' | 'affiliate' }>(
      "SELECT id, email, full_name, role FROM users WHERE email = ? AND status = 'active'",
      email,
    );
    if (!user) return;
    const mail = issueResetMail(ctx, ctx.db, { id: user.id, email: user.email, fullName: user.full_name, role: user.role });
    sendMailInBackground(ctx.mailer, mail);
  });
  return noContent();
});
