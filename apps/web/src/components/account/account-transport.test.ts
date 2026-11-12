import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAccounts, fetchDeletionNotice, requestDeletion, revokeAccountAccess, startShopifyConnect, endSession } from './accountApi';
import { DELETION_NOTICE } from '../../../tests/ui/fixtures/account.fixture';
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
describe('actual founder account HTTP transport boundaries', () => {
  it('loads the complete deletion disclosure and refuses HTTP or malformed partial success', async () => {
    fetchMock.mockResolvedValueOnce(response(DELETION_NOTICE));
    expect(await fetchDeletionNotice('mission/id')).toEqual(DELETION_NOTICE);
    expect(fetchMock).toHaveBeenCalledWith('/api/missions/mission%2Fid/deletion', { cache: 'no-store' });
    fetchMock.mockResolvedValueOnce(response({}, 403));
    await expect(fetchDeletionNotice('foreign')).rejects.toThrow('HTTP 403');
    fetchMock.mockResolvedValueOnce(response({ retainedAccounts: [] }));
    await expect(fetchDeletionNotice('mission')).rejects.toThrow();
  });
  it('sends both deletion acknowledgements and treats transport uncertainty as failure', async () => {
    fetchMock.mockResolvedValueOnce(response({ ok: true, receiptId: 'receipt' }));
    expect(await requestDeletion('mission')).toEqual({ ok: true, receiptId: 'receipt' });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ confirm: true, understandExternalAssetsRemain: true });
    fetchMock.mockResolvedValueOnce(response({ ok: true, receiptId: 'not-authoritative' }, 503));
    expect((await requestDeletion('mission')).ok).toBe(false);
    fetchMock.mockResolvedValueOnce(response({ error: { message: 'Refresh current state' } }, 409));
    expect(await requestDeletion('mission')).toEqual({ ok: false, message: 'Refresh current state' });
    fetchMock.mockRejectedValueOnce(new Error('network'));
    expect((await requestDeletion('mission')).ok).toBe(false);
  });
  it('requires a valid account inventory instead of upgrading an unreadable response to an empty list', async () => {
    fetchMock.mockResolvedValueOnce(response({ ok: true, value: { accounts: [] } }));
    expect(await fetchAccounts('mission')).toEqual({ accounts: [] });
    fetchMock.mockResolvedValueOnce(response({}, 500));
    await expect(fetchAccounts('mission')).rejects.toThrow('HTTP 500');
    fetchMock.mockResolvedValueOnce(response({ ok: true, value: {} }));
    await expect(fetchAccounts('mission')).rejects.toThrow();
  });
  it('accepts only server-confirmed revocation and preserves the exact account scope', async () => {
    fetchMock.mockResolvedValueOnce(response({ ok: true, revokedAt: '2026-11-12T10:00:00Z' }));
    expect((await revokeAccountAccess('mission', 'account/id')).ok).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/missions/mission/accounts/account%2Fid');
    fetchMock.mockResolvedValueOnce(response({ error: 'Provider refused' }, 503));
    expect(await revokeAccountAccess('mission', 'account')).toEqual({ ok: false, message: 'Provider refused' });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect((await revokeAccountAccess('mission', 'account')).ok).toBe(false);
  });
  it('posts an explicit Shopify ownership attestation and refuses HTTP failures disguised as authorization', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ ok: true, value: { authorizationUrl: 'https://example.myshopify.com/admin/oauth/authorize' } }),
    );
    expect((await startShopifyConnect('mission', ' Example.myshopify.com ')).ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ shopDomain: 'example.myshopify.com', founderAttestsOwnership: true });
    fetchMock.mockResolvedValueOnce(response({ ok: true, value: { authorizationUrl: 'https://unsafe.example' } }, 403));
    expect((await startShopifyConnect('mission', 'example.myshopify.com')).ok).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect((await startShopifyConnect('mission', 'example.myshopify.com')).ok).toBe(false);
  });
  it('keeps the session active unless both HTTP and logout acknowledgement confirm success', async () => {
    fetchMock.mockResolvedValueOnce(response({ ok: true }));
    await expect(endSession()).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(response({ ok: true }, 403));
    await expect(endSession()).rejects.toThrow('HTTP 403');
    fetchMock.mockResolvedValueOnce(response({ ok: false }));
    await expect(endSession()).rejects.toThrow('not confirmed');
    fetchMock.mockResolvedValueOnce(new Response('broken'));
    await expect(endSession()).rejects.toThrow('not confirmed');
  });
});
