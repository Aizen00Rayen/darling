import Image from 'next/image';
import { ArrowIcon } from './icons';

export function FinalCta() {
  return (
    <section className="last-call">
      <Image src="/assets/darling-logo.png" alt="" width={110} height={110} />
      <h2>
        HEY DARLING,
        <br />
        READY TO GLOSS?
      </h2>
      <a className="glass" href="#commande">
        OUI, JE LE VEUX{' '}
        <span>
          <ArrowIcon />
        </span>
      </a>
    </section>
  );
}
