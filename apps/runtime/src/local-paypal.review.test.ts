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
        reference = submitted.purchase_units[0]!.reference_id;
        expect(submitted.purchase_units[0]!.amount).toEqual({ value: '1.00', currency_code: 'USD' });
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
describe('independent local sandbox payment boundary', () => {
  it('does not trust an order-completed response when the independent capture reports a different amount', async () => {
    const created = await createLocalPayPalOrder(actor, randomUUID());
    status = 'APPROVED';
    const original = vi.mocked(fetch).getMockImplementation();
    if (!original) throw new Error('Expected explicit mocked protocol');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).endsWith(`/v2/payments/captures/${captureId}`))
          return Response.json({
            id: captureId,
            status: 'COMPLETED',
            amount: { value: '2.00', currency_code: 'USD' },
            supplementary_data: { related_ids: { order_id: providerOrder } },
          });
        return original(input, init);
      }),
    );
    await expect(captureLocalPayPalOrder(actor, created.orderId)).rejects.toBeDefined();
    expect(capturePosts).toBe(1);
  });
  it('rejects a lookalike approval host and never repeats the already started creation POST', async () => {
    const original = vi.mocked(fetch).getMockImplementation();
    if (!original) throw new Error('Expected explicit mocked protocol');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await original(input, init);
        if (String(input).endsWith('/v2/checkout/orders') && init?.method === 'POST')
          return Response.json({
            id: providerOrder,
            links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com.evil.test/checkoutnow?token=${providerOrder}` }],
          });
        return response;
      }),
    );
    const key = randomUUID();
    await expect(createLocalPayPalOrder(actor, key)).rejects.toMatchObject({ code: 'validation' });
    await expect(createLocalPayPalOrder(actor, key)).rejects.toBeDefined();
    expect(createPosts).toBe(1);
  });
  it('prevents another local actor from accessing a sandbox order and exposes configuration only as a boolean', async () => {
    expect(localPayPalStatus()).toEqual({ configured: true });
    await createLocalPayPalOrder(actor, randomUUID());
    status = 'APPROVED';
    await expect(captureLocalPayPalOrder(other, providerOrder)).rejects.toMatchObject({ code: 'forbidden' });
    expect(capturePosts).toBe(0);
  });
});
