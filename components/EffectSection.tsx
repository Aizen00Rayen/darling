import type { Product } from '@/data/products';
import { Lines } from './Lines';
import { ProductVideo } from './ProductVideo';

export function EffectSection({ effect }: { effect: Product['effect'] }) {
  return (
    <section className="film-section" id="effet">
      <div className="section-heading">
        <p className="eyebrow">{effect.eyebrow}</p>
        <h2>
          <Lines lines={effect.heading.lines} />
          <br />
          <span>{effect.heading.accent}</span>
        </h2>
        <p>
          <Lines lines={effect.intro} />
        </p>
      </div>
      <div className="film-frame">
        <ProductVideo {...effect.video} />
      </div>
      <div className="benefits">
        {effect.benefits.map((benefit, i) => (
          <div key={benefit.title}>
            <span>{String(i + 1).padStart(2, '0')}</span>
            <h3>{benefit.title}</h3>
            <p>{benefit.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
