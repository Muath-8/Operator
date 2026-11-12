import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n';
import { translate } from '../../i18n/messages';
import { MISSIONS, perfumeMission } from '../../../tests/ui/fixtures/missions.fixture';
import { buildPaletteItems } from '../shell/palette';
import { isShopDomain, parseAccounts, parseDeletionNotice, safeShopifyRedirect } from './accountApi';
import { ACCOUNTS_RESPONSE } from '../../../tests/ui/fixtures/account.fixture';
import { safeImageUrl } from './safeUrl';
import { isAuthFragment, readFragment, sessionBody, SignIn, takeFragment } from './SignIn';
import { checkScope } from '../workspace/scope';
import { StartMission } from './StartMission';
import { ValidationForm } from './ValidationForm';

const wrap = (el: ReturnType<typeof createElement>, lang: 'en' | 'ar' = 'en') =>
  renderToString(createElement(I18nProvider, { lang, timeZone: 'UTC', children: el }));

describe('deletion notice (FR-ACC-06)', () => {
  it('lists only what the server sent, labelled from real fields', () => {
    const n = parseDeletionNotice({
      retainedAccounts: [{ id: 'a1', provider: 'shopify', status: 'active', scopes: ['products'] }],
      retainedExternalAssets: [{ id: 'x1', title: 'Logo set v2', type: 'visual', status: 'approved' }],
      notice: 'External accounts remain yours.',
    });
    expect(n.retainedAccounts).toEqual([{ id: 'a1', label: 'shopify', detail: 'active' }]);
    expect(n.retainedExternalAssets[0]).toEqual({ id: 'x1', label: 'Logo set v2', detail: 'visual, approved' });
    expect(n.notice).toBe('External accounts remain yours.');
  });

  it('accepts genuinely empty lists, but rejects any row it cannot identify and name', () => {
    expect(parseDeletionNotice({ retainedAccounts: [], retainedExternalAssets: [], notice: 'n' })).toEqual({
      retainedAccounts: [],
      retainedExternalAssets: [],
      notice: 'n',
    });
    expect(() => parseDeletionNotice({ retainedAccounts: [], retainedExternalAssets: [{ id: 'x2' }], notice: 'n' })).toThrow();
    expect(() => parseDeletionNotice({ retainedAccounts: [{ label: 'paypal' }], retainedExternalAssets: [], notice: 'n' })).toThrow();
    expect(() => parseDeletionNotice({ retainedAccounts: [{ id: 'a', label: '' }], retainedExternalAssets: [], notice: 'n' })).toThrow();
    expect(() => parseDeletionNotice({ retainedAccounts: [], retainedExternalAssets: [] })).toThrow();
  });

  it('keeps structured {id,label,detail} rows exactly, including references with underscores', () => {
    const n = parseDeletionNotice({
      retainedAccounts: [{ id: 'f1', label: 'paypal', detail: 'Founder-owned external account; revoking access does not close it.' }],
      retainedExternalAssets: [
        { id: 'r1', label: 'marketing_publish', detail: 'meta: post_123_abc. This published asset remains with its provider.' },
      ],
      notice: 'n',
    });
    expect(n.retainedAccounts[0]).toEqual({
      id: 'f1',
      label: 'paypal',
      detail: 'Founder-owned external account; revoking access does not close it.',
    });
    expect(n.retainedExternalAssets[0]).toEqual({
      id: 'r1',
      label: 'marketing publish',
      detail: 'meta: post_123_abc. This published asset remains with its provider.',
    });
  });

  it('maps the published accounts shape without ever claiming verified ownership', () => {
    const a = parseAccounts(ACCOUNTS_RESPONSE);
    expect(a.accounts.map(x => [x.label, x.status, x.check, x.canRevoke])).toEqual([
      ['Resend', 'connected', 'passed', true],
      ['PayPal', 'connected', 'pending', true],
      ['Twilio', 'revoked', 'passed', false],
    ]);
    expect(a.accounts[1]?.reason).toContain('read-only');
    expect(a.accounts[0]?.scopes).toEqual(['send email', 'read delivery status']);
    expect(JSON.stringify(a)).not.toMatch(/"verified"/);
    // A valid empty inventory is "no accounts"; anything incomplete is a load failure.
    expect(parseAccounts({ ok: true, value: { accounts: [] } }).accounts).toEqual([]);
    const row = ACCOUNTS_RESPONSE.value.accounts[1];
    for (const bad of [
      { ...row, verification: { ...row?.verification, status: 'maybe' } },
      { ...row, status: 'verified' },
      { ...row, accountId: '' },
      { ...row, scopes: 'send_email' },
      { ...row, sandboxMode: 'yes' },
      { ...row, verification: undefined },
    ])
      expect(() => parseAccounts({ ok: true, value: { accounts: [bad] } })).toThrow();
    expect(() => parseAccounts({ ok: false, error: { code: 'rejected', message: 'x', retryable: false } })).toThrow();
    expect(() => parseAccounts(null)).toThrow();
  });

  it('follows only https Shopify authorize URLs on the same shop', () => {
    expect(isShopDomain('my-store.myshopify.com')).toBe(true);
    expect(isShopDomain('evil.com')).toBe(false);
    expect(safeShopifyRedirect('https://my-store.myshopify.com/admin/oauth/authorize?client_id=1', 'my-store.myshopify.com')).toContain(
      '/admin/oauth/authorize',
    );
    expect(safeShopifyRedirect('https://other.myshopify.com/admin/oauth/authorize', 'my-store.myshopify.com')).toBeNull();
    expect(safeShopifyRedirect('http://my-store.myshopify.com/admin/oauth/authorize', 'my-store.myshopify.com')).toBeNull();
  });

  it('treats a malformed disclosure as a load failure, never as an empty list', () => {
    expect(() => parseDeletionNotice('nope')).toThrow();
    expect(() => parseDeletionNotice({ retainedAccounts: 'x', retainedExternalAssets: [], notice: 'n' })).toThrow();
    expect(() => parseDeletionNotice({ retainedAccounts: [], retainedExternalAssets: null, notice: 'n' })).toThrow();
  });

  it('is offered to owners only, with sign-out for everyone', () => {
    const ctx = {
      t: (k: Parameters<typeof translate>[1], v?: Parameters<typeof translate>[2]) => translate('en', k, v),
      date: (d: string) => d,
      theme: 'light' as const,
      language: 'en' as const,
      canDecide: true,
    };
    const owner = buildPaletteItems(perfumeMission(), MISSIONS, ctx);
    expect(owner.some(i => i.action.k === 'deleteMission')).toBe(true);
    expect(owner.some(i => i.action.k === 'signOut')).toBe(true);
    const viewer = buildPaletteItems(
      { ...perfumeMission(), access: { role: 'viewer', canDecide: false, canMessage: false, canGrantMandates: false } },
      MISSIONS,
      { ...ctx, canDecide: false },
    );
    expect(viewer.some(i => i.action.k === 'deleteMission')).toBe(false);
  });
});

