import Image from 'next/image';
import { ArrowIcon } from './icons';

export function Header({ productName }: { productName: string }) {
  return (
    <header className="header">
      <a className="wordmark" href="#" aria-label="Darling, accueil">
        DARLING
        <Image src="/assets/darling-logo.png" alt="" width={48} height={48} />
      </a>
      <nav aria-label="Navigation principale">
        <a href="#produit">{productName.toUpperCase()}</a>
        <a href="#effet">L’EFFET GLOSS</a>
        <a href="#rituel">LE RITUEL</a>
      </nav>
      <a className="nav-order glass" href="#commande">
        JE LE VEUX{' '}
        <span>
          <ArrowIcon />
        </span>
      </a>
    </header>
  );
}
