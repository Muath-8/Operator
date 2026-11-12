import { isLocalSqliteBackend } from '../../lib/local-backend';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { environment } from '@lo/runtime';
import { currentActor } from '../../lib/auth';
import { PublicFrame } from '../../components/account/PublicFrame';
import { BrandLockup } from '../../components/account/BrandLockup';
import { SignIn } from '../../components/account/SignIn';
import { I18nProvider } from '../../i18n';
import { languageFromCookie, translate } from '../../i18n/messages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in · Operator', robots: { index: false, follow: false } };

/**
 * Sign-in. Local mode offers one explicit sandbox button; hosted mode sends an email magic link.
 * Only the public Supabase URL and anon key reach the browser; no provider keys are asked for.
 */
export default async function LoginPage() {
  if (await currentActor().catch(() => null)) redirect('/');
  const lang = languageFromCookie((await cookies()).get('lo-lang')?.value);
  const t = (k: Parameters<typeof translate>[1]) => translate(lang, k);
  let local = false;
  let supabaseUrl: string | null = null;
  let supabaseAnonKey: string | null = null;
  try {
    const env = environment();
    local = env.LO_EXECUTION_MODE === 'local' && env.NODE_ENV !== 'production';
    supabaseUrl = isLocalSqliteBackend() ? null : env.SUPABASE_URL ?? null;
    supabaseAnonKey = isLocalSqliteBackend() ? null : env.SUPABASE_ANON_KEY ?? null;
  } catch {
    // Misconfigured server: the form says sign-in is not configured rather than failing.
  }
  return (
    <I18nProvider lang={lang} timeZone="UTC">
      <PublicFrame strip={<BrandLockup label={t('appName')} />} lang={lang}>
        <h1 className="title">{t('login_title')}</h1>
        <p className="lede pub-lede">{t('login_lede')}</p>
        <SignIn local={local} supabaseUrl={supabaseUrl} supabaseAnonKey={supabaseAnonKey} />
      </PublicFrame>
    </I18nProvider>
  );
}
