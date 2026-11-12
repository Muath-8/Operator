import type { UiLanguage } from '../../ui-contract';
import { translate } from '../../i18n/messages';
import { PublicFrame } from './PublicFrame';
import { BrandLockup } from './BrandLockup';

/** 404 body, server-safe: says what happened, that nothing changed, and where to go. */
export function NotFoundView({ lang }: { readonly lang: UiLanguage }) {
  const t = (k: Parameters<typeof translate>[1]) => translate(lang, k);
  return (
    <PublicFrame strip={<BrandLockup label={t('appName')} />} lang={lang}>
      <p className="nf-code" aria-hidden="true">
        404
      </p>
      <h1 className="title">{t('nf_title')}</h1>
      <p className="lede pub-lede">{t('nf_lede')}</p>
      <p className="pub-block">
        <a className="btn primary" href="/">
          {t('nf_home')}
        </a>
      </p>
    </PublicFrame>
  );
}
