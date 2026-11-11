import { recordAudit } from '@/server/audit';
import { log } from '@/server/log';
import { testMail } from '@/server/mail/templates';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'owner' } as const;

/** Sends a test e-mail to the owner's OWN address (3 an hour), so SMTP settings can be checked from the browser. */
export const POST = withAccess(access, async ({ ctx, auth, ip, requestId }) => {
  const limited = rateLimited(ctx, LIMITS.testMail, `user:${auth.userId}`);
  if (limited) return limited;
  if (ctx.config.isProduction && !ctx.config.smtpUrl) return json(409, { code: 'smtp_not_configured' });

  const audit = (action: string, reason?: string) =>
    recordAudit(ctx.db, { actorUserId: auth.userId, action, entityType: 'diagnostics', entityId: 'test-mail', reason, ip, requestId, at: ctx.clock.now() });
  try {
    await ctx.mailer.send({ to: auth.email, ...testMail({ fullName: auth.fullName, origin: ctx.config.appOrigin }) });
  } catch (err) {
    // Only the error kind and code go out (e.g. EAUTH, ECONNECTION): SMTP messages can contain addresses and hosts.
    const code = (err as { code?: unknown } | null)?.code;
    const reason = typeof code === 'string' && /^[A-Z0-9_]{3,40}$/.test(code) ? code : 'UNKNOWN';
    log.error('diagnostics.test_mail_failed', { errName: err instanceof Error ? err.name : 'unknown', errCode: reason });
    audit('diagnostics.test_mail_failed', reason);
    return json(502, { code: 'mail_failed', reason });
  }
  audit('diagnostics.test_mail_sent');
  return json(200, { ok: true, to: auth.email });
});
