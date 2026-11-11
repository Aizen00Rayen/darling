import { respond } from '@/server/admin/errors';
import { parseQuery } from '@/server/admin/query';
import { createPayout, listPayouts } from '@/server/commissions/payouts';
import { payoutBody, payoutsQuery } from '@/server/commissions/schemas';
import { json, parseBody, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'payouts.manage' } as const;

export const GET = withAccess(access, ({ request, ctx }) =>
  respond(() => {
    const query = parseQuery(request, payoutsQuery);
    if (!query.ok) return query.response;
    return json(200, listPayouts(ctx.db, query.data));
  }),
);

/**
 * `{ beneficiaryUserId, method, reference?, paidAt, note? }`: pays everything payable to that person in one transaction.
 * 409 `nothing_to_pay` when there is nothing (left) to pay, which is also what a double click gets.
 */
export const POST = withAccess(access, ({ request, ctx, auth, ip, requestId }) =>
  respond(async () => {
    const body = await parseBody(request, payoutBody);
    if (!body.ok) return body.response;
    return json(201, createPayout(ctx, { userId: auth.userId, ip, requestId }, body.data));
  }),
);
