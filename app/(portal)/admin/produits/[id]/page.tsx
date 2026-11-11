import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, PageHeader } from '@/ui';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { ProductForm } from '@/components/portal/ProductForm';
import { requireAdmin } from '@/lib/portal/guards';
import { getServerContext } from '@/server/context';
import { readProductById } from '@/server/products/db';
import type { ProductInput } from '@/shared/products';

export const metadata: Metadata = { title: 'Modifier le produit — Darling', robots: { index: false } };

export default function EditProductPage(props: PageProps<'/admin/produits/[id]'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

async function Content({ params }: PageProps<'/admin/produits/[id]'>) {
  const [me, { id }] = await Promise.all([requireAdmin(), params]);
  if (!me.permissions.includes('catalog.write')) return <AccessDenied />;

  const ctx = getServerContext();
  const found = readProductById(ctx.db, id);
  if (!found) notFound();

  const { product, summary } = found;
  const initialInput: ProductInput = {
    ...product,
    stock: summary.stock,
    isActive: summary.isActive,
    isDefault: summary.isDefault,
  };

  return (
    <div className="p-stack p-stack--lg">
      <Link className="p-back" href="/admin/produits">
        ← Produits
      </Link>
      <PageHeader
        eyebrow="Produit"
        title={product.name}
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <Badge tone={summary.isActive ? 'success' : 'neutral'}>
              {summary.isActive ? 'Actif' : 'Inactif'}
            </Badge>
            <a
              href={`/produit/${product.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="dl-btn dl-btn--ghost"
            >
              Voir la page ↗
            </a>
          </div>
        }
      />

      <section className="p-card glass" aria-labelledby="d-edit">
        <h2 className="p-card__title" id="d-edit">
          Modifier les informations & le contenu
        </h2>
        <ProductForm mode="edit" productId={summary.id} initial={initialInput} />
      </section>
    </div>
  );
}
