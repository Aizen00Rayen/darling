import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Notice, PageHeader, Table } from '@/ui';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { requireAdmin } from '@/lib/portal/guards';
import { formatMoney } from '@/lib/pricing';
import { getServerContext } from '@/server/context';
import { listProducts } from '@/server/products/db';
import type { ProductSummary } from '@/shared/products';

export const metadata: Metadata = { title: 'Produits — Darling', robots: { index: false } };

export default function AdminProductsPage(props: PageProps<'/admin/produits'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

async function Content({ searchParams }: PageProps<'/admin/produits'>) {
  const [me, sp] = await Promise.all([requireAdmin(), searchParams]);
  if (!me.permissions.includes('catalog.write')) return <AccessDenied />;

  const ctx = getServerContext();
  const products = listProducts(ctx.db);
  const created = sp.created === '1';

  return (
    <div className="p-stack p-stack--lg">
      <PageHeader
        eyebrow="Catalogue"
        title="Produits"
        actions={
          <Link href="/admin/produits/nouveau" className="dl-btn dl-btn--primary">
            + Nouveau produit
          </Link>
        }
      />
      <p className="p-lead">
        Gérez les produits de la boutique. Chaque produit bénéficie de la même page de présentation immersive que Wet Kiss,
        avec ses propres visuels, vidéos, teintes et tarification.
      </p>

      {created ? <Notice tone="success">Produit créé avec succès.</Notice> : null}

      <Table<ProductSummary>
        rows={products}
        empty="Aucun produit dans le catalogue."
        columns={[
          {
            key: 'name',
            header: 'Produit',
            render: (p) => (
              <div>
                <Link className="p-linkbtn" href={`/admin/produits/${p.id}`}>
                  <strong>{p.name}</strong>
                </Link>
                {p.isDefault ? (
                  <span style={{ marginLeft: '0.5rem' }}>
                    <Badge tone="pink">Par défaut</Badge>
                  </span>
                ) : null}
                <div className="p-subtle">/produit/{p.slug}</div>
              </div>
            ),
          },
          {
            key: 'price',
            header: 'Prix',
            render: (p) => <strong>{formatMoney(p.price)}</strong>,
          },
          {
            key: 'stock',
            header: 'Stock',
            render: (p) => (
              <Badge tone={p.stock > 10 ? 'success' : p.stock > 0 ? 'warning' : 'danger'}>
                {p.stock} unités
              </Badge>
            ),
          },
          {
            key: 'shades',
            header: 'Teintes',
            hideBelow: 'sm',
            render: (p) => `${p.shadesCount} teintes`,
          },
          {
            key: 'status',
            header: 'Visibilité',
            render: (p) => (
              <Badge tone={p.isActive ? 'success' : 'neutral'}>
                {p.isActive ? 'Actif' : 'Inactif'}
              </Badge>
            ),
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (p) => (
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <Link href={`/admin/produits/${p.id}`} className="dl-btn dl-btn--ghost" style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }}>
                  Modifier
                </Link>
                <a
                  href={`/produit/${p.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dl-btn dl-btn--ghost"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }}
                >
                  Voir la page ↗
                </a>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
