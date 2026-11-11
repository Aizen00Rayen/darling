import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/ui';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { ProductForm } from '@/components/portal/ProductForm';
import { requireAdmin } from '@/lib/portal/guards';

export const metadata: Metadata = { title: 'Nouveau produit — Darling', robots: { index: false } };

export default function NewProductPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const me = await requireAdmin();
  if (!me.permissions.includes('catalog.write')) return <AccessDenied />;

  return (
    <div className="p-stack">
      <Link className="p-back" href="/admin/produits">
        ← Produits
      </Link>
      <PageHeader eyebrow="Catalogue" title="Nouveau produit" />
      <section className="p-card glass" aria-label="Nouveau produit">
        <p className="p-lead">
          Créez un nouveau produit pour votre catalogue. Il disposera d’une page de présentation et de commande
          identique à celle de Wet Kiss.
        </p>
        <ProductForm mode="create" />
      </section>
    </div>
  );
}
