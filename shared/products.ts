import { z } from 'zod';

export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  price: number;
  stock: number;
  maxQuantity: number;
  isActive: boolean;
  isDefault: boolean;
  shadesCount: number;
  createdAt: string;
  updatedAt: string;
}

const shadeSchema = z.object({
  code: z.string().min(1, 'Code de teinte requis.'),
  color: z.string().min(1, 'Couleur requise.'),
  image: z.string().min(1, 'Image de teinte requise.'),
});

const slideSchema = z.object({
  src: z.string().min(1, 'Source de l’image requise.'),
  alt: z.string().default(''),
  thumbLabel: z.string().default(''),
  uncropped: z.boolean().default(false),
});

const faqSchema = z.object({
  title: z.string().min(1, 'Titre FAQ requis.'),
  body: z.string().min(1, 'Contenu FAQ requis.'),
});

const perkSchema = z.object({
  icon: z.enum(['asterisk', 'heart']).default('asterisk'),
  label: z.string().min(1, 'Libellé requis.'),
});

const headingSchema = z.object({
  lines: z.array(z.string()).default([]),
  accent: z.string().default(''),
});

const videoSchema = z.object({
  desktop: z.string().default(''),
  mobile: z.string().default(''),
  poster: z.string().default(''),
  label: z.string().default(''),
});

export const productInputSchema = z.object({
  slug: z
    .string({ error: 'Identifiant URL (slug) requis.' })
    .trim()
    .toLowerCase()
    .min(2, 'Le slug doit comporter au moins 2 caractères.')
    .max(80, 'Slug trop long.')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Le slug ne doit contenir que des lettres minuscules, chiffres et tirets.'),
  name: z.string().trim().min(2, 'Le nom est requis.').max(120, 'Nom trop long.'),
  price: z.number().int().min(0, 'Le prix doit être un entier positif.'),
  stock: z.number().int().min(0, 'Le stock doit être un entier positif.').default(100),
  maxQuantity: z.number().int().min(1, 'Quantité max invalide.').default(20),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  shades: z.array(shadeSchema).min(1, 'Au moins une teinte est requise.'),
  slides: z.array(slideSchema).default([]),
  ingredients: z.string().default(''),
  faqs: z.array(faqSchema).default([]),
  eyebrow: z.string().default(''),
  verticalNote: z.string().default(''),
  tagline: z.array(z.string()).default([]),
  description: z.string().default(''),
  perks: z.array(perkSchema).default([]),
  photoLabel: z.array(z.string()).default([]),
  thumbsNote: z.array(z.string()).default([]),
  marquee: z.string().default(''),
  effect: z
    .object({
      eyebrow: z.string().default(''),
      heading: headingSchema.default({ lines: [], accent: '' }),
      intro: z.array(z.string()).default([]),
      video: videoSchema.default({ desktop: '', mobile: '', poster: '', label: '' }),
      benefits: z.array(z.object({ title: z.string(), body: z.string() })).default([]),
    })
    .default({
      eyebrow: '',
      heading: { lines: [], accent: '' },
      intro: [],
      video: { desktop: '', mobile: '', poster: '', label: '' },
      benefits: [],
    }),
  layering: z
    .object({
      image: z.object({ src: z.string().default(''), alt: z.string().default('') }).default({ src: '', alt: '' }),
      eyebrow: z.string().default(''),
      heading: headingSchema.default({ lines: [], accent: '' }),
      body: z.string().default(''),
      cta: z.string().default(''),
    })
    .default({
      image: { src: '', alt: '' },
      eyebrow: '',
      heading: { lines: [], accent: '' },
      body: '',
      cta: '',
    }),
  ritual: z
    .object({
      eyebrow: z.string().default(''),
      heading: headingSchema.default({ lines: [], accent: '' }),
      steps: z.array(z.object({ title: z.string(), body: z.string() })).default([]),
      tip: z.string().default(''),
      video: videoSchema.default({ desktop: '', mobile: '', poster: '', label: '' }),
    })
    .default({
      eyebrow: '',
      heading: { lines: [], accent: '' },
      steps: [],
      tip: '',
      video: { desktop: '', mobile: '', poster: '', label: '' },
    }),
  finalCta: z.object({ lines: z.array(z.string()).default([]), label: z.string().default('') }).default({ lines: [], label: '' }),
});

