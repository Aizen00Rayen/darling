import { respond } from '@/server/admin/errors';
import { readOverview } from '@/server/inventory/stock';
import { json, withAccess } from '@/server/security/access';

export const access = {
  GET: { kind: 'permission', permission: 'stock.write' },
} as const;

export const GET = withAccess(access.GET, ({ ctx }) => respond(() => json(200, readOverview(ctx.db))));
