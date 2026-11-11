import { Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ProductPage } from '@/components/ProductPage';
import { RefCapture } from '@/components/RefCapture';
import { getProduct } from '@/data/products';
import { getServerContext } from '@/server/context';
import { readProductBySlug } from '@/server/products/db';

export async function generateMetadata({ params }: PageProps<'/produit/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const staticProd = getProduct(slug);
  if (staticProd) {
    return {
      title: `${staticProd.name} — Darling`,
      description: staticProd.description,
    };
  }
  return {
    title: 'Produit — Darling',
  };
}

export default function DynamicProductPage(props: PageProps<'/produit/[slug]'>) {
  return (
    <Suspense fallback={null}>
      <ProductContent {...props} />
    </Suspense>
  );
}

async function ProductContent({ params }: PageProps<'/produit/[slug]'>) {
  const { slug } = await params;
  await connection();
  let product;
  try {
    const ctx = getServerContext();
    product = readProductBySlug(ctx.db, slug) ?? getProduct(slug);
  } catch {
    product = getProduct(slug);
  }
  if (!product) notFound();

  return (
    <>
      <RefCapture />
      <ProductPage product={product} />
    </>
  );
}
