import { respond } from '@/server/admin/errors';
import { meTeam } from '@/server/commissions/queries';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'role', roles: ['sub_manager'] } as const;

/** The signed-in sous-manager's team: his influenceuses, the orders created under him (masked) and his OWN commissions. */
export const GET = withAccess(access, ({ ctx, auth }) => respond(() => json(200, meTeam(ctx.db, auth.userId))));
