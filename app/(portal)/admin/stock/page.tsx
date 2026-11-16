import { Suspense } from 'react';
import type { Metadata } from 'next';
import { PageLoading } from '@/components/portal/PageLoading';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { CostEditor } from '@/components/portal/CostEditor';
import { DeleteProductButton } from '@/components/portal/DeleteProductButton';
import { StockMovementForm } from '@/components/portal/StockMovementForm';
import { formatMoney } from '@/lib/pricing';
import '@/components/portal/dash/dashboard.css';
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
  const finance = me.permissions.includes('finance.read');
  const products = readOverview(ctx.db, { withCost: finance });
  const value = finance ? products.reduce((n, p) => n + p.total * (p.costPrice ?? 0), 0) : 0;
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

      <div className="dd-grid4" role="list" aria-label="Indicateurs de stock">
        <div className="dd-card" role="listitem"><div className="dd-card__label">Unités en stock</div><div className="dd-card__val">{units}</div></div>
        <div className={`dd-card ${low > 0 ? 'dd-card--urgent' : ''}`} role="listitem"><div className="dd-card__label">Bientôt épuisés</div><div className="dd-card__val">{low}</div></div>
        <div className="dd-card" role="listitem"><div className="dd-card__label">Épuisés</div><div className="dd-card__val">{out}</div></div>
        <div className="dd-card" role="listitem"><div className="dd-card__label">Vendues hors site</div><div className="dd-card__val">{offsite}</div></div>
        {finance ? <div className="dd-card dd-card--good" role="listitem"><div className="dd-card__label">Valeur du stock (achat)</div><div className="dd-card__val">{formatMoney(value)}</div></div> : null}
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
          ...(finance
            ? [
                { key: 'price', header: 'Prix de vente', hideBelow: 'sm' as const, render: (p: StockProduct) => formatMoney(p.price) },
                { key: 'cost', header: 'Prix d’achat', render: (p: StockProduct) => <CostEditor productId={p.id} value={p.costPrice ?? 0} /> },
                {
                  key: 'margin',
                  header: 'Marge / unité',
                  render: (p: StockProduct) => {
                    const m = p.price - (p.costPrice ?? 0);
                    return <strong style={{ color: m >= 0 ? 'var(--success-ink)' : 'var(--danger)' }}>{formatMoney(m)}</strong>;
                  },
                },
              ]
            : []),
          { key: 'sold', header: 'Vendu site / hors site', hideBelow: 'sm', render: (p) => `${p.soldWebsite} / ${p.soldOffsite}` },
          ...(me.permissions.includes('catalog.write')
            ? [{ key: 'del', header: '', render: (p: StockProduct) => <DeleteProductButton id={p.id} name={p.name} /> }]
            : []),
        ]}
      />

      <section aria-labelledby="mv-form" id="mouvement">
        <h2 id="mv-form">Enregistrer un mouvement</h2>
        <StockMovementForm products={products} canCost={finance} />
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
