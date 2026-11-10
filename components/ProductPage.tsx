import type { Product } from '@/data/products';
import { AnnouncementBar } from './AnnouncementBar';
import { EffectSection } from './EffectSection';
import { Faq } from './Faq';
import { FinalCta } from './FinalCta';
import { Footer } from './Footer';
import { Header } from './Header';
import { LayeringSection } from './LayeringSection';
import { Marquee } from './Marquee';
import { PurchasePanel } from './PurchasePanel';
import { RitualSection } from './RitualSection';

export function ProductPage({ product }: { product: Product }) {
  return (
    <>
      <a className="skip" href="#produit">
        Aller au produit
      </a>
      <AnnouncementBar />
      <Header productName={product.name} />
      <main>
        <PurchasePanel product={product} />
        <Marquee text={product.marquee} />
        <EffectSection effect={product.effect} />
        <LayeringSection layering={product.layering} />
        <RitualSection ritual={product.ritual} />
        <Faq faqs={product.faqs} />
        <FinalCta finalCta={product.finalCta} />
      </main>
      <Footer />
    </>
  );
}
