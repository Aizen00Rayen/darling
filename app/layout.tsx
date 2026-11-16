import type { Metadata, Viewport } from 'next';
import { DM_Sans, Space_Grotesk } from 'next/font/google';
import './globals.css';

const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
});

const spaceGrotesk = Space_Grotesk({
  variable: '--font-space-grotesk',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://darling7.store'),
  title: 'Darling* — Beauty on-the-go, maintenant en Algérie',
  description:
    'Soin et maquillage ludiques, cruelty-free. Découvrez Darling* en Algérie : commande en ligne, paiement à la livraison.',
  icons: { icon: '/assets/darling-logo.png' },
  openGraph: {
    title: 'Darling* — Beauty on-the-go',
    description: 'Soin et maquillage ludiques, livrés partout en Algérie.',
    images: ['/assets/texture.jpg'],
  },
};

export const viewport: Viewport = {
  themeColor: '#ef007f',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="fr" data-scroll-behavior="smooth" className={`${dmSans.variable} ${spaceGrotesk.variable}`}>
      <body>{children}</body>
    </html>
  );
}
