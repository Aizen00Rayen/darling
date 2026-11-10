import Image from 'next/image';
import type { Product } from '@/data/products';
import { ArrowIcon } from './icons';
import { Lines } from './Lines';

export function FinalCta({ finalCta }: { finalCta: Product['finalCta'] }) {
  return (
    <section className="last-call">
      <Image src="/assets/darling-logo.png" alt="" width={110} height={110} />
      <h2>
        <Lines lines={finalCta.lines} />
      </h2>
      <a className="glass" href="#commande">
        {finalCta.label}{' '}
        <span>
          <ArrowIcon />
        </span>
      </a>
    </section>
  );
}
