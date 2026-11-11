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
  title: 'Darling — Wet Kiss · Lip Fondue',
  description:
    'Wet Kiss par Darling. Une texture fondante, un fini glossy et quatre teintes à découvrir. 3 300 DA. Commandez en Algérie, paiement à la livraison.',
  icons: { icon: '/assets/darling-logo.png' },
  openGraph: {
    title: 'Darling — Wet Kiss',
    description: 'La touche de gloss qui change tout. Découvrez votre teinte.',
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
