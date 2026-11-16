import { dailyCsv, MONTH_PATTERN, ordersCsv } from '@/server/finance/reports';
import { authoriseFinance } from '@/server/inventory/stock';
import { respond, validation } from '@/server/admin/errors';
import { withAccess } from '@/server/security/access';
import { algiersDateString } from '@/server/util/algiers';

export const access = { GET: { kind: 'permission', permission: 'finance.read' } } as const;

/** GET ?month=YYYY-MM&kind=orders|daily : the month's orders with costs and profits, or day-by-day totals, as CSV. */
export const GET = withAccess(access.GET, ({ request, ctx, auth }) =>
  respond(() => {
    authoriseFinance(ctx.db, auth.userId);
    const url = new URL(request.url);
    const month = url.searchParams.get('month') ?? algiersDateString(ctx.clock.now()).slice(0, 7);
    if (!MONTH_PATTERN.test(month)) throw validation({ month: 'Mois invalide (AAAA-MM).' });
    const kind = url.searchParams.get('kind') === 'daily' ? 'daily' : 'orders';
    const body = kind === 'daily' ? dailyCsv(ctx.db, month) : ordersCsv(ctx.db, month);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="darling-${kind === 'daily' ? 'jours' : 'commandes'}-${month}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }),
);
