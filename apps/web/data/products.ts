export type Shade = { code: string; color: string; image: string };

export type Slide = {
  src: string;
  alt: string;
  /** aria-label of the slide's thumbnail. */
  thumbLabel: string;
  /** Shown whole on a plain background instead of cropped to the frame. */
  uncropped: boolean;
};

export type Faq = { title: string; body: string };
export type Video = { desktop: string; mobile: string; poster: string; label: string };
export type Perk = { icon: 'asterisk' | 'heart'; label: string };

/** A heading split into lines; the accent line is printed in the brand pink. */
export type Heading = { lines: string[]; accent: string };

export type Product = {
  slug: string;
  name: string;
  /** Unit price in DA. */
  price: number;
  maxQuantity: number;
  shades: Shade[];
  slides: Slide[];
  ingredients: string;
  faqs: Faq[];

  eyebrow: string;
  verticalNote: string;
  tagline: string[];
  description: string;
  perks: Perk[];
  photoLabel: string[];
  thumbsNote: string[];
  marquee: string;
  effect: {
    eyebrow: string;
    heading: Heading;
    intro: string[];
    video: Video;
    benefits: { title: string; body: string }[];
  };
  layering: {
    image: { src: string; alt: string };
    eyebrow: string;
    heading: Heading;
    body: string;
    cta: string;
  };
  ritual: {
    eyebrow: string;
    heading: Heading;
    steps: { title: string; body: string }[];
    tip: string;
    video: Video;
  };
  finalCta: { lines: string[]; label: string };
};

const wetKissIngredients =
  'Diisostearyl Malate, Bis-Behenyl/Isostearyl/Phytosteryl Dimer Dilinoleyl Dimer Dilinoleate, Hydrogenated Polyisobutene, Bis-Diglyceryl Polyacyladipate-2, Polyglyceryl-2 Triisostearate, Ceresin, Menthyl Lactate, Microcrystalline Wax, 1,2-Hexanediol, Titanium Dioxide (CI 77891), Yellow 5 Lake (CI 19140), Tocopheryl Acetate, Red 7 Lake (CI 15850), Fragrance, BHT.';

const shadeCodes = ['01', '02', '03', '04'] as const;
const shadeColors = ['#fdecdd', '#f79797', '#bc5938', '#ff0000'] as const;

