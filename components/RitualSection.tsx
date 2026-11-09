import { ProductVideo } from './ProductVideo';

export function RitualSection() {
  return (
    <section className="ritual" id="rituel">
      <div className="ritual-copy">
        <p className="eyebrow">02 / VOTRE NOUVEAU RITUEL</p>
        <h2>
          CLICK.
          <br />
          GLIDE.
          <br />
          <em>KISS.</em>
        </h2>
        <ol>
          <li>
            <b>Un petit clic</b>
            <p>Faites sortir seulement 1 à 2 mm de produit.</p>
          </li>
          <li>
            <b>Un geste tout doux</b>
            <p>
              Appliquez directement sur les lèvres. Ajoutez un crayon à lèvres pour un contour plus intense.
            </p>
          </li>
        </ol>
        <p className="tip">Le stylo ne se rétracte pas : un peu de produit suffit à chaque application.</p>
      </div>
      <div className="ritual-video">
        <ProductVideo
          desktop="/assets/application.mp4"
          mobile="/assets/application-mobile.mp4"
          poster="/assets/texture.jpg"
          label="Vidéo originale : comment appliquer Wet Kiss"
        />
      </div>
    </section>
  );
}
