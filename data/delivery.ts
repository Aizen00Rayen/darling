export type DeliveryMode = 'desk' | 'home';

export type Wilaya = {
  code: number;
  name: string;
  /** Home delivery fee in DA. */
  home: number;
  /** Stop Desk fee in DA. null means the wilaya has no desk service (never free). */
  desk: number | null;
};

export const wilayas: Wilaya[] = [
  { code: 1, name: "Adrar", home: 1650, desk: 850 },
  { code: 2, name: "Chlef", home: 700, desk: 450 },
  { code: 3, name: "Laghouat", home: 850, desk: 450 },
  { code: 4, name: "Oum El Bouaghi", home: 850, desk: 450 },
  { code: 5, name: "Batna", home: 850, desk: 450 },
  { code: 6, name: "Bejaia", home: 850, desk: 450 },
  { code: 7, name: "Biskra", home: 850, desk: 450 },
  { code: 8, name: "Bechar", home: 1200, desk: 650 },
  { code: 9, name: "Blida", home: 650, desk: 400 },
  { code: 10, name: "Bouira", home: 650, desk: 450 },
  { code: 11, name: "Tamanrasset", home: 1800, desk: 1000 },
  { code: 12, name: "Tebessa", home: 850, desk: 450 },
  { code: 13, name: "Tlemcen", home: 850, desk: 450 },
  { code: 14, name: "Tiaret", home: 850, desk: 450 },
  { code: 15, name: "Tizi Ouzou", home: 650, desk: 450 },
  { code: 16, name: "Alger", home: 450, desk: 300 },
  { code: 17, name: "Djelfa", home: 850, desk: 450 },
  { code: 18, name: "Jijel", home: 850, desk: 450 },
  { code: 19, name: "Setif", home: 850, desk: 450 },
  { code: 20, name: "Saida", home: 850, desk: 450 },
  { code: 21, name: "Skikda", home: 850, desk: 450 },
  { code: 22, name: "Sidi Bel Abbes", home: 850, desk: 450 },
  { code: 23, name: "Annaba", home: 850, desk: 450 },
  { code: 24, name: "Guelma", home: 850, desk: 450 },
  { code: 25, name: "Constantine", home: 850, desk: 450 },
  { code: 26, name: "Medea", home: 850, desk: 450 },
  { code: 27, name: "Mostaganem", home: 850, desk: 450 },
  { code: 28, name: "M'Sila", home: 850, desk: 450 },
  { code: 29, name: "Mascara", home: 850, desk: 450 },
  { code: 30, name: "Ouargla", home: 1000, desk: 500 },
  { code: 31, name: "Oran", home: 850, desk: 450 },
  { code: 32, name: "El Bayadh", home: 850, desk: 450 },
  { code: 33, name: "Illizi", home: 1700, desk: 850 },
  { code: 34, name: "Bordj Bou Arreridj", home: 650, desk: 450 },
  { code: 35, name: "Boumerdes", home: 650, desk: 400 },
  { code: 36, name: "El Tarf", home: 850, desk: 550 },
  { code: 37, name: "Tindouf", home: 1650, desk: null },
  { code: 38, name: "Tissemsilt", home: 850, desk: 450 },
  { code: 39, name: "El Oued", home: 950, desk: 600 },
  { code: 40, name: "Khenchela", home: 850, desk: 450 },
  { code: 41, name: "Souk Ahras", home: 850, desk: 450 },
  { code: 42, name: "Tipaza", home: 650, desk: 450 },
  { code: 43, name: "Mila", home: 850, desk: 450 },
  { code: 44, name: "Ain Defla", home: 650, desk: 450 },
  { code: 45, name: "Naama", home: 950, desk: 500 },
  { code: 46, name: "Ain Temouchent", home: 850, desk: 450 },
  { code: 47, name: "Ghardaia", home: 950, desk: 650 },
  { code: 48, name: "Relizane", home: 850, desk: 450 },
  { code: 49, name: "Timimoun", home: 1650, desk: 850 },
  { code: 50, name: "Bordj Badji Mokhtar", home: 1600, desk: null },
  { code: 51, name: "Ouled Djellal", home: 950, desk: 450 },
  { code: 52, name: "Beni Abbes", home: 1300, desk: null },
  { code: 53, name: "In Salah", home: 1650, desk: 850 },
  { code: 54, name: "In Guezzam", home: 1500, desk: null },
  { code: 55, name: "Touggourt", home: 950, desk: 500 },
  { code: 56, name: "Djanet", home: 2000, desk: 1000 },
  { code: 57, name: "El M'Ghair", home: 950, desk: 500 },
  { code: 58, name: "El Meniaa", home: 950, desk: 500 },
];

export function getWilaya(code: number): Wilaya | undefined {
  return wilayas.find((w) => w.code === code);
}
