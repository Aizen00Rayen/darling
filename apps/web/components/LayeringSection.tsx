import Image from 'next/image';
import type { Product } from '@/data/products';
import { ArrowIcon } from './icons';
import { Lines } from './Lines';

export function LayeringSection({ layering }: { layering: Product['layering'] }) {
  return (
    <section className="editorial">
      <div className="editorial-image">
        <Image
          src={layering.image.src}
          alt={layering.image.alt}
          width={1350}
          height={1350}
          sizes="(max-width: 700px) 100vw, 50vw"
        />
      </div>
      <div className="editorial-copy">
        <p className="eyebrow">{layering.eyebrow}</p>
        <h2>
          <Lines lines={layering.heading.lines} />
          <br />
          <em>{layering.heading.accent}</em>
        </h2>
        <p>{layering.body}</p>
        <a href="#commande" className="text-link">
          {layering.cta}{' '}
          <span>
            <ArrowIcon />
          </span>
        </a>
        {/* Width comes from CSS and height from the attribute, as on the live site. */}
        <Image src="/assets/darling-logo.png" alt="" className="editorial-star" width={240} height={240} />
      </div>
    </section>
  );
}
