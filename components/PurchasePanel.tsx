'use client';

import { useRef, useState } from 'react';
import type { Product } from '@/data/products';
import { formatMoney } from '@/lib/pricing';
import { Gallery } from './Gallery';
import { AsteriskIcon, HeartIcon } from './icons';
import { MobileBuyBar } from './MobileBuyBar';
import { ORDER_FORM_ID, OrderForm } from './OrderForm';
import { ShadePicker } from './ShadePicker';

/** Hero section: gallery, product copy, shade picker and order form share the selected shade. */
export function PurchasePanel({ product }: { product: Product }) {
  const sectionRef = useRef<HTMLElement>(null);
  const [shadeIndex, setShadeIndex] = useState(0);
  const [slideIndex, setSlideIndex] = useState(0);

  const shade = product.shades[shadeIndex];
  // Static price labels use plain spaces, as the live markup does.
  const priceLabel = formatMoney(product.price).replace(/\s/g, ' ');
  const amount = priceLabel.replace(/ DA$/, '');
  const [firstWord, ...otherWords] = product.name.toUpperCase().split(' ');

  function chooseShade(index: number) {
    setShadeIndex(index);
    const render = product.slides.findIndex((slide) => slide.src === product.shades[index].image);
    if (render >= 0) setSlideIndex(render);
    if (window.matchMedia('(max-width: 700px)').matches) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      sectionRef.current
        ?.querySelector('.gallery')
        ?.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'start' });
    }
  }

  return (
    <section className="product" id="produit" ref={sectionRef}>
      <Gallery name={product.name} slides={product.slides} index={slideIndex} onChange={setSlideIndex} />
      <div className="product-info">
        <p className="eyebrow">LIP FONDUE · MADE IN KOREA</p>
        <div className="title-line">
          <h1>
            {firstWord}
            <br />
            <span>{otherWords.join(' ')}</span>
            <sup>
              <AsteriskIcon />
            </sup>
          </h1>
          <span className="vertical-note">YOUR LIPS, BUT GLOSSIER.</span>
        </div>
        <div className="intro">
          <p>
            La texture qui fond.
            <br />
            Le gloss qui fait craquer.
          </p>
          <div className="price">
            {amount} <span>DA</span>
          </div>
        </div>
        <p className="description">
          Une touche de couleur, un éclat effet mouillé et des lèvres visiblement plus pulpeuses. Votre nouveau
          crush, en un clic.
        </p>
        <ShadePicker shades={product.shades} index={shadeIndex} onChange={chooseShade} />
        <div className="perks">
          <span>
            <AsteriskIcon /> FINI GLOSSY
          </span>
          <span>
            <HeartIcon /> VEGAN
          </span>
          <span>
            <AsteriskIcon /> CRUELTY FREE
          </span>
        </div>
        <OrderForm product={product} shadeCode={shade.code} />
      </div>
      <MobileBuyBar
        name={product.name}
        price={priceLabel}
        shadeCode={shade.code}
        formId={ORDER_FORM_ID}
      />
    </section>
  );
}
