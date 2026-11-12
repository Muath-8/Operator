import { afterEach, describe, expect, it, vi } from 'vitest';
import { endSession, parseAccounts, parseDeletionNotice } from '../components/account/accountApi';
import { takeFragment } from '../components/account/SignIn';

afterEach(() => vi.unstubAllGlobals());

describe('independent account boundary review: I-11, FR-ACC-01/02/06', () => {
  it.each([
    '#refresh_token=private-refresh-only',
    `#access_token=${'x'.repeat(10001)}&refresh_token=private-refresh`,
    '#access_token=&refresh_token=private-refresh',
    '#access%5Ftoken=private-encoded-access',
    '#refresh%5Ftoken=private-encoded-refresh',
  ])('scrubs secret-bearing malformed magic-link fragments before returning (%#)', hash => {
    const replaceState = vi.fn();
    takeFragment({ hash, pathname: '/login', search: '?next=1' }, { replaceState });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/login?next=1');
  });

  it.each([{}, { ok: true }, { ok: true, value: { accounts: 'broken' } }])(
    'rejects malformed account inventories instead of asserting that no accounts exist (%#)',
    response => {
      expect(() => parseAccounts(response)).toThrow();
    },
  );

  it.each([{}, { retainedAccounts: 'broken', retainedExternalAssets: [] }])(
    'rejects incomplete deletion disclosures before a founder can approve erasure (%#)',
    response => {
      expect(() => parseDeletionNotice(response)).toThrow();
    },
  );

  it('does not resolve sign-out when the server rejects cookie removal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Origin denied', { status: 403 })));
    await expect(endSession()).rejects.toThrow();
  });
});
