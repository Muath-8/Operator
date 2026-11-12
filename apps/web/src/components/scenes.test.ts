import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CommandResult, MissionCommands, MissionView, MissionWorkspaceProps, UiLanguage } from '../ui-contract';
import { translate } from '../i18n';
import { MISSIONS, perfumeMission } from '../../tests/ui/fixtures/missions.fixture';
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
} from '../../tests/ui/fixtures/variants.fixture';
import { MissionWorkspace } from './MissionWorkspace';

/**
 * Server render of every harness scene (explicit test fixtures): what the founder sees before any
 * script runs must already be honest. Interaction and axe run in the browser suite (tests/ui).
 */
const noop = async (): Promise<CommandResult> => ({ ok: true, ledgerVersion: 0 });
const commands = new Proxy({}, { get: () => noop }) as MissionCommands;
const render = (view: MissionView, language: UiLanguage = 'en', status: 'live' | 'connecting' | 'offline' = 'live') => {
  const props: MissionWorkspaceProps = {
    view,
    missions: MISSIONS,
    connection: { status, lastSyncedAt: null },
    commands,
    host: { selectMission: () => undefined, setPreferences: () => undefined },
    theme: 'light',
    language,
  };
  return renderToString(createElement(MissionWorkspace, props));
};
const en = (k: Parameters<typeof translate>[1], v?: Parameters<typeof translate>[2]) => translate('en', k, v);
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
const section = (html: string, cls: string) => {
  const i = html.indexOf(`class="${cls}"`);
  return i < 0 ? '' : html.slice(i, html.indexOf('</section>', i));
};

describe('scenes, server render', () => {
  it('a frozen zero-money mandate offers no money field and says so', () => {
    const html = text(render(mandateZeroScene()));
    expect(html).toContain('class="scope-fixed"');
    expect(html).toContain(en('scopeNoSpend'));
    expect(html).not.toMatch(/inputMode="decimal"|inputmode="decimal"/);
  });

  it('a mandate with a ceiling shows the editable scope on the recommended option only', () => {
    expect(render(mandateScene())).toMatch(/class="scope[ "]/);
    // Owned by a non-recommended option: the recommended selection shows no scope editor.
    expect(render(mandateNonRecommendedScene())).not.toMatch(/class="scope[ "]/);
  });

  it('an incomplete kit is never presented as a task', () => {
    const html = text(render(kitIncompleteScene()));
    const kit = section(html, 'kit incomplete');
    expect(kit).not.toBe('');
    expect(kit).toContain('isn’t ready for you yet');
    expect(kit).not.toContain('<dl');
  });

  it('the header shows active time with its trust glyph and discloses unreviewed guidance on request', () => {
    const html = text(render(headerScene()));
    expect(html).toContain(en('activeTime'));
    expect(html).toMatch(/class="toggle know unverified"[^>]*aria-expanded="false"/);
    expect(html).toContain(en('know_unverified'));
    expect(html).not.toContain('id="knowledge-body"');
  });

  it('a streaming entry carries one caret and says it is still being written; finished ones carry none', () => {
    const streaming = text(render(streamingScene()));
    expect(streaming.match(/class="caret"/g)?.length).toBe(1);
    expect(streaming).toContain(en('drafting'));
    const done = render(mandateScene());
    expect(done).not.toContain('class="caret"');
  });

  it('a payment decision shows payee, provider and sandbox; a shared payment shows once per selection', () => {
    const html = text(render(paymentScene()));
    expect(html).toContain('Supplier B');
    expect(html).toContain('PayPal');
    expect(html).toMatch(/sandbox/i);
    const shared = render(paymentSharedScene());
    expect(shared.match(/class="pay[ "]/g)?.length).toBe(1);
  });

  it('pause and end are stated as banners; read-only access cannot decide', () => {
    expect(text(render(pausedScene()))).toContain(en('pausedBanner'));
    expect(text(render(closingScene()))).toContain(en('endedBanner'));
    const viewer = render(viewerScene());
    expect(viewer).not.toMatch(/<button[^>]*class="btn primary"(?![^>]*disabled)(?![^>]*aria-disabled="true")[^>]*>/);
  });

  it('a first connection is not announced in the server HTML; offline is', () => {
    expect(text(render(mandateScene(), 'en', 'connecting'))).not.toContain(en('connectingBanner'));
    expect(text(render(mandateScene(), 'en', 'offline'))).toContain(en('offlineBanner'));
  });

  it('a canvas is server-rendered hidden until its frames are placed', () => {
    const html = render(perfumeMission());
    expect(html).toContain('class="cv');
    expect(html).toContain('class="world pending"');
  });

  it('an empty money peek says what is missing instead of showing bare headings', () => {
    const v = mandateScene(); // focus: the money view, opened beside the page
    const html = text(render({ ...v, money: { ...v.money, envelopes: [], mandates: [], receipts: [] } }));
    expect(html).toContain(en('money_noEnvelopes'));
    expect(html).toContain(en('money_noMandates'));
    expect(html).toContain(en('money_noReceipts'));
    expect(html).not.toMatch(/<tbody><\/tbody>/);
  });

  it('every scene renders in Arabic, right to left, without English chrome in its banners', () => {
    for (const scene of [mandateZeroScene, kitIncompleteScene, headerScene, pausedScene, paymentSharedScene]) {
      const html = text(render(scene(), 'ar'));
      expect(html).toMatch(/dir="rtl"|lang="ar"/);
      expect(html).not.toContain(en('pausedBanner'));
      expect(html).not.toContain(en('scopeNoSpend'));
    }
  });
});
