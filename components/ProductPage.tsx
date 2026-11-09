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
      <Header />
      <main>
        <PurchasePanel product={product} />
        <Marquee />
        <EffectSection />
        <LayeringSection />
        <RitualSection />
        <Faq faqs={product.faqs} />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
