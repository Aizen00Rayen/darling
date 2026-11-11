import { respond } from '@/server/admin/errors';
import { meAffiliate } from '@/server/commissions/queries';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'role', roles: ['affiliate'] } as const;

/** The signed-in influenceuse's own data: code and link, clicks, her orders (customer shown as "Prénom X."), commissions, payouts. */
export const GET = withAccess(access, ({ ctx, auth }) => respond(() => json(200, meAffiliate(ctx.db, auth.userId, ctx.config.appOrigin))));
