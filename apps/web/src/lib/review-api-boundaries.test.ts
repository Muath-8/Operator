import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const boundary = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  actor: vi.fn(),
  execute: vi.fn(),
  withRole: vi.fn(),
  query: vi.fn(),
  ledger: vi.fn(),
  drafts: vi.fn(),
  flush: vi.fn(),
  prepare: vi.fn(),
  capture: vi.fn(),
  snapshot: vi.fn(),
  listAccounts: vi.fn(),
  revoke: vi.fn(),
  oauthStart: vi.fn(),
  oauthComplete: vi.fn(),
  validationPage: vi.fn(),
  signup: vi.fn(),
  storageList: vi.fn(),
  storageRemove: vi.fn(),
  cookie: vi.fn(),
  after: [] as (() => Promise<void>)[],
}));
vi.mock('@lo/runtime', () => ({
  environment: () => boundary.env,
  executeFounderCommand: boundary.execute,
  withRole: boundary.withRole,
  ledgerVersion: boundary.ledger,
  readMessageDrafts: boundary.drafts,
  readValidationPage: boundary.validationPage,
  recordWaitlistSignup: boundary.signup,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ storage: { from: () => ({ list: boundary.storageList, remove: boundary.storageRemove }) } }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: boundary.cookie }), headers: async () => new Headers() }));
vi.mock('@lo/runtime/inngest', () => ({ flushOutbox: boundary.flush }));
vi.mock('@lo/runtime/provider-tools', () => ({
  prepareApprovedPayPalOrder: boundary.prepare,
  captureApprovedPayPalOrder: boundary.capture,
}));
vi.mock('@lo/runtime/accounts', () => ({
  listProviderAccounts: boundary.listAccounts,
  revokeProviderAccount: boundary.revoke,
  startShopifyAccountOAuth: boundary.oauthStart,
  completeShopifyAccountOAuth: boundary.oauthComplete,
}));
vi.mock('./auth', async original => ({ ...(await original<typeof import('./auth')>()), currentActor: boundary.actor }));
vi.mock('./snapshot', async original => ({ ...(await original<typeof import('./snapshot')>()), readSnapshot: boundary.snapshot }));
vi.mock('next/server', () => ({ after: (callback: () => Promise<void>) => boundary.after.push(callback) }));
import { POST as command } from '../app/api/commands/route';
import { POST as create } from '../app/api/missions/create/route';
import { POST as presence } from '../app/api/missions/[missionId]/presence/route';
import { GET as stream } from '../app/api/missions/[missionId]/stream/route';
import { GET as deletionNotice, DELETE as deleteMission } from '../app/api/missions/[missionId]/deletion/route';
import { GET as accounts } from '../app/api/missions/[missionId]/accounts/route';
import { DELETE as revoke } from '../app/api/missions/[missionId]/accounts/[accountId]/route';
import { POST as oauthStart } from '../app/api/missions/[missionId]/accounts/shopify/oauth/route';
import { GET as oauthCallback } from '../app/api/missions/[missionId]/accounts/shopify/callback/route';
import { GET as paymentReturn } from '../app/api/payments/return/route';
import { GET as validationPage, POST as signup } from '../app/api/validation/[slug]/route';
const origin = 'http://127.0.0.1:3000',
  user = randomUUID(),
  mission = randomUUID(),
  receipt = randomUUID();
