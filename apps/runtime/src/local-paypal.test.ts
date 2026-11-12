import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureLocalPayPalOrder, createLocalPayPalOrder, localPayPalStatus } from './local-paypal.js';
const actor = '00000000-0000-4000-8000-000000000001',
  other = '00000000-0000-4000-8000-000000000002';
const providerOrder = 'ORDER123456789',
  captureId = 'CAPTURE12345678',
  merchant = 'MERCHANT1234567';
let directory: string, oldEnv: NodeJS.ProcessEnv, reference: string, status: string, createPosts: number, capturePosts: number;
let wrongAmount: boolean, wrongPayee: boolean, wrongReceipt: boolean, loseCaptureResponse: boolean, loseCreateResponse: boolean;
function body() {
  return {
    id: providerOrder,
    intent: 'CAPTURE',
    status,
    purchase_units: [
      {
        reference_id: reference,
        custom_id: reference,
        amount: { currency_code: 'USD', value: wrongAmount ? '2.00' : '1.00' },
        payee: { merchant_id: wrongPayee ? 'OTHER123456789' : merchant },
        ...(status === 'COMPLETED'
          ? { payments: { captures: [{ id: captureId, status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }] } }
          : {}),
      },
    ],
  };
}
beforeEach(async () => {
  oldEnv = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), 'lo-paypal-local-'));
  process.env = {
    ...oldEnv,
    NODE_ENV: 'test',
    LO_EXECUTION_MODE: 'local',
    LO_STORAGE_BACKEND: 'sqlite',
    LO_SQLITE_PATH: join(directory, 'operator.sqlite'),
    APP_ORIGIN: 'http://127.0.0.1:3100',
    PAYPAL_CLIENT_ID: 'sandbox-client',
    PAYPAL_CLIENT_SECRET: 'sandbox-secret',
    PAYPAL_MERCHANT_ID: merchant,
  };
  reference = '';
  status = 'CREATED';
  createPosts = 0;
  capturePosts = 0;
  wrongAmount = false;
  wrongPayee = false;
  wrongReceipt = false;
  loseCaptureResponse = false;
  loseCreateResponse = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      expect(new URL(url).origin).toBe('https://api-m.sandbox.paypal.com');
      expect(init.redirect).toBe('error');
      if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'test-access-token' });
      if (url.endsWith('/v2/checkout/orders') && init.method === 'POST') {
        createPosts++;
        const submitted = JSON.parse(String(init.body)) as {
          purchase_units: { reference_id: string; amount: { value: string; currency_code: string } }[];
        };
        const unit = submitted.purchase_units[0];
        if (!unit) throw new Error('Expected one submitted purchase unit');
        reference = unit.reference_id;
        expect(unit.amount).toEqual({ value: '1.00', currency_code: 'USD' });
        expect((init.headers as Record<string, string>)['PayPal-Request-Id']).toHaveLength(36);
        if (loseCreateResponse) throw new Error('network outcome unknown');
        return Response.json({
          id: providerOrder,
          links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${providerOrder}` }],
        });
      }
      if (url.endsWith(`/v2/checkout/orders/${providerOrder}/capture`)) {
        capturePosts++;
        status = 'COMPLETED';
        if (loseCaptureResponse) throw new Error('network outcome unknown');
        return Response.json(body());
      }
      if (url.endsWith(`/v2/checkout/orders/${providerOrder}`)) return Response.json(body());
      if (url.endsWith(`/v2/payments/captures/${captureId}`))
        return Response.json({
          id: captureId,
          status: 'COMPLETED',
          amount: { value: '1.00', currency_code: 'USD' },
          supplementary_data: { related_ids: { order_id: wrongReceipt ? 'WRONG123456789' : providerOrder } },
        });
      throw new Error('Unexpected endpoint');
    }),
  );
});
afterEach(async () => {
  process.env = oldEnv;
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
describe('explicit real local PayPal sandbox protocol (mocked transport)', () => {
  it('creates fixed USD1, persists idempotent actor binding and confirms exact capture with independent polls', async () => {
    const key = randomUUID();
    const first = await createLocalPayPalOrder(actor, key);
    expect(await createLocalPayPalOrder(actor, key)).toEqual(first);
    expect(createPosts).toBe(1);
    status = 'APPROVED';
    const result = await captureLocalPayPalOrder(actor, first.orderId);
    expect(result).toEqual({ orderId: providerOrder, captureId, status: 'COMPLETED', amount: '1.00', currency: 'USD' });
    expect(await captureLocalPayPalOrder(actor, first.orderId)).toEqual(result);
    expect(capturePosts).toBe(1);
  });
  it('blocks production, PostgreSQL and missing credentials without network calls', async () => {
    for (const patch of [{ NODE_ENV: 'production' }, { LO_STORAGE_BACKEND: 'postgres' }, { PAYPAL_CLIENT_SECRET: '' }]) {
      const saved = { ...process.env };
      Object.assign(process.env, patch);
      expect(localPayPalStatus().configured).toBe(false);
      await expect(createLocalPayPalOrder(actor, randomUUID())).rejects.toMatchObject({ code: 'unavailable' });
      process.env = saved;
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects an arbitrary return origin before provider access', async () => {
    process.env['APP_ORIGIN'] = 'https://example.com';
    await expect(createLocalPayPalOrder(actor, randomUUID())).rejects.toMatchObject({ code: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires signed-in owner, original account and approved payer status before capture', async () => {
    await createLocalPayPalOrder(actor, randomUUID());
    await expect(captureLocalPayPalOrder(other, providerOrder)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(captureLocalPayPalOrder(actor, providerOrder)).rejects.toMatchObject({ code: 'pending' });
    process.env['PAYPAL_CLIENT_ID'] = 'different-client';
    await expect(captureLocalPayPalOrder(actor, providerOrder)).rejects.toMatchObject({ code: 'forbidden' });
    expect(capturePosts).toBe(0);
  });
  it.each(['amount', 'payee'] as const)('rejects mismatched %s before capture POST', async mismatch => {
    await createLocalPayPalOrder(actor, randomUUID());
    status = 'APPROVED';
    wrongAmount = mismatch === 'amount';
    wrongPayee = mismatch === 'payee';
    await expect(captureLocalPayPalOrder(actor, providerOrder)).rejects.toBeDefined();
    expect(capturePosts).toBe(0);
  });
  it('reconciles an accepted capture after lost response without a second capture POST', async () => {
    await createLocalPayPalOrder(actor, randomUUID());
    status = 'APPROVED';
    loseCaptureResponse = true;
    await expect(captureLocalPayPalOrder(actor, providerOrder)).rejects.toMatchObject({ code: 'pending' });
    expect((await captureLocalPayPalOrder(actor, providerOrder)).status).toBe('COMPLETED');
    expect(capturePosts).toBe(1);
  });
  it('keeps ambiguous create durable and does not repeat the write', async () => {
    const key = randomUUID();
    loseCreateResponse = true;
    await expect(createLocalPayPalOrder(actor, key)).rejects.toMatchObject({ code: 'pending' });
    await expect(createLocalPayPalOrder(actor, key)).rejects.toMatchObject({ code: 'pending' });
    expect(createPosts).toBe(1);
  });
  it('never reports a completed capture when the independent capture receipt names another order', async () => {
    await createLocalPayPalOrder(actor, randomUUID());
    status = 'APPROVED';
    wrongReceipt = true;
    await expect(captureLocalPayPalOrder(actor, providerOrder)).rejects.toMatchObject({ code: 'validation' });
    wrongReceipt = false;
    expect((await captureLocalPayPalOrder(actor, providerOrder)).captureId).toBe(captureId);
    expect(capturePosts).toBe(1);
  });
  it('claims capture atomically across concurrent requests', async () => {
    await createLocalPayPalOrder(actor, randomUUID());
    status = 'APPROVED';
    const results = await Promise.allSettled([
      captureLocalPayPalOrder(actor, providerOrder),
      captureLocalPayPalOrder(actor, providerOrder),
    ]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect(capturePosts).toBe(1);
  });
  it('releases only an OAuth-failed pre-effect claim so credentials can be fixed and the same request retried', async () => {
    const key = randomUUID();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: 'invalid_client' }, { status: 401 }));
    await expect(createLocalPayPalOrder(actor, key)).rejects.toMatchObject({ code: 'provider' });
    expect(createPosts).toBe(0);
    expect((await createLocalPayPalOrder(actor, key)).orderId).toBe(providerOrder);
    expect(createPosts).toBe(1);
  });
  it('recovers a known created order by GET after an initial verification failure without another create POST', async () => {
    const key = randomUUID();
    wrongAmount = true;
    await expect(createLocalPayPalOrder(actor, key)).rejects.toBeDefined();
    expect(createPosts).toBe(1);
    wrongAmount = false;
    expect((await createLocalPayPalOrder(actor, key)).orderId).toBe(providerOrder);
    expect(createPosts).toBe(1);
  });
  it('does not bypass original merchant verification through capture on a partially created order', async () => {
    wrongPayee = true;
    await expect(createLocalPayPalOrder(actor, randomUUID())).rejects.toMatchObject({ code: 'validation' });
    status = 'APPROVED';
    await expect(captureLocalPayPalOrder(actor, providerOrder)).rejects.toMatchObject({ code: 'validation' });
    expect(capturePosts).toBe(0);
  });
});
