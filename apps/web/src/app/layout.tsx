import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { Geist, Newsreader, Noto_Naskh_Arabic } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

/*
 * Type (UX 9.1): Newsreader for the agent's voice, titles and money; Geist for the interface;
 * Noto Naskh Arabic in both stacks so Arabic never falls to a system face. Self-hosted by next/font,
 * so the only font requests are same-origin.
 */
// Variable font: next/font requires the variable weight range when extra axes (opsz) are requested.
// adjustFontFallback:false on the Latin faces: their generated metric fallback (local Times New Roman /
// Arial, no unicode-range) would otherwise sit before Naskh in the stack and capture every Arabic glyph.
const newsreader = Newsreader({
  subsets: ['latin'],
  weight: 'variable',
  style: ['normal', 'italic'],
  variable: '--font-newsreader',
  display: 'swap',
  axes: ['opsz'],
  adjustFontFallback: false,
});
const geist = Geist({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-geist',
  display: 'swap',
  adjustFontFallback: false,
});
const naskh = Noto_Naskh_Arabic({ subsets: ['arabic'], weight: ['400', '500', '600'], variable: '--font-naskh', display: 'swap' });

export const metadata: Metadata = {
  title: 'Operator',
  description: 'Your Mission Lead launches a physical product with you: brand, product, supply, commerce, compliance and demand.',
  robots: { index: false, follow: false },
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7F7F5' },
    { media: '(prefers-color-scheme: dark)', color: '#141414' },
  ],
};

/** Theme and language come from cookies the host sets (OD-U1: light by default), so the first paint is right in both directions. */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const store = await cookies();
  const lang = store.get('lo-lang')?.value === 'ar' ? 'ar' : 'en';
  const theme = store.get('lo-theme')?.value === 'dark' ? 'dark' : 'light';
  return (
    <html
      lang={lang}
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      data-theme={theme}
      className={`${newsreader.variable} ${geist.variable} ${naskh.variable}`}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
