import { passwordProblem, setupInput } from '@/shared';
import { respond } from '@/server/admin/errors';
import { setupAvailable, setupFirstOwner, tokenMatches } from '@/server/admin/first-owner';
import { log } from '@/server/log';
import { hashPassword } from '@/server/security/crypto';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';
import { json, noContent, parseBody, validationFailed, withAccess } from '@/server/security/access';

export const access = { kind: 'public' } as const;

/**
 * One-time creation of the first owner. Answers 404 (the same as any unknown route) unless SETUP_TOKEN is set AND
 * the users table is empty; afterwards the rate limit (5 per 15 minutes per address) applies to every attempt.
 * The token is compared in constant time and is never logged or echoed.
 */
export const POST = withAccess(access, ({ request, ctx, ip, requestId }) =>
  respond(async () => {
    if (!setupAvailable(ctx)) return json(404, { code: 'not_found' });
    const limited = rateLimited(ctx, LIMITS.setup, ip);
    if (limited) return limited;
    const body = await parseBody(request, setupInput);
    if (!body.ok) return body.response;

    // Checked before the password policy: a caller without the token learns nothing else about the form.
    if (!tokenMatches(body.data.token, ctx.config.setupToken as string)) {
      log.warn('setup.bad_token');
      return json(403, { code: 'invalid_setup_token' });
    }
    const problem = passwordProblem(body.data.password);
    if (problem !== null) return validationFailed({ password: problem });

    const passwordHash = await hashPassword(body.data.password);
    const { userId } = setupFirstOwner(ctx, { email: body.data.email, fullName: body.data.fullName, passwordHash, ip, requestId });
    log.info('setup.owner_created', { userId });
    return noContent();
  }),
);
