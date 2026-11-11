import { respond } from '@/server/admin/errors';
import { parseQuery } from '@/server/admin/query';
import { listCommissions } from '@/server/commissions/queries';
import { commissionsQuery } from '@/server/commissions/schemas';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'commissions.manage' } as const;

/** Commissions with their order and a MASKED customer name, filtered by status, beneficiary and order number. 50 a page, plus totals per status. */
export const GET = withAccess(access, ({ request, ctx }) =>
  respond(() => {
    const query = parseQuery(request, commissionsQuery);
    if (!query.ok) return query.response;
    return json(200, listCommissions(ctx.db, query.data));
  }),
);