const params = { params: Promise.resolve({ missionId: mission }) };
const request = (body: unknown, from = origin) =>
  new Request(origin, { method: 'POST', headers: { origin: from, 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  boundary.after.length = 0;
  boundary.env = { APP_ORIGIN: origin, LO_EXECUTION_MODE: 'local' };
  boundary.actor.mockResolvedValue({ authUserId: user, local: true });
  boundary.execute.mockResolvedValue({ ok: true, ledgerVersion: 7 });
  boundary.ledger.mockResolvedValue(7);
  boundary.flush.mockResolvedValue(undefined);
  boundary.withRole.mockImplementation(
    async (_role: unknown, _scope: unknown, work: (db: { query: typeof boundary.query }) => Promise<unknown>) =>
      work({ query: boundary.query }),
  );
  boundary.query.mockResolvedValue({ rows: [{ id: receipt }] });
  boundary.drafts.mockResolvedValue([]);
  boundary.snapshot.mockResolvedValue({ founder_accounts: [], provider_receipts: [] });
  boundary.listAccounts.mockResolvedValue({ ok: true, value: { accounts: [] } });
  boundary.revoke.mockResolvedValue({ ok: true, value: { status: 'revoked' } });
  boundary.storageList.mockResolvedValue({ data: [], error: null });
  boundary.storageRemove.mockResolvedValue({ error: null });
  boundary.cookie.mockReturnValue({ value: 'verified-hosted-test-session' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('actual API handler authorization and transport boundaries with repository doubles', () => {
  it('rejects foreign command origins and absent identities before invoking the command', async () => {
    expect((await command(request({}, 'https://attacker.test'))).status).toBe(403);
    boundary.actor.mockResolvedValue(null);
    expect((await command(request({}))).status).toBe(401);
    expect(boundary.execute).not.toHaveBeenCalled();
  });
  it('bounds command bytes and maps validation/conflict/approval/failure honestly', async () => {
    expect((await command(request({ missionId: mission, padding: 'x'.repeat(70000) }))).status).toBe(503);
    expect(boundary.execute).not.toHaveBeenCalled();
    for (const [message, status, code] of [
      ['validation: invalid', 409, 'validation'],
      ['conflict: changed', 409, 'conflict'],
      ['needs_approval: reviewed version required', 409, 'needs_approval'],
      ['database offline', 503, 'unavailable'],
    ] as const) {
      boundary.execute.mockRejectedValueOnce(new Error(message));
      const response = await command(request({ missionId: mission }));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ ok: false, error: { code } });
    }
  });
  it('acknowledges committed commands before dispatch and preserves durable retry when dispatch fails', async () => {
    const response = await command(request({ missionId: mission, idempotencyKey: 'same-request' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ledgerVersion: 7 });
    expect(boundary.execute).toHaveBeenCalledWith(user, { missionId: mission, idempotencyKey: 'same-request' });
    expect(boundary.flush).not.toHaveBeenCalled();
    expect(boundary.after).toHaveLength(1);
    boundary.flush.mockRejectedValueOnce(new Error('synthetic Inngest unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const callback of boundary.after) await callback();
    expect(warning).toHaveBeenCalledWith('runtime_dispatch_pending', { missionId: mission });
  });
  it('reports saved payment approval separately from an unavailable provider approval page', async () => {
    const payment = randomUUID(),
      commandId = randomUUID();
    boundary.execute.mockResolvedValue({ ok: true, ledgerVersion: 7, paymentVersionId: payment, commandId });
    boundary.prepare.mockResolvedValue({ ok: false, error: { code: 'provider_down' } });
    const unavailable = await command(request({ missionId: mission }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ ok: false, error: { message: expect.stringContaining('decision is saved') } });
    boundary.prepare.mockResolvedValue({ ok: true, value: { approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=synthetic' } });
    const ready = await command(request({ missionId: mission }));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ redirectUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=synthetic' });
  });
  it('validates mission creation and schedules its durable outbox after committing', async () => {
    expect((await create(request({}, 'https://attacker.test'))).status).toBe(403);
    boundary.actor.mockResolvedValueOnce(null);
    expect((await create(request({}))).status).toBe(401);
    expect((await create(request({ kind: 'createMission', idempotencyKey: 'short' }))).status).toBe(503);
    expect(boundary.withRole).not.toHaveBeenCalled();
    const response = await create(request({ kind: 'createMission', idempotencyKey: 'bounded-idempotency-key' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, missionId: receipt, ledgerVersion: 7 });
    expect(boundary.query).toHaveBeenCalledWith('select public.start_mission($1,$2) as id', ['bounded-idempotency-key', true]);
    expect(boundary.after).toHaveLength(1);
  });
  it('requires scoped explicit boolean presence and never records malformed or oversized input', async () => {
    expect((await presence(request({ active: true }, 'https://attacker.test'), params)).status).toBe(403);
    boundary.actor.mockResolvedValueOnce(null);
    expect((await presence(request({ active: true }), params)).status).toBe(401);
    for (const body of [{ active: 'true' }, { active: true, extra: true }, { active: true, padding: 'x'.repeat(1100) }])
      expect((await presence(request(body), params)).status).toBe(400);
    expect(boundary.withRole).not.toHaveBeenCalled();
    expect((await presence(request({ active: false }), params)).status).toBe(204);
    expect(boundary.withRole).toHaveBeenCalledWith('founder_role', { authUserId: user, missionId: mission }, expect.any(Function));
    expect(boundary.query).toHaveBeenCalledWith('select public.record_founder_presence($1,$2)', [mission, false]);
  });
  it('keeps account listing/revocation scoped and refuses invalid IDs without invoking account services', async () => {
    boundary.actor.mockResolvedValueOnce(null);
    expect((await accounts(request({}), params)).status).toBe(401);
    expect((await accounts(request({}), { params: Promise.resolve({ missionId: 'invalid' }) })).status).toBe(422);
    expect(boundary.listAccounts).not.toHaveBeenCalled();
    const list = await accounts(request({}), params);
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('private, no-store');
    const account = randomUUID(),
      context = { params: Promise.resolve({ missionId: mission, accountId: account }) };
    expect((await revoke(request({}, 'https://attacker.test'), context)).status).toBe(403);
    expect((await revoke(request({}), { params: Promise.resolve({ missionId: mission, accountId: 'bad' }) })).status).toBe(422);
    expect(boundary.revoke).not.toHaveBeenCalled();
    expect((await revoke(request({}), context)).status).toBe(200);
    expect(boundary.revoke).toHaveBeenCalledWith({ authUserId: user, missionId: mission }, account);
  });
  it('discloses retained external ownership before deletion and requires both confirmations', async () => {
    boundary.snapshot.mockResolvedValue({
      founder_accounts: [{ id: 'account', provider: 'shopify' }],
      provider_receipts: [
        { id: 'published', operation: 'store_publish', provider: 'shopify', provider_reference: 'external-product' },
        { id: 'private-payment', operation: 'payment_capture' },
      ],
    });
    const notice = await deletionNotice(request({}), params);
    expect(await notice.json()).toMatchObject({
      retainedAccounts: [{ id: 'account', label: 'shopify' }],
      retainedExternalAssets: [{ id: 'published' }],
    });
    expect((await deleteMission(request({ confirm: true }), params)).status).toBe(409);
    expect(boundary.withRole).not.toHaveBeenCalled();
    expect((await deleteMission(request({ confirm: true, understandExternalAssetsRemain: true }), params)).status).toBe(200);
    expect(boundary.query).toHaveBeenCalledWith('select public.erase_mission($1,$2) as id', [mission, receipt]);
  });
  it('does not claim an invalid deletion confirmation paused a mission', async () => {
    const response = await deleteMission(request({ confirm: false, understandExternalAssetsRemain: false }), params);
    expect(boundary.withRole).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('remains paused');
  });
  it('removes every paginated private file before erasing hosted mission records', async () => {
    boundary.actor.mockResolvedValue({ authUserId: user, local: false });
    boundary.env = { ...boundary.env, SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-key' };
    boundary.storageList.mockImplementation(async (prefix: string, { offset }: { offset: number }) => ({
      data:
        prefix === mission
          ? offset === 0
            ? Array.from({ length: 100 }, (_, i) => ({ id: `file-${i}`, name: `file-${i}.svg` }))
            : [{ id: null, name: 'nested' }]
          : [{ id: 'nested-source', name: 'source.svg' }],
      error: null,
    }));
    const response = await deleteMission(request({ confirm: true, understandExternalAssetsRemain: true }), params);
    expect(response.status).toBe(200);
    expect(boundary.storageList).toHaveBeenCalledWith(mission, { limit: 100, offset: 100 });
    expect(boundary.storageList).toHaveBeenCalledWith(`${mission}/nested`, { limit: 100, offset: 0 });
    expect(boundary.storageRemove.mock.calls.map(([paths]) => paths.length)).toEqual([100, 1]);
    expect(boundary.storageRemove.mock.calls.at(-1)?.[0]).toEqual([`${mission}/nested/source.svg`]);
    expect(boundary.query.mock.invocationCallOrder.at(-1)).toBeGreaterThan(boundary.storageRemove.mock.invocationCallOrder.at(-1) ?? 0);
  });
  it('preserves business records when hosted file enumeration or deletion fails', async () => {
    boundary.actor.mockResolvedValue({ authUserId: user, local: false });
    boundary.env = { ...boundary.env, SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-key' };
    boundary.storageList.mockResolvedValueOnce({ data: null, error: new Error('synthetic storage outage') });
    expect((await deleteMission(request({ confirm: true, understandExternalAssetsRemain: true }), params)).status).toBe(409);
    expect(boundary.query.mock.calls.some(([sql]) => String(sql).includes('erase_mission'))).toBe(false);
    boundary.storageList.mockResolvedValue({ data: [{ id: 'file', name: 'source.svg' }], error: null });
    boundary.storageRemove.mockResolvedValue({ error: new Error('synthetic remove failure') });
    expect((await deleteMission(request({ confirm: true, understandExternalAssetsRemain: true }), params)).status).toBe(409);
    expect(boundary.query.mock.calls.some(([sql]) => String(sql).includes('erase_mission'))).toBe(false);
  });
  it('refuses unscoped streams and emits a private whole-draft frame that closes on abort', async () => {
    boundary.actor.mockResolvedValueOnce(null);
    expect((await stream(request({}), params)).status).toBe(401);
    expect((await stream(request({}), { params: Promise.resolve({ missionId: 'bad' }) })).status).toBe(400);
    boundary.drafts.mockRejectedValueOnce(new Error('mission denied'));
    expect((await stream(request({}), params)).status).toBe(404);
    const abort = new AbortController(),
      response = await stream(new Request(origin, { signal: abort.signal }), params);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('private, no-store, no-transform');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Expected an actual stream body');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(`data: ${JSON.stringify({ missionId: mission, drafts: [] })}\n\n`);
    abort.abort();
    expect((await reader.read()).done).toBe(true);
  });
  it('reports a later stream read failure without emitting a fabricated completed message', async () => {
    vi.useFakeTimers();
    boundary.drafts.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('synthetic database unavailable'));
    const response = await stream(new Request(origin), params),
      reader = response.body?.getReader();
    if (!reader) throw new Error('Expected stream body');
    await reader.read();
    await vi.advanceTimersByTimeAsync(300);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: unavailable\ndata: {}\n\n');
    expect((await reader.read()).done).toBe(true);
  });
  it('stops stream polling when the reader cancels', async () => {
    vi.useFakeTimers();
    const response = await stream(new Request(origin), params),
      reader = response.body?.getReader();
    if (!reader) throw new Error('Expected stream body');
    await reader.read();
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(boundary.drafts).toHaveBeenCalledTimes(1);
  });
  it('validates hosted account installation scope before passing the shop input to its capability service', async () => {
    expect((await oauthStart(request({}, 'https://attacker.test'), params)).status).toBe(403);
    boundary.actor.mockResolvedValueOnce(null);
    expect((await oauthStart(request({}), params)).status).toBe(401);
    expect((await oauthStart(request({ shopDomain: 'x'.repeat(2100) }), params)).status).toBe(422);
    expect(boundary.oauthStart).not.toHaveBeenCalled();
    boundary.oauthStart.mockResolvedValue({
      ok: true,
      value: { authorizationUrl: 'https://synthetic.myshopify.com/admin/oauth/authorize' },
    });
    const response = await oauthStart(request({ shopDomain: 'synthetic.myshopify.com' }), params);
    expect(response.status).toBe(200);
    expect(boundary.oauthStart).toHaveBeenCalledWith({ authUserId: user, missionId: mission }, { shopDomain: 'synthetic.myshopify.com' });
  });
  it('returns a connected Shopify account to the actual workspace route', async () => {
    boundary.oauthComplete.mockResolvedValue({ ok: true, value: { accountId: randomUUID() } });
    const response = await oauthCallback(new Request(`${origin}/callback?code=synthetic&state=synthetic`), params);
    expect(response.status).toBe(303);
    const destination = new URL(String(response.headers.get('location')));
    expect(destination.origin).toBe(origin);
    expect(destination.pathname).toBe('/');
    expect(destination.searchParams.get('mission')).toBe(mission);
    expect(destination.searchParams.get('accountConnected')).toBe('shopify');
  });
  it('does not redirect failed account verification or expose the callback query through a referrer', async () => {
    boundary.actor.mockResolvedValueOnce(null);
    expect((await oauthCallback(request({}), params)).status).toBe(401);
    boundary.oauthComplete.mockResolvedValue({ ok: false, error: { code: 'rejected' } });
    const denied = await oauthCallback(request({}), params);
    expect(denied.status).toBe(422);
    expect(denied.headers.get('referrer-policy')).toBe('no-referrer');
    expect(denied.headers.get('location')).toBeNull();
  });
  it('keeps payment returns pending unless the trusted capture verifier succeeds', async () => {
    boundary.actor.mockResolvedValueOnce(null);
    expect(new URL(String((await paymentReturn(new Request(origin))).headers.get('location'))).pathname).toBe('/login');
    expect((await paymentReturn(new Request(`${origin}?mission=bad&token=bad`))).status).toBe(400);
    expect(boundary.capture).not.toHaveBeenCalled();
    for (const ok of [false, true]) {
      boundary.capture.mockResolvedValueOnce({ ok });
      const response = await paymentReturn(new Request(`${origin}?mission=${mission}&token=SYNTHETIC-ORDER`));
      expect(response.status).toBe(303);
      expect(new URL(String(response.headers.get('location'))).searchParams.get('payment')).toBe(ok ? 'verified' : 'pending');
      expect(boundary.capture).toHaveBeenCalledWith({ authUserId: user, missionId: mission }, 'SYNTHETIC-ORDER');
    }
  });
  it('records validation interest only after same-origin bounded consent data is accepted by the service', async () => {
    const context = { params: Promise.resolve({ slug: 'synthetic-validation' }) };
    boundary.validationPage.mockResolvedValueOnce(null);
    expect((await validationPage(request({}), context)).status).toBe(404);
    boundary.validationPage.mockResolvedValueOnce({ title: 'Synthetic validation' });
    expect((await validationPage(request({}), context)).status).toBe(200);
    expect((await signup(request({}, 'https://attacker.test'), context)).status).toBe(403);
    expect((await signup(request({ padding: 'x'.repeat(5000) }), context)).status).toBe(413);
    expect(boundary.signup).not.toHaveBeenCalled();
    boundary.signup.mockRejectedValueOnce(new Error('consent required'));
    expect((await signup(request({ email: 'synthetic@example.test', consent: false }), context)).status).toBe(400);
    boundary.signup.mockResolvedValueOnce(undefined);
    expect((await signup(request({ email: 'synthetic@example.test', consent: true }), context)).status).toBe(200);
    expect(boundary.signup).toHaveBeenLastCalledWith({ slug: 'synthetic-validation', email: 'synthetic@example.test', consent: true });
  });
});
