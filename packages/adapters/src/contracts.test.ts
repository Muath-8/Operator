import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bindingHash, tokenHash, type EffectIntent, type PolicySnapshot, type EffectRepository } from '@lo/policy';
import { MemoryEffectRepository } from '../../policy/src/testing.js';
import { ChannelsAdapter, evaluateChannel, type ChannelState, type OutboundMessage } from './channels.js';
import { Boundary, redact, type AdapterDependencies, type HttpRequest, type Transport } from './core.js';
import { PayPalAdapter, validatePayPalLink, type PaymentCorrelation } from './paypal.js';
import {
  correlatePayPalCapture,
  ingestWebhook,
  verifyResend,
  verifyShopify,
  verifyTwilio,
  type WebhookRequest,
  type WebhookStore,
} from './webhooks.js';
import { OpenAIGenerationAdapter, type ServiceBudgetStore } from './generation.js';
import { BrowserbaseResearchAdapter } from './research.js';
import { ShopifyAdapter, shopifyAuthorizationUrl, completeShopifyOAuth } from './shopify.js';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const token = 'founder-approval-'.repeat(4);
function intent(patch: Partial<EffectIntent> = {}): EffectIntent {
  return {
    missionId: id,
    taskId: 'task',
    action: 'send_message',
    effectClass: 'communicate',
    counterpartyId: id,
    artifactVersionId: id,
    idempotencyKey: 'provider-effect-key-0001',
    mode: 'do',
    sandboxMode: true,
    mandateId: id,
    newContact: false,
    channel: 'email',
    purpose: 'notification',
    ...patch,
  };
}
function snapshot(i: EffectIntent): PolicySnapshot {
  return {
    paused: false,
    killed: false,
    sandboxMode: true,
    missionCurrency: 'SAR',
    budgetRemainingMinor: 100000,
    mandates: [
      {
        id,
        missionId: id,
        effectClass: i.effectClass,
        actions: [i.action],
        counterparties: [id],
        expiresAt: '2099-01-01T00:00:00.000Z',
        reservedMinor: 0,
        spentMinor: 0,
        channels: ['email', 'whatsapp', 'sms', 'voice'],
        purposes: ['notification', 'follow_up', 'introduction'],
        instrumentIds: [id],
        currency: 'SAR',
        perTransactionMinor: 100000,
        totalMinor: 100000,
        usedActions: 0,
      },
    ],
    ...(i.approvalToken
      ? {
          approval: {
            tokenHash: tokenHash(i.approvalToken),
            bindingHash: bindingHash(i),
            expiresAt: '2099-01-01T00:00:00.000Z',
            consumed: false,
            revoked: false,
          },
        }
      : {}),
  };
}
function deps(i: EffectIntent, transport: Transport, credential: unknown, repository?: EffectRepository): AdapterDependencies {
  return {
    repository: repository ?? new MemoryEffectRepository(snapshot(i), 'test'),
    context: { role: 'policy' },
    preparations: { execute: async (_request, invoke) => invoke() },
    secrets: { resolve: async () => credential },
    transport,
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  };
}
const baseCredential = { missionId: id, sandboxMode: true, revoked: false };
const paypalCredential = {
  ...baseCredential,
  clientId: 'client',
  clientSecret: 'fixture-secret-paypal',
  merchantId: 'OWNMERCHANT',
  webhookId: 'WH-ID',
  verifiedPayees: { [id]: 'PAYEEMERCHANT' },
};
const expected: PaymentCorrelation = {
  orderId: 'ORDER1',
  captureId: 'CAPTURE1',
  payeeMerchantId: 'PAYEEMERCHANT',
  amountMinor: 22500,
  currency: 'SAR',
  sandboxMode: true,
};
function order(status = 'APPROVED', payee = 'PAYEEMERCHANT') {
  return {
    id: 'ORDER1',
    status,
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: id,
        amount: { value: '225.00', currency_code: 'SAR' },
        payee: { merchant_id: payee },
        payments: { captures: [{ id: 'CAPTURE1', status: 'COMPLETED', amount: { value: '225.00', currency_code: 'SAR' } }] },
      },
    ],
  };
}
const contact: ChannelState = {
  counterpartyId: id,
  optedOut: false,
  email: 'supplier@example.test',
  phone: '+15555550123',
  phoneVerified: true,
  lastWhatsappInboundAt: '2026-11-12T09:00:00.000Z',
  localHoursOpen: true,
  senderRegistered: true,
  disclosure: 'AI-assisted agent for the founder.',
  founderBudgetFigures: ['25000'],
  approvedTemplates: [{ id: 'HXapproved', language: 'en', purpose: 'introduction', body: 'AI-assisted agent for the founder.' }],
};
const message: OutboundMessage = {
  channel: 'email',
  text: 'We emailed your brief.',
  translation: 'أرسلنا الموجز.',
  language: 'en',
  purpose: 'notification',
  subject: 'Brief',
  hasDocument: false,
};
const resendCredential = {
  ...baseCredential,
  apiKey: 'fixture-secret-resend',
  from: 'agent@test.example',
  testDomain: 'test.example',
  allowedSandboxRecipients: [contact.email],
};
const twilioCredential = {
  ...baseCredential,
  accountSid: `AC${'1'.repeat(32)}`,
  authToken: 'fixture-secret-twilio',
  from: '+15555550000',
  allowedSandboxRecipients: [contact.phone],
  voiceCallbackOrigin: 'https://operator.example',
};