export type ProductInput = z.infer<typeof productInputSchema>;

export function createProductTemplate(name = '', slug = '', price = 3300): ProductInput {
  return {
    slug,
    name,
    price,
    stock: 100,
    maxQuantity: 20,
    isActive: true,
    isDefault: false,
    shades: [
      { code: '*01', color: '#fdecdd', image: '/assets/shade-01.png' },
      { code: '*02', color: '#f79797', image: '/assets/shade-02.png' },
      { code: '*03', color: '#bc5938', image: '/assets/shade-03.png' },
      { code: '*04', color: '#ff0000', image: '/assets/shade-04.png' },
    ],
    slides: [
      { src: '/assets/wet-kiss.jpg', alt: `${name} : fini sur les lèvres`, thumbLabel: 'Voir le fini', uncropped: false },
      { src: '/assets/model.jpg', alt: `${name} : produit`, thumbLabel: 'Voir le produit', uncropped: false },
      { src: '/assets/texture.jpg', alt: `${name} en main`, thumbLabel: 'Texture', uncropped: false },
    ],
    ingredients: 'Formule nourrissante, enrichie en actifs hydratants.',
    faqs: [
      {
        title: 'La livraison & le paiement',
        body: 'Paiement à la livraison partout en Algérie (58 wilayas) à domicile ou en point relais.',
      },
      {
        title: 'Comment choisir ma teinte ?',
        body: 'Sélectionnez la teinte souhaitée avant de valider votre commande.',
      },
    ],
    eyebrow: 'BEAUTÉ & SOIN · DARLING',
    verticalNote: 'SUBBLIMEZ VOS LÈVRES.',
    tagline: ['L’éclat parfait.', 'Le confort absolu.'],
    description: 'Une texture soyeuse, un fini sublime et des lèvres hydratées tout au long de la journée.',
    perks: [
      { icon: 'asterisk', label: 'LONGUE TENUE' },
      { icon: 'heart', label: 'HYDRATANT' },
      { icon: 'asterisk', label: 'CRUELTY FREE' },
    ],
    photoLabel: ['DARLING', 'MUST-HAVE.'],
    thumbsNote: ['APPLICATION FACILE.', 'RÉSULTAT INSTANTANÉ.'],
    marquee: `${name.toUpperCase()} · DARLING EXCLUSIVE`,
    effect: {
      eyebrow: '01 / L’EFFET',
      heading: { lines: ['TEXTURE.'], accent: 'ÉCLAT.' },
      intro: ['Une brillance unique.', 'Un confort incomparable.'],
      video: {
        desktop: '/assets/finish.mp4',
        mobile: '/assets/finish-mobile.mp4',
        poster: '/assets/model.jpg',
        label: 'Vidéo présentation produit',
      },
      benefits: [
        { title: 'Brillance naturelle', body: 'Laisse les lèvres éclatantes sans coller.' },
        { title: 'Hydratation continue', body: 'Protège et nourrit la peau fragile des lèvres.' },
      ],
    },
    layering: {
      image: { src: '/assets/texture.jpg', alt: name },
      eyebrow: 'APPLICATION MODULABLE',
      heading: { lines: ['Subtil ou intense,'], accent: 'à vous de choisir.' },
      body: 'Appliquez en voile léger ou superposez les couches pour intensifier la couleur.',
      cta: 'COMMANDER MAINTENANT',
    },
    ritual: {
      eyebrow: '02 / CONSEILS D’APPLICATION',
      heading: { lines: ['APPLIQUEZ.', 'SOUFLESSE.'], accent: 'SMILE.' },
      steps: [
        { title: 'Étape 1', body: 'Appliquez uniformément du centre vers les coins des lèvres.' },
        { title: 'Étape 2', body: 'Renouvelez l’application selon vos envies au cours de la journée.' },
      ],
      tip: 'Conservez à température ambiante.',
      video: {
        desktop: '/assets/application.mp4',
        mobile: '/assets/application-mobile.mp4',
        poster: '/assets/texture.jpg',
        label: 'Vidéo rituel d’application',
      },
    },
    finalCta: { lines: ['PRÊTE POUR', 'LE GLOSS PARFAIT ?'], label: 'COMMANDER MAINTENANT' },
  };
}
