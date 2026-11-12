import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentActor } from '../../lib/auth';
import { listMissionIds } from '../../lib/snapshot';
import { PublicFrame } from '../../components/account/PublicFrame';
import { BrandLockup } from '../../components/account/BrandLockup';
import { StartMission } from '../../components/account/StartMission';
import { EmptyBlock } from '../../components/page/Blocks';
import { I18nProvider } from '../../i18n';
import { languageFromCookie, translate } from '../../i18n/messages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Start a mission · Operator', robots: { index: false, follow: false } };

/**
 * The empty authenticated workspace: one sentence, one action. The mission, its first questions and
 * every figure come from the server's ledgers after creation; nothing is shown before it exists.
 */
export default async function OnboardingPage() {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  const ids = await listMissionIds(actor.authUserId).catch(() => [] as string[]);
  const lang = languageFromCookie((await cookies()).get('lo-lang')?.value);
  const t = (k: Parameters<typeof translate>[1]) => translate(lang, k);
  return (
    <I18nProvider lang={lang} timeZone="UTC">
      <PublicFrame
        lang={lang}
        strip={
          <>
            <BrandLockup label={t('appName')} />
            <div className="working" role="status">
              <i className="dot idle" aria-hidden="true" />
              <span>{t('idle')}</span>
            </div>
            {actor.local ? <span className="sandbox-tag">{t('money_sandbox')}</span> : null}
          </>
        }
      >
        <h1 className="title untitled">{t('onboard_title')}</h1>
        <p className="lede pub-lede">{t('onboard_lede')}</p>
        <EmptyBlock text={t('onboard_note')} />
        <StartMission />
        {ids.length ? (
          <p className="pub-foot">
            <a className="link" href="/">
              {t('onboard_back')}
            </a>
          </p>
        ) : null}
      </PublicFrame>
    </I18nProvider>
  );
}
