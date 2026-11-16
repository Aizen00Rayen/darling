import Image from 'next/image';
import Link from 'next/link';

async function CopyrightYear() {
  'use cache';
  return <>{new Date().getFullYear()}</>;
}

export function HomeFooter() {
  return (
    <footer className="home-footer">
      <Link className="wordmark" href="/">
        DARLING
        <Image src="/assets/darling-logo.png" width={48} height={48} alt="" />
      </Link>
      <nav aria-label="Pied de page">
        <a href="#boutique">Boutique</a>
        <a href="#marque">La marque</a>
        <a href="#faq">FAQ</a>
      </nav>
      <small>
        © <CopyrightYear /> Darling · Paiement à la livraison partout en Algérie
      </small>
    </footer>
  );
}
