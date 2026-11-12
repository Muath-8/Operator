import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bindingHash, tokenHash, type EffectIntent, type PolicySnapshot } from '@lo/policy';
import { MemoryEffectRepository } from '../../policy/src/testing.js';
import { PayPalAdapter, type PaymentCorrelation } from './paypal.js';
import { probeProviderConnection } from './connection.js';
import { ShopifyAdapter } from './shopify.js';
import { OpenAIGenerationAdapter } from './generation.js';
import { BrowserbaseResearchAdapter } from './research.js';
import type { AdapterDependencies, HttpRequest, Transport } from './core.js';
const id = '11111111-1111-4111-8111-111111111111',
  token = 'explicit-fixture-approval-'.repeat(3);
function intent(patch: Partial<EffectIntent> = {}): EffectIntent {
  return {
    missionId: id,
    taskId: 'task',
    action: 'payment_capture',
    effectClass: 'spend',
    counterpartyId: id,
    artifactVersionId: id,
    idempotencyKey: 'fixture-effect-key-001',
    mode: 'do',
    sandboxMode: true,
    mandateId: id,
    newContact: false,
    instrumentId: id,
    amountMinor: 22500,
    currency: 'SAR',
    approvalToken: token,
    ...patch,
  };
}
function dependencies(i: EffectIntent, credential: unknown, transport: Transport, content?: unknown): AdapterDependencies {
  const snapshot: PolicySnapshot = {
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
        channels: ['email'],
        purposes: ['notification'],
        instrumentIds: [id],
        currency: 'SAR',
        perTransactionMinor: 100000,
        totalMinor: 100000,
        usedActions: 0,
      },
    ],
    approval: {
      tokenHash: tokenHash(token),
      bindingHash: bindingHash(i),
      expiresAt: '2099-01-01T00:00:00.000Z',
      consumed: false,
      revoked: false,
    },
  };
  return {
    repository: new MemoryEffectRepository(snapshot, 'test'),
    context: { role: 'policy' },
    preparations: { execute: async (_request, invoke) => invoke() },
    secrets: { resolve: async () => credential },
    transport,
    now: () => new Date('2026-11-12T10:00:00Z'),
    approvedArtifacts: { get: async () => ({ status: 'approved', content }) },
  };
}
const base = { missionId: id, sandboxMode: true, revoked: false };
const paypal = {
  ...base,
  clientId: 'fixture-client',
  clientSecret: 'fixture-secret',
  merchantId: 'OWNMERCHANT',
  webhookId: 'WEBHOOK1',
  verifiedPayees: { [id]: 'PAYEEMERCHANT' },
};
const expected: PaymentCorrelation = {
  orderId: 'ORDER1',
  artifactVersionId: id,
  payeeMerchantId: 'PAYEEMERCHANT',
  amountMinor: 22500,
  currency: 'SAR',
  sandboxMode: true,
};
function order(expiration_time: string | undefined = '2026-12-01T10:00:00Z', status = 'CREATED') {
  return {
    id: 'ORDER1',
    status: 'APPROVED',
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        reference_id: id,
        amount: { currency_code: 'SAR', value: '225.00' },
        payee: { merchant_id: 'PAYEEMERCHANT' },
        payments: { authorizations: [{ id: 'AUTH1', status, ...(expiration_time ? { expiration_time } : {}) }] },
      },
    ],
  };
}
const ok = (body: unknown) => ({ status: 200, headers: {}, body });
const budgets = () => ({ reserve: vi.fn(async () => true), complete: vi.fn(async () => {}), ambiguous: vi.fn(async () => {}) });

