import { createHmac, createHash } from 'node:crypto';
import { z } from 'zod';
import { constantTimeEquals, failure, type Failure } from '@lo/policy';
import { hashPayload, type Provider } from './core.js';
import type { PayPalAdapter } from './paypal.js';

export interface WebhookRequest {
  rawBody: string;
  headers: Record<string, string>;
  /** Configured public URL, never Host/X-Forwarded-Host from the request. */ publicUrl: string;
}
export interface VerifiedWebhook {
  provider: Provider;
  providerEventId: string;
  payload: unknown;
  payloadHash: string;
  receivedAt: string;
  signatureVerified: true;
}
/** Implemented as one transaction with unique(provider,providerEventId), raw event and outbox insert. */
export interface WebhookStore {
  insertVerified(event: VerifiedWebhook): Promise<{ eventId: string; duplicate: boolean; parked: boolean }>;
}
export type IngressResult = { ok: true; status: 200; eventId: string; duplicate: boolean; parked: boolean } | Failure;
const signedJsonSchema = z.record(z.string(), z.unknown());
function signatureError(): Failure {
  return failure('rejected', 'Webhook signature invalid.');
}
function validUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}
export function verifyTwilio(request: WebhookRequest, authToken: string): boolean {
  if (!authToken || !validUrl(request.publicUrl)) return false;
  const signature = request.headers['x-twilio-signature'];
  if (!signature) return false;
  const url = new URL(request.publicUrl);
  let signed = request.publicUrl;
  if ((request.headers['content-type'] ?? '').startsWith('application/json')) {
    const expected = url.searchParams.get('bodySHA256');
    if (!expected || !constantTimeEquals(expected, createHash('sha256').update(request.rawBody).digest('hex'))) return false;
  } else {
    const params = new URLSearchParams(request.rawBody);
    for (const key of [...new Set(params.keys())].sort())
      for (const value of [...new Set(params.getAll(key))].sort()) signed += key + value;
  }
  return constantTimeEquals(createHmac('sha1', authToken).update(signed).digest('base64'), signature);
}
export function verifyShopify(request: WebhookRequest, secret: string): boolean {
  const signature = request.headers['x-shopify-hmac-sha256'];
  return !!secret && !!signature && constantTimeEquals(createHmac('sha256', secret).update(request.rawBody).digest('base64'), signature);
}
/** Standard Webhooks/Svix v1 signing, with a five-minute clock skew limit. */
export function verifyResend(request: WebhookRequest, secret: string, now = new Date()): boolean {
  const id = request.headers['svix-id'];
  const timestamp = request.headers['svix-timestamp'];
  const signatures = request.headers['svix-signature'];
  if (
    !id ||
    !timestamp ||
    !signatures ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(now.getTime() / 1000 - Number(timestamp)) > 300 ||
    !secret.startsWith('whsec_')
  )
    return false;
  const key = Buffer.from(secret.slice(6), 'base64');
  if (key.length < 16) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${request.rawBody}`).digest('base64');
  return signatures.split(' ').some(s => s.startsWith('v1,') && constantTimeEquals(expected, s.slice(3)));
}
export async function ingestWebhook(
  provider: 'twilio' | 'resend' | 'shopify',
  request: WebhookRequest,
  secret: string,
  store: WebhookStore,
  now = new Date(),
): Promise<IngressResult> {
  const verified =
    provider === 'twilio'
      ? verifyTwilio(request, secret)
      : provider === 'resend'
        ? verifyResend(request, secret, now)
        : verifyShopify(request, secret);
  if (!verified) return signatureError();
  let payload: unknown;
  try {
    payload =
      provider === 'twilio' && !(request.headers['content-type'] ?? '').startsWith('application/json')
        ? Object.fromEntries(new URLSearchParams(request.rawBody))
        : (JSON.parse(request.rawBody) as unknown);
    const p = signedJsonSchema.safeParse(payload);
    if (!p.success) return failure('validation', 'Webhook body is not an object.');
    payload = p.data;
    // Shopify's delivery-id header is not signed; content-based identity also defeats header tampering/replay.
    const providerEventId =
      provider === 'resend'
        ? request.headers['svix-id']
        : provider === 'shopify'
          ? hashPayload(request.rawBody)
          : hashPayload([request.publicUrl, request.rawBody]);
    if (!providerEventId) return signatureError();
    const stored = await store.insertVerified({
      provider,
      providerEventId,
      payload,
      payloadHash: hashPayload(payload),
      receivedAt: now.toISOString(),
      signatureVerified: true,
    });
    return { ok: true, status: 200, ...stored };
  } catch {
    return failure('provider_down', 'Webhook was not durably stored; provider must retry.', 'same_key');
  }
}
/** Verifies online before durable ingestion; callers cannot supply a forged "verified" boolean. */
export async function ingestPayPalWebhook(
  adapter: PayPalAdapter,
  scope: { missionId: string; sandboxMode: boolean },
  credentialRef: string,
  request: WebhookRequest,
  store: WebhookStore,
  now = new Date(),
): Promise<IngressResult> {
  const result = await adapter.verifyWebhook(scope, credentialRef, request.headers, request.rawBody);
  if (!result.ok) return result;
  try {
    const stored = await store.insertVerified({
      provider: 'paypal',
      providerEventId: result.data.id,
      payload: result.data,
      payloadHash: hashPayload(result.data),
      receivedAt: now.toISOString(),
      signatureVerified: true,
    });
    return { ok: true, status: 200, ...stored };
  } catch {
    return failure('provider_down', 'Webhook was not durably stored; provider must retry.', 'same_key');
  }
}
export const paymentConfirmationSchema = z
  .object({
    orderId: z.string().min(1),
    captureId: z.string().min(1),
    payeeMerchantId: z.string().min(1),
    amountMinor: z.number().int().nonnegative().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    sandboxMode: z.boolean(),
  })
  .strict();
/** Signed does not mean correctly addressed: correlation is mandatory before any spent entry. */
export function correlatePayPalCapture(
  raw: unknown,
  expected: z.infer<typeof paymentConfirmationSchema>,
): { ok: true; confirmation: z.infer<typeof paymentConfirmationSchema> } | Failure {
  const parsed = z
    .object({
      event_type: z.literal('PAYMENT.CAPTURE.COMPLETED'),
      resource: z.object({
        id: z.string(),
        status: z.literal('COMPLETED'),
        amount: z.object({ value: z.string().regex(/^\d+\.\d{2}$/), currency_code: z.string() }),
        payee: z.object({ merchant_id: z.string() }),
        supplementary_data: z.object({ related_ids: z.object({ order_id: z.string() }) }),
        links: z.array(z.object({ href: z.string().url() })),
      }),
    })
    .safeParse(raw);
  if (!parsed.success) return failure('validation', 'Capture webhook is incomplete.');
  const r = parsed.data.resource;
  const value = `${Math.floor(expected.amountMinor / 100)}.${String(expected.amountMinor % 100).padStart(2, '0')}`;
  const hosts = expected.sandboxMode ? ['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'] : ['api.paypal.com', 'api-m.paypal.com'];
  if (
    r.id !== expected.captureId ||
    r.supplementary_data.related_ids.order_id !== expected.orderId ||
    r.payee.merchant_id !== expected.payeeMerchantId ||
    r.amount.value !== value ||
    r.amount.currency_code !== expected.currency ||
    r.links.length === 0 ||
    r.links.some(l => {
      const u = new URL(l.href);
      return u.protocol !== 'https:' || !hosts.includes(u.hostname);
    })
  )
    return failure('invariant_violation', 'Capture event does not match order, capture, amount, payee, currency or environment.');
  return { ok: true, confirmation: expected };
}
