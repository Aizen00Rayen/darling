import Image from 'next/image';
import Link from 'next/link';
import type { Product } from '@/data/products';
import { AnnouncementBar } from '../AnnouncementBar';
import { ArrowIcon, AsteriskIcon, HeartIcon } from '../icons';
import { Marquee } from '../Marquee';
import { HomeFooter } from './HomeFooter';
import { ProductCard } from './ProductCard';
import { SiteHeader } from './SiteHeader';

const faqs = [
  {
    title: 'Où puis-je acheter les produits Darling* en Algérie ?',
    body: 'Directement ici, sur la boutique. Choisissez votre produit, remplissez le formulaire de commande et payez à la livraison.',
  },
  {
    title: 'Comment se passe le paiement et la livraison ?',
    body: 'Le paiement se fait à la réception de la commande, en espèces. Les frais et le délai de livraison s’affichent selon votre wilaya avant de valider.',
  },
  {
    title: 'Darling* est-il cruelty-free ?',
    body: 'Oui. Darling* ne teste jamais ses produits sur les animaux, à aucune étape de la chaîne d’approvisionnement.',
  },
  {
    title: 'Les produits sont-ils végans ?',
    body: 'Certains produits le sont, sans ingrédient d’origine animale. Le détail figure sur la fiche de chaque produit.',
  },
  {
    title: 'Où sont fabriqués les produits ?',
    body: 'Selon la gamme : masques et patchs en Corée, blushs et gloss en Italie, baumes et marqueurs sourcils en Allemagne, parfums en France. Le pays d’origine est indiqué sur chaque fiche.',
  },
  {
    title: 'Mon produit préféré est épuisé, quand revient-il ?',
    body: 'Les réassorts arrivent par vagues. Un produit épuisé reste visible sur la boutique et repasse en stock dès l’arrivée de la nouvelle livraison.',
  },
];

const trust = ['Cruelty-free', 'Paiement à la livraison', 'Livraison dans les 58 wilayas', 'Fabriqué en Corée, Italie, France'];

export function HomePage({ products }: { products: Product[] }) {
  const hero = products[0];
  return (
    <>
      <a className="skip" href="#boutique">
        Aller à la boutique
      </a>
      <AnnouncementBar />
      <SiteHeader />
      <main className="home">
        <section className="home-hero" aria-labelledby="hero-title">
          <div className="home-hero-copy">
            <p className="eyebrow">NOUVEAU EN ALGÉRIE</p>
            <h1 id="hero-title">
              DARLING<sup>*</sup>
              <span>beauty on-the-go.</span>
            </h1>
            <p className="home-lead">
              Du soin et du maquillage ludiques, pensés pour les journées bien remplies. Pour une confiance en selfie
              à toute épreuve et une façon de vous exprimer sans effort.
            </p>
            <div className="home-actions">
              <a className="btn-pink" href="#boutique">
                DÉCOUVRIR LA BOUTIQUE <ArrowIcon />
              </a>
              {hero && (
                <Link className="btn-ghost" href={`/produit/${hero.slug}`}>
                  {hero.name.toUpperCase()} — {hero.price.toLocaleString('fr-FR').replace(/ | /g, ' ')} DA
                </Link>
              )}
            </div>
          </div>
          <div className="home-hero-media">
            <Image src="/assets/model.jpg" alt="Modèle portant Wet Kiss" fill priority sizes="(max-width:900px) 100vw, 50vw" />
          </div>
        </section>

        <Marquee text="PLAYFUL BEAUTY. REAL GLOW. BIG CRUSH." />

        <section className="home-section" id="boutique" aria-labelledby="shop-title">
          <div className="home-head">
            <p className="eyebrow">LA BOUTIQUE</p>
            <h2 id="shop-title">
              Nos <em>crushs</em> du moment.
            </h2>
          </div>
          {products.length > 0 ? (
            <div className="card-grid">
              {products.map((p) => (
                <ProductCard key={p.slug} product={p} />
              ))}
            </div>
          ) : (
            <p className="home-empty">La boutique arrive très bientôt.</p>
          )}
        </section>

        <section className="home-brand" id="marque" aria-labelledby="brand-title">
          <div>
            <p className="eyebrow">À PROPOS DE DARLING*</p>
            <h2 id="brand-title">
              Une beauté qui <em>s’amuse</em>.
            </h2>
          </div>
          <div>
            <p>
              Darling* bouscule les codes avec des soins et du maquillage ludiques, qui illuminent votre journée et
              s’intègrent à votre rythme. Notre objectif : booster votre confiance en selfie et rendre l’expression de
              soi sans effort.
            </p>
            <ul className="home-trust">
              {trust.map((t) => (
                <li key={t}>
                  <AsteriskIcon /> {t}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {hero && hero.shades.length > 1 && (
          <section className="home-shade" id="teinte" aria-labelledby="shade-title">
            <div>
              <p className="eyebrow">TROUVER MA TEINTE</p>
              <h2 id="shade-title">
                Quelle teinte de <em>{hero.name}</em> est faite pour vous ?
              </h2>
              <p>Du nude lumineux au rouge intense : choisissez la nuance qui vous ressemble.</p>
              <Link className="btn-pink" href={`/produit/${hero.slug}#produit`}>
                VOIR LES TEINTES <ArrowIcon />
              </Link>
            </div>
            <ul className="shade-row">
              {hero.shades.map((s) => (
                <li key={s.code}>
                  <i style={{ background: s.color }} />
                  <span>{s.code}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="home-faq" id="faq" aria-labelledby="faq-title">
          <h2 id="faq-title">
            FAQ<span>*</span>
          </h2>
          <div>
            {faqs.map((f) => (
              <details key={f.title}>
                <summary>
                  {f.title} <span>+</span>
                </summary>
                <p>{f.body}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="last-call">
          <HeartIcon />
          <h2>
            HEY DARLING,
            <br />
            READY TO GLOW?
          </h2>
          <a href="#boutique">
            JE DÉCOUVRE <ArrowIcon />
          </a>
        </section>
      </main>
      <HomeFooter />
    </>
  );
}