describe('mandate scope is narrow-only', () => {
  const scope = {
    ceiling: { amountMinor: 250000, currency: 'SAR' },
    ceilingMax: { amountMinor: 900000, currency: 'SAR' },
    count: 4,
    countMax: 9,
    countUnit: 'suppliers',
    expiresOn: '2026-11-30',
    expiresMax: '2026-12-31',
  };
  it('accepts the frozen draft and narrower values', () => {
    expect(checkScope({ ceilingMajor: '2500', count: '4', expiresOn: '2026-11-30' }, scope)).toMatchObject({ ok: true, narrowed: false });
    expect(checkScope({ ceilingMajor: '1200', count: '2', expiresOn: '2026-11-20' }, scope)).toMatchObject({
      ok: true,
      narrowed: true,
      value: { ceiling: { amountMinor: 120000 }, count: 2 },
    });
  });
  it('never widens beyond the frozen draft, even when a server maximum is higher', () => {
    expect(checkScope({ ceilingMajor: '2600', count: '4', expiresOn: '2026-11-30' }, scope)).toEqual({ ok: false, field: 'ceiling' });
    expect(checkScope({ ceilingMajor: '2500', count: '5', expiresOn: '2026-11-30' }, scope)).toEqual({ ok: false, field: 'count' });
    expect(checkScope({ ceilingMajor: '2500', count: '4', expiresOn: '2026-12-01' }, scope)).toEqual({ ok: false, field: 'expiresOn' });
  });
});

