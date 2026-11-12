'use client';

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { MissionWorkspace } from '../../../src/components';
import type { ConnectionView, MissionView, Target, Theme, UiLanguage } from '../../../src/ui-contract';
import { FakeMissionServer } from '../fixtures/fakeServer.fixture';
import { MISSIONS_WITH_NEW } from '../fixtures/missions.fixture';
import {
  closingScene,
  headerScene,
  kitIncompleteScene,
  mandateNonRecommendedScene,
  mandateScene,
  mandateZeroScene,
  pausedScene,
  paymentScene,
  paymentSharedScene,
  streamingScene,
  viewerScene,
} from '../fixtures/variants.fixture';
import { ACCOUNTS, DELETION_NOTICE, VALIDATION_PAGE } from '../fixtures/account.fixture';
import { PublicFrame } from '../../../src/components/account/PublicFrame';
import { NotFoundView } from '../../../src/components/account/NotFoundView';
import { SignIn } from '../../../src/components/account/SignIn';
import { StartMission } from '../../../src/components/account/StartMission';
import { ValidationForm } from '../../../src/components/account/ValidationForm';
import { EmptyBlock } from '../../../src/components/page/Blocks';
import { I18nProvider } from '../../../src/i18n';
import { translate } from '../../../src/i18n/messages';

/**
 * TEST HARNESS ONLY. The real MissionWorkspace against the in-memory fake server, driven by the URL:
 * ?m=m1|m2|m3&theme=dark&lang=ar&scene=payment|closing|streaming|paused|viewer&conn=offline&peek=none&open=money|brand|…&latency=ms&lag=ms
 * Mount it standalone (main.tsx) or at a dev-only Next route. Never ship it.
 */
const SCENES: Record<string, () => MissionView> = {
  payment: paymentScene,
  closing: closingScene,
  streaming: streamingScene,
  paused: pausedScene,
  viewer: viewerScene,
  mandate: mandateScene,
  'mandate-nonrec': mandateNonRecommendedScene,
  'mandate-zero': mandateZeroScene,
  'payment-shared': paymentSharedScene,
  'kit-incomplete': kitIncompleteScene,
  header: headerScene,
};
const SYSTEM = ['money', 'readiness', 'log', 'notifications', 'plates', 'record', 'accounts'];

type HarnessWindow = Window & { __server?: FakeMissionServer; __setConnection?: (s: ConnectionView['status']) => void };

