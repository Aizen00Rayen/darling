import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Notice, PageHeader, Table } from '@/ui';
import { ORDER_SOURCES, ORDER_STATUSES, type OrderListItem } from '@/shared';
import { z } from 'zod';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { Pager } from '@/components/portal/Pager';
import { apiServer } from '@/lib/api/server';
import { formatDateTime } from '@/lib/portal/format';
import { requireAdmin } from '@/lib/portal/guards';
import { apiMessage } from '@/lib/portal/messages';
import { formatPhone, orderSourceLabel, orderSourceTone, orderStatusLabel, orderStatusTone } from '@/lib/portal/orders';
import { buildHref, firstParam, parsePage } from '@/lib/portal/query';
import { formatMoney } from '@/lib/pricing';

export const metadata: Metadata = { title: 'Commandes — Darling', robots: { index: false } };

const PAGE_SIZE = 50;
const BASE = '/admin/commandes';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const listSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      status: z.enum(ORDER_STATUSES),
      source: z.enum(ORDER_SOURCES),
      customerName: z.string(),
      phone: z.string(),
      wilayaName: z.string(),
      total: z.number(),
      createdAt: z.string(),
    }),
  ),
  total: z.number(),
});

export default function OrdersPage(props: PageProps<'/admin/commandes'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

async function Content({ searchParams }: PageProps<'/admin/commandes'>) {
  const [me, sp] = await Promise.all([requireAdmin(), searchParams]);
  if (!me.permissions.includes('orders.read')) return <AccessDenied />;

  const status = ORDER_STATUSES.find((s) => s === firstParam(sp.status));
  const source = ORDER_SOURCES.find((s) => s === firstParam(sp.source));
  const dayOf = (v: string | string[] | undefined) => {
    const d = firstParam(v);
    return d && DAY.test(d) ? d : undefined;
  };
  const from = dayOf(sp.from);
  const to = dayOf(sp.to);
  const q = firstParam(sp.q)?.slice(0, 100);
  const page = parsePage(sp.page);

  const result = await apiServer<unknown>(buildHref('/api/orders', { status, source, from, to, q, page }));
  const parsed = result.ok ? listSchema.safeParse(result.data) : null;
  const filters = { status, source, from, to, q };
  const errorText = (r: Extract<typeof result, { ok: false }>) => (r.errors ? Object.values(r.errors)[0] : undefined) ?? apiMessage(r.code);

  return (
    <div className="p-stack">
      <PageHeader
        eyebrow="Administration"
        title="Commandes"
        actions={
          me.permissions.includes('orders.write') ? (
            <Link className="dl-btn dl-btn--primary" href={`${BASE}/nouvelle`}>
              Nouvelle commande
            </Link>
          ) : undefined
        }
      />

      <form className="p-filters glass" method="get" action={BASE} role="search" aria-label="Filtrer les commandes">
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="o-q">
            Recherche
          </label>
          <input id="o-q" type="search" name="q" defaultValue={q ?? ''} placeholder="Numéro, nom ou téléphone" maxLength={100} />
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="o-status">
            Statut
          </label>
          <select id="o-status" name="status" defaultValue={status ?? ''}>
            <option value="">Tous les statuts</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {orderStatusLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="o-source">
            Provenance
          </label>
          <select id="o-source" name="source" defaultValue={source ?? ''}>
            <option value="">Toutes les provenances</option>
            {ORDER_SOURCES.map((s) => (
              <option key={s} value={s}>
                {orderSourceLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="o-from">
            Du
          </label>
          <input id="o-from" type="date" name="from" defaultValue={from ?? ''} />
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="o-to">
            Au
          </label>
          <input id="o-to" type="date" name="to" defaultValue={to ?? ''} />
        </div>
        <div className="p-filters__actions">
          <button type="submit" className="dl-btn dl-btn--primary">
            Filtrer
          </button>
          <Link className="dl-btn dl-btn--ghost" href={BASE}>
            Réinitialiser
          </Link>
        </div>
      </form>

      {!result.ok ? (
        <Notice tone="error">{errorText(result)}</Notice>
      ) : !parsed?.success ? (
        <Notice tone="error">{apiMessage('generic')}</Notice>
      ) : (
        <>
          <Table<OrderListItem>
            rows={parsed.data.items}
            empty="Aucune commande ne correspond à ces critères."
            columns={[
              {
                key: 'number',
                header: 'Numéro',
                render: (o) => (
                  <Link className="p-linkbtn" href={`${BASE}/${o.id}`}>
                    {o.number}
                  </Link>
                ),
              },
              { key: 'date', header: 'Date', render: (o) => formatDateTime(o.createdAt) },
              { key: 'name', header: 'Cliente', render: (o) => o.customerName },
              { key: 'phone', header: 'Téléphone', hideBelow: 'sm', render: (o) => formatPhone(o.phone) },
              { key: 'wilaya', header: 'Wilaya', hideBelow: 'md', render: (o) => o.wilayaName },
              { key: 'total', header: 'Total', render: (o) => <span className="p-money">{formatMoney(o.total)}</span> },
              { key: 'source', header: 'Provenance', hideBelow: 'sm', render: (o) => <Badge tone={orderSourceTone(o.source)}>{orderSourceLabel(o.source)}</Badge> },
              { key: 'status', header: 'Statut', render: (o) => <Badge tone={orderStatusTone(o.status)}>{orderStatusLabel(o.status)}</Badge> },
            ]}
          />
          <Pager page={page} total={parsed.data.total} pageSize={PAGE_SIZE} hrefFor={(p) => buildHref(BASE, { ...filters, page: p })} />
        </>
      )}
    </div>
  );
}
