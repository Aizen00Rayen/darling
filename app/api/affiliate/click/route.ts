import { z } from 'zod';
import { respond } from '@/server/admin/errors';
import { isBotAgent, recordClick, windowDays } from '@/server/affiliates/clicks';
import { refSetCookie } from '@/server/affiliates/ref';
import { AFFILIATE_CODE_PATTERN } from '@/shared';
import { noContent, parseBody, withAccess } from '@/server/security/access';
import { LIMITS, rateLimited } from '@/server/security/rate-limit';

export const access = { kind: 'public' } as const;

const body = z.object({
  code: z.string({ error: 'Code requis.' }).max(40, 'Code invalide.'),
  landingPath: z.string().max(300).optional(),
});

/**
 * An influenceuse's link was opened: records the click and sets the signed attribution cookie. Public (it still needs
 * the CSRF headers) and silent: an unknown, malformed or inactive code, a crawler and a repeat visitor all get the same
 * 204, and only a valid code gets a cookie, so the answer never tells which codes exist.
 * Budget: 60 an hour per client address (the shared 'unknown' bucket gets 4x). The address is only ever stored as an HMAC.
 */
export const POST = withAccess(access, ({ request, ctx, ip }) =>
  respond(async () => {
    const limited = rateLimited(ctx, LIMITS.affiliateClick, ip);
    if (limited) return limited;
    const parsed = await parseBody(request, body);
    if (!parsed.ok) return parsed.response;
    const { code, landingPath } = parsed.data;
    if (!AFFILIATE_CODE_PATTERN.test(code) || isBotAgent(request.headers.get('user-agent'))) return noContent();

    const click = recordClick(ctx, { code, ip, referer: request.headers.get('referer'), landingPath });
    if (!click) return noContent();
    return noContent({ 'Set-Cookie': refSetCookie(ctx.config, click.clickId, windowDays(ctx.db)) });
  }),
);