export function Harness({ search }: { readonly search: string }) {
  const q = useMemo(() => new URLSearchParams(search), [search]);
  const [server] = useState(() => {
    const s = new FakeMissionServer({ latencyMs: Number(q.get('latency') ?? 350), lagMs: Number(q.get('lag') ?? 300) });
    const scene = q.get('scene');
    const make = scene ? SCENES[scene] : undefined;
    if (make) s.setView(make());
    return s;
  });
  const [missionId, setMissionId] = useState(q.get('m') ?? 'm1');
  const [view, setView] = useState<MissionView>(() => {
    const v = server.view(missionId);
    return q.get('peek') === 'none' ? { ...v, focus: null } : v;
  });
  const [theme, setTheme] = useState<Theme>(q.get('theme') === 'dark' ? 'dark' : 'light');
  const [language, setLanguage] = useState<UiLanguage>(q.get('lang') === 'ar' ? 'ar' : 'en');
  const [connection, setConnection] = useState<ConnectionView>({
    status: (q.get('conn') as ConnectionView['status'] | null) ?? 'live',
    lastSyncedAt: '2026-11-12T09:30:00+03:00',
  });

  useEffect(() => server.subscribe(v => v.missionId === missionId && setView(v)), [server, missionId]);
  useEffect(() => {
    const w = window as HarnessWindow;
    w.__server = server;
    w.__setConnection = s => setConnection({ status: s, lastSyncedAt: '2026-11-12T09:30:00+03:00' });
  }, [server]);

  useLayoutEffect(() => {
    // Install before child passive effects issue their initial request.
    // TEST ONLY: explicit metadata transport paired with the fixture command server.
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const match = /^\/api\/missions\/([^/]+)\/privacy$/.exec(url.pathname);
      if (match?.[1])
        return new Response(JSON.stringify(server.privacy(decodeURIComponent(match[1]))), {
          headers: { 'Content-Type': 'application/json' },
        });
      return original(input, init);
    };
    return () => {
      window.fetch = original;
    };
  }, [server]);

  const open = q.get('open');
  const publicPage = q.get('page');
  const initialTarget = useMemo<Target | null>(
    () => (open ? (SYSTEM.includes(open) ? { kind: 'system', view: open as 'money' } : { kind: 'artifact', artifactId: open }) : null),
    [open],
  );

  if (publicPage) return <PublicHarness page={publicPage} language={language} />;

  return (
    <MissionWorkspace
      view={view}
      missions={MISSIONS_WITH_NEW.filter(m => m.id !== 'm3' || missionId === 'm3')}
      connection={connection}
      commands={server.commands}
      theme={theme}
      language={language}
      initialTarget={initialTarget}
      host={{
        selectMission: id => {
          setMissionId(id);
          setView(server.view(id));
        },
        setPreferences: p => {
          if (p.theme) setTheme(p.theme);
          if (p.language) setLanguage(p.language);
        },
        loadDeletionNotice: async () => {
          await new Promise(r => setTimeout(r, 200));
          return DELETION_NOTICE;
        },
        deleteMission: async () => {
          await new Promise(r => setTimeout(r, 400));
          return { ok: false, message: '' };
        },
        signOut: async () => {
          await new Promise(r => setTimeout(r, 200));
          // ?signout=fail simulates the server refusing to clear the session (HTTP 403).
          if (q.get('signout') === 'fail') throw new Error('Sign-out was not confirmed (HTTP 403)');
        },
        loadAccounts: async () => {
          await new Promise(r => setTimeout(r, 150));
          return ACCOUNTS;
        },
        revokeAccount: async () => {
          await new Promise(r => setTimeout(r, 300));
          return { ok: false, message: 'The provider did not confirm.' };
        },
      }}
    />
  );
}

/** Public surfaces with the same frame the routes use; data comes from fixtures, never the routes. */
function PublicHarness({ page, language }: { readonly page: string; readonly language: UiLanguage }) {
  const t = (k: Parameters<typeof translate>[1]) => translate(language, k);
  if (page === 'notfound') return <NotFoundView lang={language} />;
  return (
    <I18nProvider lang={language} timeZone="UTC">
      {page.startsWith('login') ? (
        <PublicFrame strip={<span className="mn">{t('appName')}</span>}>
          <h1 className="title">{t('login_title')}</h1>
          <p className="lede pub-lede">{t('login_lede')}</p>
          <SignIn
            local={page === 'login-local' || page === 'login-both'}
            supabaseUrl={page === 'login-local' ? null : 'https://project.supabase.co'}
            supabaseAnonKey={page === 'login-local' ? null : 'public-anon-key'}
          />
        </PublicFrame>
      ) : page === 'onboarding' ? (
        <PublicFrame
          strip={
            <>
              <span className="mn">{t('appName')}</span>
              <div className="working" role="status">
                <i className="dot idle" aria-hidden="true" />
                <span>{t('idle')}</span>
              </div>
            </>
          }
        >
          <h1 className="title untitled">{t('onboard_title')}</h1>
          <p className="lede pub-lede">{t('onboard_lede')}</p>
          <EmptyBlock text={t('onboard_note')} />
          <StartMission />
        </PublicFrame>
      ) : (
        <PublicFrame strip={<span className="mn bidi">{VALIDATION_PAGE.title}</span>}>
          {VALIDATION_PAGE.sandbox ? (
            <p className="sandbox-tag" role="note">
              {t('val_sandbox')}
            </p>
          ) : null}
          <h1 className="title bidi">{VALIDATION_PAGE.title}</h1>
          <p className="lede pub-lede bidi">{VALIDATION_PAGE.description}</p>
          <ValidationForm slug={VALIDATION_PAGE.slug} consentText={VALIDATION_PAGE.consentText} />
        </PublicFrame>
      )}
    </I18nProvider>
  );
}