describe('adapter contracts / I-1 I-3 I-4 I-11 I-16', () => {
  it('AT-FR-PAY-03-1 never captures before provider payer approval', async () => {
    const i = intent({
      action: 'payment_capture',
      effectClass: 'spend',
      amountMinor: 22500,
      currency: 'SAR',
      instrumentId: id,
      approvalToken: token,
    });
    const requests: HttpRequest[] = [];
    const adapter = new PayPalAdapter(
      deps(
        i,
        async r => {
          requests.push(r);
          return { status: 200, headers: {}, body: r.url.endsWith('/token') ? { access_token: 'access' } : order('CREATED') };
        },
        paypalCredential,
      ),
    );
    expect(await adapter.execute(i, 'secret-ref', expected)).toMatchObject({ ok: false, code: 'needs_approval' });
    expect(requests.some(r => r.url.endsWith('/capture'))).toBe(false);
  });
  it('AT-FR-PAY-04-1 capture response produces pending verification, verified poll matches all fields', async () => {
    const i = intent({
      action: 'payment_capture',
      effectClass: 'spend',
      amountMinor: 22500,
      currency: 'SAR',
      instrumentId: id,
      approvalToken: token,
    });
    const requests: HttpRequest[] = [];
    const adapter = new PayPalAdapter(
      deps(
        i,
        async r => {
          requests.push(r);
          return {
            status: 200,
            headers: {},
            body: r.url.endsWith('/token') ? { access_token: 'access' } : order(r.method === 'POST' ? 'COMPLETED' : 'APPROVED'),
          };
        },
        paypalCredential,
      ),
    );
    expect(await adapter.execute(i, 'secret-ref', expected)).toMatchObject({ ok: true, data: { status: 'pending_verification' } });
    expect(requests.every(r => r.url.startsWith('https://api-m.sandbox.paypal.com/'))).toBe(true);
    const poll = new PayPalAdapter(
      deps(
        i,
        async r => ({ status: 200, headers: {}, body: r.url.endsWith('/token') ? { access_token: 'access' } : order('COMPLETED') }),
        paypalCredential,
      ),
    );
    expect(await poll.verify(i, 'secret-ref', expected)).toMatchObject({
      ok: true,
      data: { captureId: 'CAPTURE1', confirmationSource: 'verified_poll', sandboxMode: true },
    });
    expect(await poll.verify(i, 'secret-ref', { ...expected, payeeMerchantId: 'ATTACKER' })).toMatchObject({ ok: false });
    expect(await poll.verify(i, 'secret-ref', { ...expected, amountMinor: 1 })).toMatchObject({ ok: false });
  });
  it('AT-FR-PAY-06-1 timeout after provider capture never posts a second capture', async () => {
    const i = intent({
      action: 'payment_capture',
      effectClass: 'spend',
      amountMinor: 22500,
      currency: 'SAR',
      instrumentId: id,
      approvalToken: token,
    });
    let captures = 0;
    const adapter = new PayPalAdapter(
      deps(
        i,
        async r => {
          if (r.url.endsWith('/capture')) {
            captures++;
            throw new Error('response lost');
          }
          return { status: 200, headers: {}, body: r.url.endsWith('/token') ? { access_token: 'access' } : order() };
        },
        paypalCredential,
      ),
    );
    expect(await adapter.execute(i, 'secret-ref', expected)).toMatchObject({ ok: false, retry: 'reconcile' });
    expect(await adapter.execute(i, 'secret-ref', expected)).toMatchObject({ ok: false, retry: 'reconcile' });
    expect(captures).toBe(1);
  });
  it('AT-FR-PAY-08-1 exact provider domains reject lookalikes, userinfo and mixed environments', () => {
    expect(validatePayPalLink('https://www.sandbox.paypal.com/checkoutnow?token=ORDER1', true).ok).toBe(true);
    for (const link of [
      'https://paypal.com.attacker.test/invoice/x',
      'https://paypal.com@evil.test/invoice/x',
      'http://www.paypal.com/invoice/x',
      'https://www.paypal.com/invoice/x',
      'https://www.sandbox.paypal.com:444/checkoutnow',
    ])
      expect(validatePayPalLink(link, true).ok).toBe(false);
  });
  it('AT-FR-COM-02-1 email requires recorded recipient and returns original, translation and authorizer', async () => {
    const i = intent();
    let sent = 0;
    const adapter = new ChannelsAdapter(
      deps(
        i,
        async r => {
          sent++;
          expect(r.headers['Idempotency-Key']).toBe(i.idempotencyKey);
          return { status: 200, headers: {}, body: { id: 'email-id' } };
        },
        resendCredential,
      ),
      { get: async () => contact },
    );
    expect(await adapter.send(i, 'secret-ref', message)).toMatchObject({
      ok: true,
      data: { original: message.text, translation: message.translation, authorizer: id },
      receipt: { providerId: 'email-id', sandboxMode: true },
    });
    expect(sent).toBe(1);
    expect(await adapter.send(i, 'secret-ref', message)).toMatchObject({ ok: true, replay: true });
    expect(sent).toBe(1);
  });
  it('AT-FR-CHN-03-1 WhatsApp expired window blocks before provider call', async () => {
    const i = intent({ channel: 'whatsapp', purpose: 'follow_up' });
    let sent = 0;
    const adapter = new ChannelsAdapter(
      deps(
        i,
        async () => {
          sent++;
          return { status: 200, headers: {}, body: { sid: 'SMid', status: 'queued' } };
        },
        twilioCredential,
      ),
      { get: async () => ({ ...contact, lastWhatsappInboundAt: '2026-11-11T08:00:00.000Z' }) },
    );
    expect(await adapter.send(i, 'secret-ref', { ...message, channel: 'whatsapp', purpose: 'follow_up' })).toMatchObject({
      ok: false,
      code: 'window_closed',
    });
    expect(sent).toBe(0);
  });
  it('AT-FR-CHN-04-1 template first contact must match approved purpose/language and disclosure', () => {
    const m: OutboundMessage = {
      ...message,
      channel: 'whatsapp',
      purpose: 'introduction',
      text: contact.disclosure,
      templateId: 'HXapproved',
    };
    expect(evaluateChannel(m, { ...contact, lastWhatsappInboundAt: null }).ok).toBe(true);
    expect(evaluateChannel({ ...m, language: 'ar' }, contact).ok).toBe(false);
    expect(evaluateChannel({ ...m, templateId: 'HXunapproved' }, contact).ok).toBe(false);
    expect(evaluateChannel({ ...m, text: 'I am human.' }, contact).ok).toBe(false);
  });
  it('AT-FR-CHN-09-1 SMS restrictions, opt-out and budget disclosure block at boundary', () => {
    for (const text of ['Visit https://x.test', 'Price is SAR 12', 'MOQ 500', 'contact us www.example.com'])
      expect(evaluateChannel({ ...message, channel: 'sms', text }, contact).ok).toBe(false);
    expect(evaluateChannel(message, { ...contact, optedOut: true }).ok).toBe(false);
    expect(evaluateChannel({ ...message, text: 'Budget is 25000' }, contact).ok).toBe(false);
  });
  it('AT-FR-REC-05-1 non-idempotent Twilio ambiguous result cannot retry blindly', async () => {
    const i = intent({ channel: 'whatsapp', purpose: 'follow_up' });
    let posts = 0;
    const adapter = new ChannelsAdapter(
      deps(
        i,
        async () => {
          posts++;
          throw new Error('timeout after creation');
        },
        twilioCredential,
      ),
      { get: async () => contact },
    );
    expect(await adapter.send(i, 'secret-ref', { ...message, channel: 'whatsapp', purpose: 'follow_up' })).toMatchObject({
      ok: false,
      retry: 'reconcile',
    });
    expect(await adapter.send(i, 'secret-ref', { ...message, channel: 'whatsapp', purpose: 'follow_up' })).toMatchObject({
      ok: false,
      retry: 'reconcile',
    });
    expect(posts).toBe(1);
  });
  it('AT-FR-ACC-02-1 credentials are fetched on each step and revoked refs stop effects', async () => {
    const i = intent();
    let lookups = 0;
    const d = deps(i, async () => ({ status: 200, headers: {}, body: { id: 'ok' } }), resendCredential);
    d.secrets = {
      resolve: async () => {
        lookups++;
        throw new Error('revoked fixture-secret');
      },
    };
    const result = await new ChannelsAdapter(d, { get: async () => contact }).send(i, 'ref', message);
    expect(result).toMatchObject({ ok: false, code: 'rejected' });
    expect(lookups).toBe(1);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
  it('AT-FR-ACC-03-1 diagnostics redact nested secrets', () => {
    const result = JSON.stringify(
      redact({ Authorization: 'Bearer fixture-secret', nested: { apiKey: 'fixture-secret' }, note: 'credential is fixture-secret' }, [
        'fixture-secret',
      ]),
    );
    expect(result).not.toContain('fixture-secret');
  });
  it('AT-FR-PAY-02-1 prepare cannot trust model-supplied approved status', async () => {
    const i = intent({ action: 'payment_capture', effectClass: 'spend', amountMinor: 22500, currency: 'SAR', instrumentId: id });
    let calls = 0;
    const adapter = new PayPalAdapter(
      deps(
        i,
        async () => {
          calls++;
          return { status: 200, headers: {}, body: {} };
        },
        paypalCredential,
      ),
    );
    expect(
      await adapter.prepare(
        {
          artifactVersionId: id,
          artifactStatus: 'approved',
          counterpartyId: id,
          payeeMerchantId: 'PAYEEMERCHANT',
          amountMinor: 22500,
          currency: 'SAR',
          purpose: 'Samples',
          returnUrl: 'https://operator.example/approved',
          cancelUrl: 'https://operator.example/cancel',
        },
        i,
        'ref',
      ),
    ).toMatchObject({ ok: false, code: 'needs_approval' });
    expect(calls).toBe(0);
  });
});

describe('verified webhook ingress and Attack 3', () => {
  const now = new Date('2026-11-12T10:00:00.000Z');
  const raw = JSON.stringify({ id: 'message1', type: 'email.received' });
  it('AT-FR-CHN-11-1 validates exact Twilio public URL and raw form parameters', () => {
    const req: WebhookRequest = {
      rawBody: 'MessageSid=SM1&Body=hello&From=%2B15555550123',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      publicUrl: 'https://operator.example/api/webhooks/twilio',
    };
    req.headers['x-twilio-signature'] = createHmac('sha1', 'auth')
      .update(`${req.publicUrl}BodyhelloFrom+15555550123MessageSidSM1`)
      .digest('base64');
    expect(verifyTwilio(req, 'auth')).toBe(true);
    expect(verifyTwilio({ ...req, rawBody: req.rawBody + '&To=attacker' }, 'auth')).toBe(false);
    expect(verifyTwilio({ ...req, publicUrl: 'https://evil.test' }, 'auth')).toBe(false);
  });
  it('AT-FR-COM-05-1 validates Resend raw body and rejects old or forged Svix signatures', () => {
    const key = Buffer.from('a-long-fixture-secret-for-tests');
    const secret = `whsec_${key.toString('base64')}`;
    const ts = String(now.getTime() / 1000);
    const req: WebhookRequest = {
      rawBody: raw,
      headers: {
        'svix-id': 'event1',
        'svix-timestamp': ts,
        'svix-signature': `v1,${createHmac('sha256', key).update(`event1.${ts}.${raw}`).digest('base64')}`,
      },
      publicUrl: 'https://operator.example/webhooks',
    };
    expect(verifyResend(req, secret, now)).toBe(true);
    expect(verifyResend({ ...req, rawBody: '{}' }, secret, now)).toBe(false);
    expect(verifyResend(req, secret, new Date(now.getTime() + 301000))).toBe(false);
  });
  it('AT-FR-REC-01-1 Shopify signature and durable dedupe defeat replay/header tampering', async () => {
    const req: WebhookRequest = {
      rawBody: raw,
      headers: {
        'x-shopify-hmac-sha256': createHmac('sha256', 'secret').update(raw).digest('base64'),
        'x-shopify-shop-domain': 'founder.myshopify.com',
        'x-shopify-topic': 'orders/paid',
      },
      publicUrl: 'https://operator.example/webhooks',
    };
    expect(verifyShopify(req, 'secret')).toBe(true);
    expect(verifyShopify({ ...req, rawBody: '{}' }, 'secret')).toBe(false);
    const seen = new Set<string>();
    let writes = 0;
    const store: WebhookStore = {
      insertVerified: async event => {
        const duplicate = seen.has(event.providerEventId);
        seen.add(event.providerEventId);
        if (!duplicate) writes++;
        return { eventId: 'event-id', duplicate, parked: false };
      },
    };
    expect(await ingestWebhook('shopify', req, 'secret', store, now)).toMatchObject({ ok: true, duplicate: false });
    expect(
      await ingestWebhook('shopify', { ...req, headers: { ...req.headers, 'x-shopify-webhook-id': 'tampered-id' } }, 'secret', store, now),
    ).toMatchObject({ ok: true, duplicate: true });
    expect(writes).toBe(1);
    expect(await ingestWebhook('shopify', { ...req, headers: {} }, 'secret', store, now)).toMatchObject({ ok: false, code: 'rejected' });
    expect(writes).toBe(1);
  });
  it('AT-FR-PAY-04-2 signed capture with wrong payee, amount, order or environment cannot confirm spent', () => {
    const event = {
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAPTURE1',
        status: 'COMPLETED',
        amount: { value: '225.00', currency_code: 'SAR' },
        payee: { merchant_id: 'PAYEEMERCHANT' },
        supplementary_data: { related_ids: { order_id: 'ORDER1' } },
        links: [{ href: 'https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE1' }],
      },
    };
    expect(correlatePayPalCapture(event, { ...expected, captureId: 'CAPTURE1' }).ok).toBe(true);
    for (const changed of [
      { payeeMerchantId: 'ATTACKER' },
      { amountMinor: 1 },
      { currency: 'USD' },
      { orderId: 'ATTACKER' },
      { captureId: 'ATTACKER' },
      { sandboxMode: false },
    ])
      expect(correlatePayPalCapture(event, { ...expected, captureId: 'CAPTURE1', ...changed }).ok).toBe(false);
  });
  it('AT-FR-PAY-04-3 PayPal verifies signature with provider before storing an event', async () => {
    const i = intent();
    const adapter = new PayPalAdapter(
      deps(
        i,
        async r => ({
          status: 200,
          headers: {},
          body: r.url.endsWith('/token') ? { access_token: 'access' } : { verification_status: 'FAILURE' },
        }),
        paypalCredential,
      ),
    );
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
      'paypal-transmission-id': 'id',
      'paypal-transmission-sig': 'forged',
      'paypal-transmission-time': now.toISOString(),
    };
    expect(
      await adapter.verifyWebhook(
        i,
        'ref',
        headers,
        JSON.stringify({ id: 'event', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }),
      ),
    ).toMatchObject({ ok: false, code: 'rejected' });
  });
});

