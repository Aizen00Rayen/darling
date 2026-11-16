import Image from 'next/image';
import Link from 'next/link';
import { ArrowIcon } from '../icons';

export function SiteHeader() {
  return (
    <header className="header header-home">
      <Link className="wordmark" href="/" aria-label="Darling, accueil">
        DARLING
        <Image src="/assets/darling-logo.png" alt="" width={48} height={48} />
      </Link>
      <nav aria-label="Navigation principale">
        <a href="#boutique">BOUTIQUE</a>
        <a href="#marque">LA MARQUE</a>
        <a href="#teinte">TROUVER MA TEINTE</a>
        <a href="#faq">FAQ</a>
      </nav>
      <a className="nav-order glass" href="#boutique">
        COMMANDER{' '}
        <span>
          <ArrowIcon />
        </span>
      </a>
    </header>
  );
}
