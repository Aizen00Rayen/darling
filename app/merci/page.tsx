import type { Metadata } from 'next';
import { Suspense } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowIcon, HeartIcon } from '@/components/icons';
import { defaultProduct } from '@/data/products';
import { validOrderNumber } from '@/lib/order-number';

export const metadata: Metadata = {
  title: 'Merci, Darling — Commande reçue',
  robots: { index: false },
};

/** The order number from `?n=`, shown only when it has the exact `DL-YY-NNNNNN` shape. Reading the query makes this part dynamic. */
async function OrderNumber({ searchParams }: Pick<PageProps<'/merci'>, 'searchParams'>) {
  const number = validOrderNumber((await searchParams).n);
  if (!number) return null;
  return (
    <p>
      Numéro de commande : <strong>{number}</strong>
    </p>
  );
}

export default function Merci({ searchParams }: PageProps<'/merci'>) {
  return (
    <div className="thanks-page">
      <main className="thanks glass">
        <Image src="/assets/darling-logo.png" alt="Logo Darling" width={230} height={230} />
        <p className="eyebrow">
          MERCI, DARLING <HeartIcon />
        </p>
        <h1>It’s a match.</h1>
        <p>
          Votre demande de commande a bien été transmise.
          <br />
          Notre équipe vous contactera pour la confirmer.
        </p>
        <Suspense fallback={null}>
          <OrderNumber searchParams={searchParams} />
        </Suspense>
        <p>Le paiement se fera à la livraison.</p>
        <Link href="/">
          RETOUR À {defaultProduct.name.toUpperCase()} <ArrowIcon />
        </Link>
      </main>
    </div>
  );
}
