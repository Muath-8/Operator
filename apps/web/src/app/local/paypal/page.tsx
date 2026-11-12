import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { currentActor } from '../../../lib/auth';
import { isLocalSqliteBackend } from '../../../lib/local-backend';
import { localPayPalStatus } from '@lo/runtime/local-paypal';
import { PublicFrame } from '../../../components/account/PublicFrame';
import { BrandLockup } from '../../../components/account/BrandLockup';
import { PayPalSandbox } from './sandbox';
import { paypalCopy } from './copy';

export const dynamic = 'force-dynamic';
export default async function LocalPayPalPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isLocalSqliteBackend()) notFound();
  if (!(await currentActor())) redirect('/login');
  const lang = (await cookies()).get('lo-lang')?.value === 'ar' ? 'ar' : 'en';
  const copy = paypalCopy[lang];
  const query = await searchParams;
  const orderId = typeof query['token'] === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(query['token']) ? query['token'] : null;
  return (
    <PublicFrame strip={<BrandLockup label={copy.brand} />} lang={lang}>
      <p className="sandbox-tag">{copy.label}</p>
      <h1 className="title">{copy.title}</h1>
      <p className="lede pub-lede">{copy.intro}</p>
      <PayPalSandbox copy={copy} configured={localPayPalStatus().configured} orderId={orderId} cancelled={query['cancelled'] === '1'} />
      <p className="pub-foot">{copy.note}</p>
      <p className="pub-foot">
        <a href="/">{copy.back}</a>
      </p>
    </PublicFrame>
  );
}
