export type Shade = { code: string; color: string; image: string };
export type Slide = { src: string; alt: string; thumbLabel: string };
export type Faq = { title: string; body: string };

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
    },
    { src: '/assets/model.jpg', alt: 'Wet Kiss : photo originale du produit', thumbLabel: 'Voir le produit' },
    { src: '/assets/texture.jpg', alt: 'Wet Kiss rose en main', thumbLabel: 'Voir Wet Kiss en main' },
    {
      src: '/assets/shade-comparison.png',
      alt: 'Comparatif Wet Kiss : teintes 01, 02, 03 et 04',
      thumbLabel: 'Comparatif Wet Kiss : teintes 01, 02, 03 et 04',
    },
    ...shadeCodes.map((n) => ({
      src: `/assets/shade-${n}.png`,
      alt: `Wet Kiss : rendu réel de la teinte ${n}`,
      thumbLabel: `Wet Kiss : rendu réel de la teinte ${n}`,
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
};

export const products: Product[] = [wetKiss];
export const defaultProduct: Product = wetKiss;

export function getProduct(slug: string): Product | undefined {
  return products.find((p) => p.slug === slug);
}
