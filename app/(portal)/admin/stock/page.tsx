import { Suspense } from 'react';
import type { Metadata } from 'next';
import { PageLoading } from '@/components/portal/PageLoading';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { StockMovementForm } from '@/components/portal/StockMovementForm';
import { Badge, PageHeader, Table } from '@/ui';
import { requireAdmin } from '@/lib/portal/guards';
import { formatDateTime } from '@/lib/portal/format';
import { getServerContext } from '@/server/context';
import { listMovements, readOverview } from '@/server/inventory/stock';
import { OFFSITE_CHANNEL_LABELS, STOCK_REASON_LABELS, type OffsiteChannel, type StockMovementDto, type StockProduct } from '@/shared/stock';

export const metadata: Metadata = { title: 'Stock — Darling', robots: { index: false } };

export default function AdminStockPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

function tone(p: StockProduct): 'success' | 'warning' | 'danger' {
  if (p.total <= 0) return 'danger';
  return p.total <= p.lowStockThreshold ? 'warning' : 'success';
}

async function Content() {
  const me = await requireAdmin();
  if (!me.permissions.includes('stock.write')) return <AccessDenied />;

  const ctx = getServerContext();
  const products = readOverview(ctx.db);
  const movements = listMovements(ctx.db, { limit: 60 });
  const units = products.reduce((n, p) => n + p.total, 0);
  const low = products.filter((p) => p.total > 0 && p.total <= p.lowStockThreshold).length;
  const out = products.filter((p) => p.total <= 0).length;
  const offsite = products.reduce((n, p) => n + p.soldOffsite, 0);

  return (
    <div className="p-stack p-stack--lg">
      <PageHeader eyebrow="Inventaire" title="Stock" />
      <p className="p-lead">
        Le stock est un journal : chaque commande du site, chaque vente hors site, réception ou correction est enregistrée
        et ne peut plus être modifiée. Les commandes annulées, refusées ou retournées remettent automatiquement le stock.
      </p>

      <div className="p-grid p-grid--4" role="list" aria-label="Indicateurs de stock">
        <div role="listitem"><strong>{units}</strong><div className="p-subtle">unités en stock</div></div>
        <div role="listitem"><strong>{low}</strong><div className="p-subtle">produits bientôt épuisés</div></div>
        <div role="listitem"><strong>{out}</strong><div className="p-subtle">produits épuisés</div></div>
        <div role="listitem"><strong>{offsite}</strong><div className="p-subtle">unités vendues hors site</div></div>
      </div>

      <Table<StockProduct>
        rows={products}
        empty="Aucun produit."
        columns={[
          { key: 'name', header: 'Produit', render: (p) => <strong>{p.name}</strong> },
          {
            key: 'total',
            header: 'Stock total',
            render: (p) => (
              <Badge tone={tone(p)}>{p.total <= 0 ? 'Épuisé' : `${p.total} unités`}</Badge>
            ),
          },
          {
            key: 'shades',
            header: 'Par teinte',
            hideBelow: 'sm',
            render: (p) => (
              <div>
                {p.shades.filter((s) => s.shadeCode !== '' || s.quantity !== 0).map((s) => (
                  <span key={s.shadeCode} style={{ marginRight: '0.75rem', whiteSpace: 'nowrap' }}>
                    {s.shadeCode === '' ? 'Non réparti' : s.shadeCode} : <strong>{s.quantity}</strong>
                  </span>
                ))}
              </div>
            ),
          },
          { key: 'web', header: 'Vendu (site)', hideBelow: 'sm', render: (p) => p.soldWebsite },
          { key: 'off', header: 'Vendu (hors site)', hideBelow: 'sm', render: (p) => p.soldOffsite },
        ]}
      />

      <section aria-labelledby="mv-form">
        <h2 id="mv-form">Enregistrer un mouvement</h2>
        <StockMovementForm products={products} />
      </section>

      <section aria-labelledby="mv-hist">
        <h2 id="mv-hist">Historique récent</h2>
        <Table<StockMovementDto>
          rows={movements}
          empty="Aucun mouvement."
          columns={[
            { key: 'at', header: 'Date', render: (m) => formatDateTime(new Date(m.at).toISOString()) },
            { key: 'p', header: 'Produit', render: (m) => `${m.productName}${m.shadeCode ? ` ${m.shadeCode}` : ''}` },
            {
              key: 'r',
              header: 'Opération',
              render: (m) => (
                <div>
                  {STOCK_REASON_LABELS[m.reason]}
                  {m.channel && m.reason === 'sale_offsite' ? ` · ${OFFSITE_CHANNEL_LABELS[m.channel as OffsiteChannel] ?? m.channel}` : ''}
                  {m.note ? <div className="p-subtle">{m.note}</div> : null}
                </div>
              ),
            },
            { key: 'd', header: 'Qté', render: (m) => <strong>{m.delta > 0 ? `+${m.delta}` : m.delta}</strong> },
            { key: 'a', header: 'Par', hideBelow: 'sm', render: (m) => m.actorName ?? 'Système' },
          ]}
        />
      </section>
    </div>
  );
}
