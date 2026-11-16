import { Suspense } from 'react';
import { connection } from 'next/server';
import { HomePage } from '@/components/home/HomePage';
import { RefCapture } from '@/components/RefCapture';
import { defaultProduct, type Product } from '@/data/products';
import { getServerContext } from '@/server/context';
import { listProducts, readProductBySlug } from '@/server/products/db';
import './home.css';

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeContent />
    </Suspense>
  );
}

/** Active catalogue products, default product first; falls back to the built-in default if the database is unavailable. */
async function HomeContent() {
  await connection();
  let products: Product[] = [defaultProduct];
  try {
    const { db } = getServerContext();
    products = listProducts(db)
      .filter((p) => p.isActive)
      .flatMap((p) => {
        const full = readProductBySlug(db, p.slug);
        return full ? [full] : [];
      });
  } catch {
    // keep fallback
  }
  return (
    <>
      <RefCapture />
      <HomePage products={products} />
    </>
  );
}