describe('provider response failure paths with explicit transport fixtures', () => {
  it('verifies the exact dated authorization and rejects foreign environment, payee, missing/expired/wrong-state authority', async () => {
    const i = intent();
    let body = order();
    const calls: HttpRequest[] = [];
    const adapter = new PayPalAdapter(
      dependencies(i, paypal, async request => {
        calls.push(request);
        return ok(request.url.endsWith('/token') ? { access_token: 'fixture-access' } : body);
      }),
    );
    expect(await adapter.verifyAuthorization(i, 'ref', expected, 'AUTH1')).toMatchObject({
      ok: true,
      data: { authorizationId: 'AUTH1', status: 'CREATED' },
    });
    for (const mismatch of [
      { ...expected, sandboxMode: false },
      { ...expected, payeeMerchantId: 'FOREIGNMERCHANT' },
    ])
      expect(await adapter.verifyAuthorization(i, 'ref', mismatch, 'AUTH1')).toMatchObject({ ok: false });
    for (const candidate of [order('2020-01-01T00:00:00Z'), order('not-a-date'), order(undefined, 'VOIDED')]) {
      body = candidate;
      expect(await adapter.verifyAuthorization(i, 'ref', expected, 'AUTH1')).toMatchObject({ ok: false });
    }
    expect(calls.every(request => request.method === 'GET' || request.url.endsWith('/token'))).toBe(true);
  });
  it('never captures an absent or expired authorization and refuses a changed authorized amount before HTTP', async () => {
    for (const expiry of ['2020-01-01T00:00:00Z', '']) {
      const i = intent({ action: 'payment_authorization_capture' });
      const calls: HttpRequest[] = [];
      const adapter = new PayPalAdapter(
        dependencies(i, paypal, async request => {
          calls.push(request);
          return ok(request.url.endsWith('/token') ? { access_token: 'fixture-access' } : order(expiry));
        }),
      );
      expect(await adapter.captureAuthorization(i, 'ref', expected, 'AUTH1')).toMatchObject({ ok: false });
      expect(calls.some(request => request.url.endsWith('/capture'))).toBe(false);
    }
    const i = intent({ action: 'payment_authorization_capture' });
    const transport = vi.fn(async () => ok({}));
    expect(
      await new PayPalAdapter(dependencies(i, paypal, transport)).captureAuthorization(i, 'ref', { ...expected, amountMinor: 1 }, 'AUTH1'),
    ).toMatchObject({ ok: false });
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not void an authorization from another order and verifies the explicit voided state', async () => {
    const i = intent({ action: 'payment_authorization_void', effectClass: 'bind' });
    const calls: HttpRequest[] = [];
    const adapter = new PayPalAdapter(
      dependencies(i, paypal, async request => {
        calls.push(request);
        return ok(request.url.endsWith('/token') ? { access_token: 'fixture-access' } : order());
      }),
    );
    expect(await adapter.voidAuthorization(i, 'ref', expected, 'FOREIGN_AUTH')).toMatchObject({ ok: false });
    expect(calls.some(request => request.url.endsWith('/void'))).toBe(false);
    const verified = new PayPalAdapter(
      dependencies(i, paypal, async request =>
        ok(request.url.endsWith('/token') ? { access_token: 'fixture-access' } : order('2020-01-01T00:00:00Z', 'VOIDED')),
      ),
    );
    expect(await verified.verifyAuthorization(i, 'ref', expected, 'AUTH1', 'VOIDED')).toMatchObject({
      ok: true,
      data: { status: 'VOIDED' },
    });
  });
  it.each(['incomplete', 'refusal', 'malformed'] as const)(
    'never creates structured output on %s and reconciles the actual attempted budget',
    async failure => {
      const i = intent({ action: 'research', effectClass: 'communicate', approvalToken: undefined });
      const cap = budgets();
      const response = {
        id: 'fixture-response',
        status: failure === 'incomplete' ? 'incomplete' : 'completed',
        usage: { input_tokens: 10, output_tokens: 2 },
        output: [
          {
            type: 'message',
            content:
              failure === 'refusal'
                ? [{ type: 'refusal', refusal: 'Fixture refusal' }]
                : [{ type: 'output_text', text: failure === 'malformed' ? '{bad' : '{"answer":"ok"}' }],
          },
        ],
      };
      const adapter = new OpenAIGenerationAdapter(
        dependencies(i, { ...base, apiKey: 'fixture', allowedModels: ['approved-model'], maxOutputTokens: 100 }, async () => ok(response)),
        cap,
      );
      const result = await adapter.structured(
        i,
        'ref',
        { model: 'approved-model', instructions: 'Extract the supplied fact.', input: 'Untrusted source fact', maxOutputTokens: 50 },
        z.object({ answer: z.string() }).strict(),
        'Fact',
      );
      expect(result).toMatchObject({ ok: false });
      expect(cap.ambiguous).toHaveBeenCalledOnce();
      expect(cap.complete).not.toHaveBeenCalled();
    },
  );
  it('rejects generation policy/budget overflow before HTTP and invalid image response after reservation', async () => {
    const i = intent({ effectClass: 'communicate', approvalToken: undefined });
    const cap = budgets(),
      transport = vi.fn(async () => ok({ created: 1, data: [] }));
    const adapter = new OpenAIGenerationAdapter(
      dependencies(i, { ...base, apiKey: 'fixture', allowedModels: ['approved-model'], maxOutputTokens: 100 }, transport),
      cap,
    );
    expect(
      await adapter.structured(
        i,
        'ref',
        { model: 'foreign-model', instructions: 'Extract.', input: 'Fact', maxOutputTokens: 50 },
        z.object({ answer: z.string() }),
        'Fact',
      ),
    ).toMatchObject({ ok: false });
    expect(transport).not.toHaveBeenCalled();
    cap.reserve.mockResolvedValueOnce(false);
    expect(
      await adapter.image(i, 'ref', { model: 'approved-model', prompt: 'Synthetic diagram', size: '1024x1024', transparent: true }),
    ).toMatchObject({ ok: false });
    expect(transport).not.toHaveBeenCalled();
    expect(
      await adapter.image(i, 'ref', { model: 'approved-model', prompt: 'Synthetic diagram', size: '1024x1024', transparent: true }),
    ).toMatchObject({ ok: false });
    expect(cap.ambiguous).toHaveBeenCalledOnce();
  });
  it('releases an allocated research session and marks ambiguity after unsafe connect URL or read failure', async () => {
    for (const connection of ['wss://foreign.example/session', 'wss://safe.browserbase.com/session']) {
      const i = intent({ action: 'research', effectClass: 'communicate', approvalToken: undefined }),
        cap = budgets(),
        calls: HttpRequest[] = [];
      const driver = {
        read: vi.fn(async () => {
          throw new Error('Explicit local read failure');
        }),
      };
      const adapter = new BrowserbaseResearchAdapter(
        dependencies(
          i,
          { ...base, apiKey: 'fixture', projectId: 'fixture-project', allowedHosts: ['review.example'], maxSessionSeconds: 30 },
          async request => {
            calls.push(request);
            return ok(request.url.endsWith('/sessions') ? { id, connectUrl: connection } : {});
          },
        ),
        cap,
        driver,
      );
      expect(await adapter.fetchPage(i, 'ref', { url: 'https://review.example/path', timeoutSeconds: 15 })).toMatchObject({ ok: false });
      expect(cap.ambiguous).toHaveBeenCalledOnce();
      expect(cap.complete).not.toHaveBeenCalled();
      expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toEqual({ status: 'REQUEST_RELEASE' });
      expect(driver.read).toHaveBeenCalledTimes(connection.includes('foreign') ? 0 : 1);
    }
  });
  it.each(['page', 'shipping', 'policy'] as const)(
    'uses exact approved %s configuration and treats GraphQL rejection as failure',
    async kind => {
      const input =
        kind === 'page'
          ? { kind, title: 'Reviewed page', body: 'Reviewed copy', approvedArtifactVersionId: id }
          : kind === 'policy'
            ? { kind, policyType: 'PRIVACY_POLICY', body: 'Reviewed policy', approvedArtifactVersionId: id }
            : {
                kind,
                name: 'Reviewed shipping',
                countryCode: 'SA',
                rateName: 'Standard',
                amount: '10.00',
                currency: 'SAR',
                locationIds: ['gid://shopify/Location/1'],
                variantIds: ['gid://shopify/ProductVariant/1'],
                quoteEvidenceId: id,
                approvedArtifactVersionId: id,
              };
      const i = intent({
        action: kind === 'page' ? 'store_configure' : kind === 'shipping' ? 'store_publish_shipping' : 'store_publish_policy',
        effectClass: kind === 'page' ? 'communicate' : 'publish',
      });
      const credential = {
        ...base,
        accessToken: 'fixture',
        shopDomain: 'review.myshopify.com',
        apiVersion: '2026-10',
        developmentStore: true,
        ownerFounderId: id,
        counterpartyId: id,
      };
      const transport = vi.fn(async (_request: HttpRequest) => ok({ errors: [{ message: 'Explicit fixture refusal' }] }));
      const adapter = new ShopifyAdapter(dependencies(i, credential, transport, input));
      expect(await adapter.configure(i, 'ref', input)).toMatchObject({ ok: false });
      expect(transport).toHaveBeenCalledOnce();
      const variables = JSON.parse(transport.mock.calls[0]?.[0]?.body ?? '{}').variables;
      if (kind === 'page') expect(variables.page).toMatchObject({ title: input.title, isPublished: false });
      if (kind === 'policy') expect(variables.shopPolicy).toMatchObject({ body: input.body, type: 'PRIVACY_POLICY' });
      if (kind === 'shipping')
        expect(variables.profile.locationGroupsToCreate[0].zonesToCreate[0].methodDefinitionsToCreate[0].rateDefinition.price).toEqual({
          amount: '10.00',
          currencyCode: 'SAR',
        });
    },
  );
  it('authenticates the exact Browserbase project and Twilio account without sending or allocating resources', async () => {
    const requests: HttpRequest[] = [];
    const browserCredential = {
      ...base,
      apiKey: 'NEVER_EXPOSE_PROJECT_KEY',
      projectId: 'project-fixture',
      allowedHosts: ['review.example'],
      maxSessionSeconds: 30,
    };
    const transport: Transport = async request => {
      requests.push(request);
      return ok({ id: 'project-fixture' });
    };
    expect(await probeProviderConnection('browserbase', browserCredential, transport)).toMatchObject({
      ok: true,
      value: { providerAccountId: 'project-fixture', ownership: 'founder_attested' },
    });
    expect(await probeProviderConnection('browserbase', browserCredential, async () => ok({ id: 'foreign-project' }))).toMatchObject({
      ok: false,
      error: { code: 'rejected' },
    });
    const accountSid = `AC${'2'.repeat(32)}`,
      twilioCredential = {
        ...base,
        accountSid,
        authToken: 'NEVER_EXPOSE_AUTH_TOKEN',
        from: '+15555550000',
        allowedSandboxRecipients: [],
        voiceCallbackOrigin: 'https://voice.example',
      };
    expect(
      await probeProviderConnection('twilio', twilioCredential, async request => {
        requests.push(request);
        return ok({ sid: accountSid, status: 'active' });
      }),
    ).toMatchObject({ ok: true, value: { providerAccountId: accountSid } });
    expect(
      await probeProviderConnection('twilio', twilioCredential, async () => ok({ sid: accountSid, status: 'suspended' })),
    ).toMatchObject({ ok: false });
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('keeps account/model/domain checks unverified when authentication cannot establish the specific capability', async () => {
    const openai = { ...base, apiKey: 'NEVER_EXPOSE_MODEL_KEY', allowedModels: ['allowed-model'], maxOutputTokens: 100 };
    const available = await probeProviderConnection('openai', openai, async () => ok({ data: [{ id: 'allowed-model' }] }));
    expect(available).toMatchObject({
      ok: true,
      value: { status: 'authenticated', providerAccountId: null, ownership: 'founder_attested' },
    });
    expect(JSON.stringify(available)).not.toContain('NEVER_EXPOSE');
    expect(await probeProviderConnection('openai', openai, async () => ok({ data: [{ id: 'other-model' }] }))).toMatchObject({
      ok: true,
      value: { status: 'unverified' },
    });
    const resend = {
      ...base,
      apiKey: 'NEVER_EXPOSE_EMAIL_KEY',
      from: 'agent@founder.example',
      allowedSandboxRecipients: [],
      testDomain: 'founder.example',
    };
    expect(
      await probeProviderConnection('resend', resend, async () =>
        ok({ data: [{ id: 'domain1', name: 'founder.example', status: 'verified' }] }),
      ),
    ).toMatchObject({ ok: true, value: { status: 'authenticated', providerAccountId: 'domain1' } });
    expect(
      await probeProviderConnection('resend', resend, async () =>
        ok({ data: [{ id: 'domain1', name: 'foreign.example', status: 'verified' }] }),
      ),
    ).toMatchObject({ ok: true, value: { status: 'unverified' } });
    for (const status of [429, 500])
      expect(await probeProviderConnection('openai', openai, async () => ({ status, headers: {}, body: {} }))).toMatchObject({
        ok: false,
        error: { code: 'provider_down' },
      });
  });
});
