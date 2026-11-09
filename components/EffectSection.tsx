import { ProductVideo } from './ProductVideo';

const benefits = [
  { title: 'Un fini lumineux', body: 'Un éclat effet mouillé qui laisse les lèvres naturellement brillantes.' },
  {
    title: 'Une texture fondante',
    body: 'La douceur d’une gelée, légère et confortable, sans sensation collante.',
  },
  {
    title: 'Un effet repulpant',
    body: 'Une formule au menthol pour des lèvres à l’apparence plus volumineuse.',
  },
];

export function EffectSection() {
  return (
    <section className="film-section" id="effet">
      <div className="section-heading">
        <p className="eyebrow">01 / L’EFFET WET KISS</p>
        <h2>
          GLOSS ON.
          <br />
          <span>WORLD OFF.</span>
        </h2>
        <p>
          La brillance attire le regard.
          <br />
          La texture fait le reste.
        </p>
      </div>
      <div className="film-frame">
        <ProductVideo
          desktop="/assets/finish.mp4"
          mobile="/assets/finish-mobile.mp4"
          poster="/assets/model.jpg"
          label="Vidéo originale Wet Kiss : texture et fini glossy"
        />
      </div>
      <div className="benefits">
        {benefits.map((benefit, i) => (
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
