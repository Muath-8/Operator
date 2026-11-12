import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { NotFoundView } from '../components/account/NotFoundView';
import { languageFromCookie } from '../i18n/messages';

export const metadata: Metadata = { title: 'Not found · Operator', robots: { index: false, follow: false } };

/** 404 for unmatched URLs and notFound(): same frame, themes and directions as the rest of the product. */
export default async function NotFound() {
  return <NotFoundView lang={languageFromCookie((await cookies()).get('lo-lang')?.value)} />;
}
