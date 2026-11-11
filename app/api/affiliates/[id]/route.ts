import { respond } from '@/server/admin/errors';
import { getAffiliateDetail } from '@/server/commissions/queries';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'commissions.manage' } as const;

/** One influenceuse: stats, what a payout would be now, her commissions, orders (masked), clicks and payouts. 404 for anyone else. */
export const GET = withAccess<typeof access, { id: string }>(access, ({ ctx, params }) =>
  respond(() => json(200, getAffiliateDetail(ctx.db, params.id, ctx.config.appOrigin))),
);
