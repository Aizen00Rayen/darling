import type { Product } from '@/data/products';
import { Lines } from './Lines';
import { ProductVideo } from './ProductVideo';

export function RitualSection({ ritual }: { ritual: Product['ritual'] }) {
  return (
    <section className="ritual" id="rituel">
      <div className="ritual-copy">
        <p className="eyebrow">{ritual.eyebrow}</p>
        <h2>
          <Lines lines={ritual.heading.lines} />
          <br />
          <em>{ritual.heading.accent}</em>
        </h2>
        <ol>
          {ritual.steps.map((step) => (
            <li key={step.title}>
              <b>{step.title}</b>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="tip">{ritual.tip}</p>
      </div>
      <div className="ritual-video">
        <ProductVideo {...ritual.video} />
      </div>
    </section>
  );
}
