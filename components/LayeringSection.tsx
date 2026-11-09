import Image from 'next/image';
import { ArrowIcon } from './icons';

export function LayeringSection() {
  return (
    <section className="editorial">
      <div className="editorial-image">
        <Image
          src="/assets/texture.jpg"
          alt="Le stylo Wet Kiss rose, présenté par le modèle de la campagne"
          width={1350}
          height={1350}
          sizes="(max-width: 700px) 100vw, 50vw"
        />
      </div>
      <div className="editorial-copy">
        <p className="eyebrow">SOFT LIPS. STRONG FEELINGS.</p>
        <h2>
          Un peu.
          <br />
          Beaucoup.
          <br />
          <em>À la folie.</em>
        </h2>
        <p>
          Un voile discret ou une couleur plus intense : superposez les passages et faites monter le gloss.
        </p>
        <a href="#commande" className="text-link">
          TROUVER MA TEINTE{' '}
          <span>
            <ArrowIcon />
          </span>
        </a>
        <Image
          src="/assets/darling-logo.png"
          alt=""
          className="editorial-star"
          width={240}
          height={240}
          style={{ height: 'auto' }}
        />
      </div>
    </section>
  );
}
