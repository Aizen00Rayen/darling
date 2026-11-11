import { respond } from '@/server/admin/errors';
import { parseQuery } from '@/server/admin/query';
import { listAffiliates } from '@/server/commissions/queries';
import { affiliatesQuery } from '@/server/commissions/schemas';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'commissions.manage' } as const;

/** Influenceuses with code, manager, status, clicks, orders, delivered and commission totals. */
export const GET = withAccess(access, ({ request, ctx }) =>
  respond(() => {
    const query = parseQuery(request, affiliatesQuery);
    if (!query.ok) return query.response;
    return json(200, listAffiliates(ctx.db, query.data, ctx.config.appOrigin));
  }),
);
