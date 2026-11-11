import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Notice, PageHeader, Table } from '@/ui';
import { USER_STATUSES, type AdminAffiliateRow } from '@/shared';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { CopyField } from '@/components/portal/CopyField';
import { Pager } from '@/components/portal/Pager';
import { apiServer } from '@/lib/api/server';
import { requireAdmin } from '@/lib/portal/guards';
import { statusLabel, statusTone } from '@/lib/portal/labels';
import { isList } from '@/lib/portal/lists';
import { apiMessage } from '@/lib/portal/messages';
import { buildHref, firstParam, parsePage } from '@/lib/portal/query';
import { formatMoney } from '@/lib/pricing';

export const metadata: Metadata = { title: 'Influenceuses — Darling', robots: { index: false } };

const PAGE_SIZE = 50;
const BASE = '/admin/influenceuses';

export default function AffiliatesPage(props: PageProps<'/admin/influenceuses'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

async function Content({ searchParams }: PageProps<'/admin/influenceuses'>) {
  const [me, sp] = await Promise.all([requireAdmin(), searchParams]);
  if (!me.permissions.includes('commissions.manage')) return <AccessDenied />;

  const status = USER_STATUSES.find((s) => s === firstParam(sp.status));
  const q = firstParam(sp.q)?.slice(0, 100);
  const page = parsePage(sp.page);
  const result = await apiServer<unknown>(buildHref('/api/affiliates', { q, status, page }));

  return (
    <div className="p-stack">
      <PageHeader eyebrow="Administration" title="Influenceuses" />
      <p className="p-lead">Chaque influenceuse a un code et un lien personnel. Les commandes passées après un clic sur son lien lui sont attribuées.</p>

      <form className="p-filters glass" method="get" action={BASE} role="search" aria-label="Filtrer les influenceuses">
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="a-q">
            Recherche
          </label>
          <input id="a-q" type="search" name="q" defaultValue={q ?? ''} placeholder="Nom ou code" maxLength={100} />
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="a-status">
            Statut du compte
          </label>
          <select id="a-status" name="status" defaultValue={status ?? ''}>
            <option value="">Tous les statuts</option>
            {USER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
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
        <Notice tone="error">{apiMessage(result.code)}</Notice>
      ) : !isList<AdminAffiliateRow>(result.data) ? (
        <Notice tone="error">{apiMessage('generic')}</Notice>
      ) : (
        <>
          <Table<AdminAffiliateRow>
            rows={result.data.items}
            empty="Aucune influenceuse ne correspond à ces critères."
            columns={[
              {
                key: 'name',
                header: 'Nom',
                render: (a) => (
                  <Link className="p-linkbtn" href={`${BASE}/${a.userId}`}>
                    {a.name}
                  </Link>
                ),
              },
              { key: 'code', header: 'Code', render: (a) => <strong>{a.code}</strong> },
              { key: 'link', header: 'Lien', hideBelow: 'md', render: (a) => <CopyField label={`Lien de ${a.name}`} value={a.link} /> },
              { key: 'manager', header: 'Sous-manager', hideBelow: 'md', render: (a) => a.manager?.name ?? '—' },
              { key: 'status', header: 'Compte', render: (a) => <Badge tone={statusTone(a.status as (typeof USER_STATUSES)[number])}>{statusLabel(a.status as (typeof USER_STATUSES)[number])}</Badge> },
              { key: 'clicks', header: 'Clics', render: (a) => a.clicks },
              { key: 'orders', header: 'Commandes', render: (a) => a.orders },
              { key: 'delivered', header: 'Livrées', hideBelow: 'sm', render: (a) => a.delivered },
              { key: 'pending', header: 'En attente', hideBelow: 'sm', render: (a) => <span className="p-money">{formatMoney(a.totals.pending)}</span> },
              { key: 'validated', header: 'Validées', hideBelow: 'sm', render: (a) => <span className="p-money">{formatMoney(a.totals.validated)}</span> },
              { key: 'paid', header: 'Payées', hideBelow: 'sm', render: (a) => <span className="p-money">{formatMoney(a.totals.paid)}</span> },
            ]}
          />
          <Pager page={page} total={result.data.total} pageSize={PAGE_SIZE} hrefFor={(p) => buildHref(BASE, { q, status, page: p })} />
        </>
      )}
    </div>
  );
}