function budgets(): ServiceBudgetStore {
  const started = new Set<string>();
  return {
    reserve: async (_m, key) => {
      if (started.has(key)) return false;
      started.add(key);
      return true;
    },
    complete: async () => {},
    ambiguous: async () => {},
  };
}
describe('real generation, research and commerce contract paths', () => {
  it('AT-FR-ART-01-1 structured generation validates output and exposes no tools', async () => {
    const i = intent();
    let requests = 0;
    const adapter = new OpenAIGenerationAdapter(
      deps(
        i,
        async r => {
          requests++;
          const body = JSON.parse(r.body ?? '{}') as Record<string, unknown>;
          expect(body['tools']).toBeUndefined();
          return {
            status: 200,
            headers: {},
            body: {
              id: 'resp_1',
              status: 'completed',
              output: [{ type: 'message', content: [{ type: 'output_text', text: '{"name":"Draft"}' }] }],
              usage: { input_tokens: 10, output_tokens: 4 },
            },
          };
        },
        { ...baseCredential, apiKey: 'fixture-key', allowedModels: ['approved-model'], maxOutputTokens: 100 },
      ),
      budgets(),
    );
    const result = await adapter.structured(
      i,
      'ref',
      { model: 'approved-model', instructions: 'Extract only.', input: 'Supplier message.', maxOutputTokens: 100 },
      z.object({ name: z.string() }).strict(),
      'draft',
    );
    expect(result).toMatchObject({ ok: true, data: { output: { name: 'Draft' } } });
    expect(requests).toBe(1);
    expect(
      await adapter.structured(
        i,
        'ref',
        { model: 'approved-model', instructions: 'Extract.', input: 'Data.', maxOutputTokens: 100 },
        z.object({ name: z.string() }),
        'draft',
      ),
    ).toMatchObject({ ok: false });
    expect(requests).toBe(1);
  });
  it('AT-FR-SUP-01-1 Browserbase creates bounded real session and releases it', async () => {
    const i = intent();
    const requests: HttpRequest[] = [];
    const adapter = new BrowserbaseResearchAdapter(
      deps(
        i,
        async r => {
          requests.push(r);
          return {
            status: 200,
            headers: {},
            body: r.url.endsWith('/sessions') ? { id, connectUrl: 'wss://connect.browserbase.com/session' } : { id, status: 'COMPLETED' },
          };
        },
        { ...baseCredential, apiKey: 'fixture-key', projectId: 'project', allowedHosts: ['supplier.example'], maxSessionSeconds: 60 },
      ),
      budgets(),
      {
        read: async () => ({
          url: 'https://supplier.example/',
          title: 'Supplier',
          text: 'Untrusted supplier claim.',
          screenshotBase64: 'base64',
        }),
      },
    );
    expect(await adapter.fetchPage(i, 'ref', { url: 'https://supplier.example/', timeoutSeconds: 30 })).toMatchObject({
      ok: true,
      data: { kind: 'untrusted_data', provenance: { sessionId: id } },
    });
    expect(requests.length).toBe(2);
    expect(requests[1]?.body).toContain('REQUEST_RELEASE');
  });
  it('AT-FR-CMR-06-1 publication without specific approval is held before API call', async () => {
    const i = intent({ action: 'store_publish', effectClass: 'publish' });
    let posts = 0;
    const adapter = new ShopifyAdapter(
      deps(
        i,
        async () => {
          posts++;
          return { status: 200, headers: {}, body: {} };
        },
        {
          ...baseCredential,
          accessToken: 'secret',
          shopDomain: 'founder.myshopify.com',
          apiVersion: '2026-10',
          developmentStore: true,
          ownerFounderId: other,
          counterpartyId: id,
        },
      ),
    );
    expect(await adapter.publish(i, 'ref', 'gid://shopify/Product/1', 'gid://shopify/Publication/1')).toMatchObject({
      ok: false,
      code: 'needs_approval',
    });
    expect(posts).toBe(0);
  });
  it('AT-FR-CMR-06-2 updating live shop policies always requires publication approval', async () => {
    const i = intent({ action: 'store_publish_policy', effectClass: 'publish' });
    let posts = 0;
    const adapter = new ShopifyAdapter(
      deps(
        i,
        async () => {
          posts++;
          return { status: 200, headers: {}, body: {} };
        },
        {
          ...baseCredential,
          accessToken: 'secret',
          shopDomain: 'founder.myshopify.com',
          apiVersion: '2026-10',
          developmentStore: true,
          ownerFounderId: other,
          counterpartyId: id,
        },
      ),
    );
    expect(
      await adapter.configure(i, 'ref', {
        kind: 'policy',
        policyType: 'REFUND_POLICY',
        body: 'Public policy text.',
        approvedArtifactVersionId: id,
      }),
    ).toMatchObject({ ok: false, code: 'needs_approval' });
    expect(posts).toBe(0);
    expect(
      await adapter.configure({ ...i, action: 'store_configure', effectClass: 'communicate' }, 'ref', {
        kind: 'policy',
        policyType: 'REFUND_POLICY',
        body: 'Public policy text.',
        approvedArtifactVersionId: id,
      }),
    ).toMatchObject({ ok: false, code: 'validation' });
    expect(posts).toBe(0);
  });
  it('AT-FR-CMR-06-3 publishing activates the specifically approved draft, publishes it and verifies the result', async () => {
    const i = intent({ action: 'store_publish', effectClass: 'publish', approvalToken: token });
    const productId = 'gid://shopify/Product/1',
      publicationId = 'gid://shopify/Publication/1';
    const queries: string[] = [];
    const sourceVersionId = other,
      draft = {
        kind: 'product',
        title: 'Approved fragrance',
        descriptionHtml: '<p>Floral fragrance</p>',
        vendor: 'Founder',
        productType: 'Fragrance',
        approvedArtifactVersionId: sourceVersionId,
      };
    const d = deps(
      i,
      async r => {
        const body = JSON.parse(r.body ?? '{}') as { query: string };
        queries.push(body.query);
        return {
          status: 200,
          headers: {},
          body: {
            data: body.query.includes('ReviewedProduct')
              ? {
                  product: {
                    id: productId,
                    title: draft.title,
                    descriptionHtml: draft.descriptionHtml,
                    vendor: draft.vendor,
                    productType: draft.productType,
                  },
                }
              : body.query.includes('productUpdate')
                ? { productUpdate: { product: { id: productId, status: 'ACTIVE' }, userErrors: [] } }
                : body.query.includes('publishablePublish')
                  ? { publishablePublish: { publishable: { publicationCount: 1 }, userErrors: [] } }
                  : { product: { id: productId, status: 'ACTIVE', publishedOnPublication: true } },
          },
        };
      },
      {
        ...baseCredential,
        accessToken: 'secret',
        shopDomain: 'founder.myshopify.com',
        apiVersion: '2026-10',
        developmentStore: true,
        ownerFounderId: other,
        counterpartyId: id,
      },
    );
    d.approvedArtifacts = {
      get: async (_mission, version) => ({
        status: 'approved',
        content: version === sourceVersionId ? draft : { productId, publicationId },
      }),
    };
    expect(await new ShopifyAdapter(d).publish(i, 'ref', productId, publicationId, sourceVersionId)).toMatchObject({
      ok: true,
      data: { status: 'published', confirmationSource: 'verified_poll' },
    });
    expect(queries).toHaveLength(4);
    expect(queries[0]).toContain('ReviewedProduct');
    expect(queries[1]).toContain('productUpdate');
    expect(queries[2]).toContain('publishablePublish');
    expect(queries[3]).toContain('publishedOnPublication');
  });
  it('FR-CPL-05 changed live product copy is held before any publication mutation', async () => {
    const i = intent({ action: 'store_publish', effectClass: 'publish', approvalToken: token }),
      productId = 'gid://shopify/Product/1',
      publicationId = 'gid://shopify/Publication/1',
      sourceVersionId = other;
    let reads = 0,
      mutations = 0;
    const draft = {
      kind: 'product',
      title: 'Approved fragrance',
      descriptionHtml: 'Floral notes',
      vendor: 'Founder',
      productType: 'Fragrance',
      approvedArtifactVersionId: sourceVersionId,
    };
    const d = deps(
      i,
      async r => {
        const body = JSON.parse(r.body ?? '{}') as { query: string };
        if (body.query.startsWith('mutation')) mutations++;
        else reads++;
        return { status: 200, headers: {}, body: { data: { product: { id: productId, ...draft, title: 'Unapproved cure claim' } } } };
      },
      {
        ...baseCredential,
        accessToken: 'secret',
        shopDomain: 'founder.myshopify.com',
        apiVersion: '2026-10',
        developmentStore: true,
        ownerFounderId: other,
        counterpartyId: id,
      },
    );
    d.approvedArtifacts = {
      get: async (_mission, version) => ({
        status: 'approved',
        content: version === sourceVersionId ? draft : { productId, publicationId },
      }),
    };
    expect(await new ShopifyAdapter(d).publish(i, 'ref', productId, publicationId, sourceVersionId)).toMatchObject({
      ok: false,
      code: 'needs_approval',
    });
    expect(reads).toBe(1);
    expect(mutations).toBe(0);
  });
  it('AT-FR-PAY-07-2 a refund poll must match original order/capture, amount, payee and environment', async () => {
    const i = intent({
      action: 'payment_refund',
      effectClass: 'spend',
      amountMinor: 5000,
      currency: 'SAR',
      instrumentId: id,
      approvalToken: token,
    });
    const adapter = new PayPalAdapter(
      deps(
        i,
        async r => ({
          status: 200,
          headers: {},
          body: r.url.endsWith('/token')
            ? { access_token: 'access' }
            : r.url.includes('/refunds/')
              ? {
                  id: 'REFUND1',
                  status: 'COMPLETED',
                  amount: { value: '50.00', currency_code: 'SAR' },
                  links: [{ rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE1' }],
                }
              : order('COMPLETED'),
        }),
        paypalCredential,
      ),
    );
    expect(await adapter.verifyRefund(i, 'ref', expected, 'REFUND1', 5000)).toMatchObject({
      ok: true,
      data: { refundId: 'REFUND1', confirmationSource: 'verified_poll', amountMinor: 5000 },
    });
    expect(await adapter.verifyRefund(i, 'ref', { ...expected, captureId: 'WRONG' }, 'REFUND1', 5000)).toMatchObject({ ok: false });
    expect(await adapter.verifyRefund(i, 'ref', expected, 'REFUND1', 4000)).toMatchObject({ ok: false });
  });
  it('AT-FR-CMR-01-1 Shopify OAuth rejects forged callback before token exchange', async () => {
    const i = intent();
    let exchanges = 0;
    const config = {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://operator.example/callback',
      scopes: ['write_products'],
    };
    expect(shopifyAuthorizationUrl('founder.myshopify.com', 'random-state-'.repeat(4), config)).toContain('scope=write_products');
    const callback = new URL(
      `https://operator.example/callback?shop=founder.myshopify.com&code=code&state=${'random-state-'.repeat(4)}&hmac=${'a'.repeat(64)}&timestamp=${Math.floor(Date.now() / 1000)}`,
    );
    expect(
      await completeShopifyOAuth(
        callback,
        config,
        { consumeState: async () => ({ missionId: id, credentialRef: 'ref' }), saveToken: async () => {} },
        new Boundary(
          deps(
            i,
            async () => {
              exchanges++;
              return { status: 200, headers: {}, body: {} };
            },
            {},
          ),
        ),
      ),
    ).toMatchObject({ ok: false, code: 'rejected' });
    expect(exchanges).toBe(0);
  });
});