describe('public validation page (FR-PLY-08)', () => {
  it('accepts only https images without credentials', () => {
    expect(safeImageUrl('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
    expect(safeImageUrl('http://cdn.example.com/a.jpg')).toBeNull();
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageUrl('data:image/png;base64,AAA')).toBeNull();
    expect(safeImageUrl('https://user:pass@example.com/a.jpg')).toBeNull();
    expect(safeImageUrl(null)).toBeNull();
  });

  it('renders consent unchecked, a hidden honeypot, and content as text', () => {
    const html = wrap(createElement(ValidationForm, { slug: 'sandbox-test', consentText: 'I agree <b>to be emailed</b> once.' }));
    expect(html).toMatch(/<input type="checkbox" name="consent"(?![^>]*checked)[^>]*>/);
    const hp = html.match(/<div class="hp" aria-hidden="true">([\s\S]*?)<\/div>/)?.[1] ?? '';
    expect(hp).toMatch(/<input[^>]*name="website"/);
    expect(hp).toMatch(/tabindex="-1"/);
    expect(hp).toMatch(/value=""/);
    expect(html).toContain('I agree &lt;b&gt;to be emailed&lt;/b&gt; once.');
    expect(html).not.toContain('Your signup was recorded');
  });
});

describe('sign-in and onboarding', () => {
  it('reads both session tokens from a magic-link fragment', () => {
    expect(readFragment('#access_token=abc&refresh_token=r1&token_type=bearer')).toEqual({ token: 'abc', refreshToken: 'r1', error: null });
    expect(readFragment('#error=access_denied&error_description=Link+expired')).toEqual({
      token: null,
      refreshToken: null,
      error: 'Link expired',
    });
    expect(readFragment('')).toEqual({ token: null, refreshToken: null, error: null });
    expect(readFragment(`#access_token=${'x'.repeat(10001)}`).token).toBeNull();
  });

  it('detects auth fragments however they are encoded, and leaves ordinary anchors alone', () => {
    for (const h of [
      '#access%5Ftoken=a',
      '#refresh%5ftoken=r',
      '#access%255Ftoken=a',
      '#%61ccess_token=a',
      '#access_token=%E0%A4%A',
      '#ACCESS_TOKEN=a',
      '#error=access_denied',
    ])
      expect(isAuthFragment(h), h).toBe(true);
    for (const h of ['#section', '#chapter-body', '']) expect(isAuthFragment(h), h).toBe(false);
  });

  it('sends only the accepted fields to the HttpOnly session endpoint', () => {
    expect(sessionBody({ token: 'a', refreshToken: 'r', error: null })).toEqual({ token: 'a', refreshToken: 'r' });
    expect(sessionBody({ token: 'a', refreshToken: null, error: null })).toEqual({ token: 'a' });
    expect(sessionBody({ token: null, refreshToken: 'r', error: null })).toBeNull();
  });

  it('clears the fragment from the address bar before the exchange, keeping path and query', () => {
    const calls: string[] = [];
    const f = takeFragment(
      { hash: '#access_token=a&refresh_token=r', pathname: '/login', search: '?next=1' },
      { replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void calls.push(String(url)) },
    );
    expect(f?.token).toBe('a');
    expect(calls).toEqual(['/login?next=1']);
    expect(takeFragment({ hash: '#section', pathname: '/login', search: '' }, { replaceState: () => calls.push('x') })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('labels local sign-in as sandbox and never asks for keys', () => {
    const local = wrap(createElement(SignIn, { local: true, supabaseUrl: null, supabaseAnonKey: null }));
    expect(local).toContain('Sign in to the local sandbox');
    expect(local).toContain('Sandbox: local test data');
    expect(local).not.toMatch(/api key|secret|password/i);
    const hosted = wrap(createElement(SignIn, { local: false, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' }));
    expect(hosted).toContain('Email me a sign-in link');
    expect(hosted).not.toContain('local sandbox');
    const none = wrap(createElement(SignIn, { local: false, supabaseUrl: null, supabaseAnonKey: null }));
    expect(none).toContain('isn’t configured');
  });

  it('starts a mission with one action and no invented history', () => {
    const html = wrap(createElement(StartMission));
    expect(html).toContain('Start a mission');
    expect((html.match(/<button/g) ?? []).length).toBe(1);
    const ar = wrap(createElement(StartMission), 'ar');
    expect(ar).toContain('ابدأ مهمة');
  });
});
