export type DeliveryMode = 'desk' | 'home';

export type Wilaya = {
  code: number;
  name: string;
  /** Home delivery fee in DA. */
  home: number;
  /** Stop Desk fee in DA. null means the wilaya has no desk service (never free). */
  desk: number | null;
};

/**
 * Carrier tariffs from E-COM Delivery ("Nos Tarifs", departure Tlemcen), returns are free (0 DA).
 * Wilayas 50 (Bordj Badji Mokhtar) and 54 (In Guezzam) are NOT in that tariff sheet: they keep their previous
 * prices until the carrier confirms them.
 */
export const wilayas: Wilaya[] = [
  { code: 1, name: "Adrar", home: 1300, desk: 900 },
  { code: 2, name: "Chlef", home: 750, desk: 450 },
  { code: 3, name: "Laghouat", home: 900, desk: 600 },
  { code: 4, name: "Oum El Bouaghi", home: 800, desk: 500 },
  { code: 5, name: "Batna", home: 800, desk: 500 },
  { code: 6, name: "Bejaia", home: 800, desk: 450 },
  { code: 7, name: "Biskra", home: 950, desk: 500 },
  { code: 8, name: "Bechar", home: 1100, desk: 700 },
  { code: 9, name: "Blida", home: 750, desk: 450 },
  { code: 10, name: "Bouira", home: 800, desk: 450 },
  { code: 11, name: "Tamanrasset", home: 1550, desk: 1100 },
  { code: 12, name: "Tebessa", home: 900, desk: 500 },
  { code: 13, name: "Tlemcen", home: 450, desk: 300 },
  { code: 14, name: "Tiaret", home: 750, desk: 450 },
  { code: 15, name: "Tizi Ouzou", home: 800, desk: 450 },
  { code: 16, name: "Alger", home: 650, desk: 400 },
  { code: 17, name: "Djelfa", home: 900, desk: 600 },
  { code: 18, name: "Jijel", home: 800, desk: 450 },
  { code: 19, name: "Setif", home: 800, desk: 450 },
  { code: 20, name: "Saida", home: 750, desk: 500 },
  { code: 21, name: "Skikda", home: 800, desk: 450 },
  { code: 22, name: "Sidi Bel Abbes", home: 700, desk: 450 },
  { code: 23, name: "Annaba", home: 850, desk: 500 },
  { code: 24, name: "Guelma", home: 850, desk: 450 },
  { code: 25, name: "Constantine", home: 800, desk: 450 },
  { code: 26, name: "Medea", home: 700, desk: 450 },
  { code: 27, name: "Mostaganem", home: 700, desk: 450 },
  { code: 28, name: "M'Sila", home: 900, desk: 600 },
  { code: 29, name: "Mascara", home: 700, desk: 450 },
  { code: 30, name: "Ouargla", home: 950, desk: 650 },
  { code: 31, name: "Oran", home: 650, desk: 450 },
  { code: 32, name: "El Bayadh", home: 950, desk: 700 },
  { code: 33, name: "Illizi", home: 1550, desk: 1150 },
  { code: 34, name: "Bordj Bou Arreridj", home: 800, desk: 450 },
  { code: 35, name: "Boumerdes", home: 750, desk: 450 },
  { code: 36, name: "El Tarf", home: 850, desk: 450 },
  { code: 37, name: "Tindouf", home: 1300, desk: 800 },
  { code: 38, name: "Tissemsilt", home: 750, desk: 450 },
  { code: 39, name: "El Oued", home: 1000, desk: 650 },
  { code: 40, name: "Khenchela", home: 800, desk: 500 },
  { code: 41, name: "Souk Ahras", home: 800, desk: 500 },
  { code: 42, name: "Tipaza", home: 800, desk: 450 },
  { code: 43, name: "Mila", home: 800, desk: 450 },
  { code: 44, name: "Ain Defla", home: 750, desk: 450 },
  { code: 45, name: "Naama", home: 1000, desk: 600 },
  { code: 46, name: "Ain Temouchent", home: 650, desk: 450 },
  { code: 47, name: "Ghardaia", home: 1000, desk: 600 },
  { code: 48, name: "Relizane", home: 750, desk: 450 },
  { code: 49, name: "Timimoun", home: 1400, desk: 800 },
  { code: 50, name: "Bordj Badji Mokhtar", home: 1600, desk: null },
  { code: 51, name: "Ouled Djellal", home: 900, desk: 600 },
  { code: 52, name: "Beni Abbes", home: 1200, desk: 900 },
  { code: 53, name: "In Salah", home: 1500, desk: 1100 },
  { code: 54, name: "In Guezzam", home: 1500, desk: null },
  { code: 55, name: "Touggourt", home: 1000, desk: 650 },
  { code: 56, name: "Djanet", home: 2200, desk: 1600 },
  { code: 57, name: "El M'Ghair", home: 1000, desk: 650 },
  { code: 58, name: "El Meniaa", home: 1000, desk: 650 },
];

export function getWilaya(code: number): Wilaya | undefined {
  return wilayas.find((w) => w.code === code);
}
