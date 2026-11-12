import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { readValidationPage } from '@lo/runtime';
import { PublicFrame } from '../../../components/account/PublicFrame';
import { ValidationForm } from '../../../components/account/ValidationForm';
import { safeImageUrl } from '../../../components/account/safeUrl';
import { I18nProvider } from '../../../i18n';
import { languageFromCookie, translate } from '../../../i18n/messages';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

/** Approved content only; anything the runtime does not return is a 404, never a placeholder. */
async function load(slug: string) {
  try {
    return await readValidationPage(slug);
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const page = await load((await params).slug);
  return page
    ? { title: page.title, description: page.description, robots: { index: false, follow: false } }
    : { title: 'Not found', robots: { index: false, follow: false } };
}

/**
 * Public validation page (FR-PLY-08, Demand). Renders the approved title, description, image and
 * consent text as plain text (no HTML from content), with a sandbox label when the page is a test.
 */
export default async function ValidationPage({ params }: Params) {
  const page = await load((await params).slug);
  if (!page) notFound();
  const lang = languageFromCookie((await cookies()).get('lo-lang')?.value);
  const image = safeImageUrl(page.imageUrl);
  return (
    <I18nProvider lang={lang} timeZone="UTC">
      <PublicFrame strip={<span className="mn bidi">{page.title}</span>} lang={lang}>
        {page.sandbox ? (
          <p className="sandbox-tag" role="note">
            {translate(lang, 'val_sandbox')}
          </p>
        ) : null}
        <h1 className="title bidi">{page.title}</h1>
        {/* eslint-disable-next-line @next/next/no-img-element -- approved https image from the ledger, no optimiser domain list */}
        {image ? <img className="pub-img" src={image} alt="" referrerPolicy="no-referrer" /> : null}
        <p className="lede pub-lede bidi">{page.description}</p>
        <ValidationForm slug={page.slug} consentText={page.consentText} />
      </PublicFrame>
    </I18nProvider>
  );
}