const wetKiss: Product = {
  slug: 'wet-kiss',
  name: 'Wet Kiss',
  price: 3000,
  maxQuantity: 20,
  shades: shadeCodes.map((n, i) => ({
    code: `*${n}`,
    color: shadeColors[i],
    image: `/assets/shade-${n}.png`,
  })),
  slides: [
    {
      src: '/assets/wet-kiss.jpg',
      alt: 'Wet Kiss : fini brillant sur les lèvres',
      thumbLabel: 'Voir le fini sur les lèvres',
      uncropped: false,
    },
    {
      src: '/assets/model.jpg',
      alt: 'Wet Kiss : photo originale du produit',
      thumbLabel: 'Voir le produit',
      uncropped: false,
    },
    {
      src: '/assets/texture.jpg',
      alt: 'Wet Kiss rose en main',
      thumbLabel: 'Voir Wet Kiss en main',
      uncropped: false,
    },
    {
      src: '/assets/shade-comparison.png',
      alt: 'Comparatif Wet Kiss : teintes 01, 02, 03 et 04',
      thumbLabel: 'Comparatif Wet Kiss : teintes 01, 02, 03 et 04',
      uncropped: true,
    },
    ...shadeCodes.map((n) => ({
      src: `/assets/shade-${n}.png`,
      alt: `Wet Kiss : rendu réel de la teinte ${n}`,
      thumbLabel: `Wet Kiss : rendu réel de la teinte ${n}`,
      uncropped: true,
    })),
  ],
  ingredients: wetKissIngredients,
  faqs: [
    { title: 'Les ingrédients', body: wetKissIngredients },
    {
      title: 'La livraison & le paiement',
      body: 'Choisissez votre wilaya puis le retrait Stop Desk ou la livraison à domicile. Les frais et le total s’affichent avant confirmation. Le règlement se fait à la réception de votre commande.',
    },
    {
      title: 'Comment choisir ma teinte ?',
      body: 'Sélectionnez l’une des quatre teintes *01 à *04 au-dessus du formulaire. Votre choix est inclus dans votre commande. Le rendu dépend de la couleur naturelle de vos lèvres et de votre écran.',
    },
  ],

  eyebrow: 'LIP FONDUE · MADE IN KOREA',
  verticalNote: 'YOUR LIPS, BUT GLOSSIER.',
  tagline: ['La texture qui fond.', 'Le gloss qui fait craquer.'],
  description:
    'Une touche de couleur, un éclat effet mouillé et des lèvres visiblement plus pulpeuses. Votre nouveau crush, en un clic.',
  perks: [
    { icon: 'asterisk', label: 'FINI GLOSSY' },
    { icon: 'heart', label: 'VEGAN' },
    { icon: 'asterisk', label: 'CRUELTY FREE' },
  ],
  photoLabel: ['THE GLOSS', 'YOU’LL FALL FOR.'],
  thumbsNote: ['UN SWIPE.', 'ET LE CRUSH.'],
  marquee: 'WET LIPS. BIG CRUSH.',
  effect: {
    eyebrow: '01 / L’EFFET WET KISS',
    heading: { lines: ['GLOSS ON.'], accent: 'WORLD OFF.' },
    intro: ['La brillance attire le regard.', 'La texture fait le reste.'],
    video: {
      desktop: '/assets/finish.mp4',
      mobile: '/assets/finish-mobile.mp4',
      poster: '/assets/model.jpg',
      label: 'Vidéo originale Wet Kiss : texture et fini glossy',
    },
    benefits: [
      {
        title: 'Un fini lumineux',
        body: 'Un éclat effet mouillé qui laisse les lèvres naturellement brillantes.',
      },
      {
        title: 'Une texture fondante',
        body: 'La douceur d’une gelée, légère et confortable, sans sensation collante.',
      },
      {
        title: 'Un effet repulpant',
        body: 'Une formule au menthol pour des lèvres à l’apparence plus volumineuse.',
      },
    ],
  },
  layering: {
    image: {
      src: '/assets/texture.jpg',
      alt: 'Le stylo Wet Kiss rose, présenté par le modèle de la campagne',
    },
    eyebrow: 'SOFT LIPS. STRONG FEELINGS.',
    heading: { lines: ['Un peu.', 'Beaucoup.'], accent: 'À la folie.' },
    body: 'Un voile discret ou une couleur plus intense : superposez les passages et faites monter le gloss.',
    cta: 'TROUVER MA TEINTE',
  },
  ritual: {
    eyebrow: '02 / VOTRE NOUVEAU RITUEL',
    heading: { lines: ['CLICK.', 'GLIDE.'], accent: 'KISS.' },
    steps: [
      { title: 'Un petit clic', body: 'Faites sortir seulement 1 à 2 mm de produit.' },
      {
        title: 'Un geste tout doux',
        body: 'Appliquez directement sur les lèvres. Ajoutez un crayon à lèvres pour un contour plus intense.',
      },
    ],
    tip: 'Le stylo ne se rétracte pas : un peu de produit suffit à chaque application.',
    video: {
      desktop: '/assets/application.mp4',
      mobile: '/assets/application-mobile.mp4',
      poster: '/assets/texture.jpg',
      label: 'Vidéo originale : comment appliquer Wet Kiss',
    },
  },
  finalCta: { lines: ['HEY DARLING,', 'READY TO GLOSS?'], label: 'OUI, JE LE VEUX' },
};

export const products: Product[] = [wetKiss];
export const defaultProduct: Product = wetKiss;

export function getProduct(slug: string): Product | undefined {
  return products.find((p) => p.slug === slug);
}
