import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowIcon, HeartIcon } from '@/components/icons';

export const metadata: Metadata = {
  title: 'Merci, Darling — Commande reçue',
  robots: { index: false },
};

export default function Merci() {
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
        <p>Le paiement se fera à la livraison.</p>
        <Link href="/">
          RETOUR À WET KISS <ArrowIcon />
        </Link>
      </main>
    </div>
  );
}
