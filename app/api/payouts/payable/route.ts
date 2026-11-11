import { respond } from '@/server/admin/errors';
import { listPayable } from '@/server/commissions/queries';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'payouts.manage' } as const;

/** Everyone with something payable right now (validated, not held, netted against unsettled adjustments). */
export const GET = withAccess(access, ({ ctx }) => respond(() => json(200, { items: listPayable(ctx.db) })));
