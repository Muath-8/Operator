import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryEffectRepository } from '../../policy/src/testing.js';
import { bindingHash, tokenHash, type EffectIntent, type PolicySnapshot } from '@lo/policy';
import {
  GoDaddyAdapter,
  RegistrationProposalSchema,
  registrationConsentStatement,
  registrationOperationKey,
  type RegistrationQuote,
} from './godaddy.js';
import { probeProviderConnection } from './connection.js';
import type { HttpRequest, Transport } from './core.js';

function fixture(
  options: {
    pending?: boolean;
    wrongDomain?: boolean;
    wrongPrice?: boolean;
    wrongPrincipal?: boolean;
    timeout?: boolean;
    expired?: boolean;
    noApproval?: boolean;
    unapproved?: boolean;
  } = {},
) {
  const mission = randomUUID(),
    party = randomUUID(),
    version = randomUUID(),
    account = randomUUID(),
    principal = randomUUID(),
    registrationId = randomUUID(),
    operationId = randomUUID(),
    now = new Date(),
    agreedAt = new Date(now.getTime() - 1000).toISOString(),
    secret = 'explicit-test-only-founder-approval',
    quoteToken = 'explicit-test-only-private-quote-token',
    quote: RegistrationQuote = {
      domain: 'explicit-test-domain.example',
      period: 1,
      price: { currencyCode: 'USD', value: 1199 },
      fees: [{ type: 'ONE_TIME_PREMIUM_DOMAIN_PURCHASE', fee: { currencyCode: 'USD', value: 301 } }],
      requiredAgreements: [
        { agreementType: 'API_DPA', title: 'Domain purchase agreement', url: 'https://www.godaddy.com/agreements/showdoc?pageid=reg_sa' },
      ],
      expiresAt: new Date(now.getTime() + (options.expired ? -1000 : 600000)).toISOString(),
      totalMinor: 1500,
      currency: 'USD',
    },
    proposal = RegistrationProposalSchema.parse({ ...quote, quoteId: randomUUID(), consentStatement: registrationConsentStatement(quote) }),
    intent: EffectIntent = {
      missionId: mission,
      taskId: randomUUID(),
      action: 'registration',
      effectClass: 'spend',
      counterpartyId: party,
      artifactVersionId: version,
      instrumentId: account,
      amountMinor: 1500,
      currency: 'USD',
      idempotencyKey: randomUUID(),
      mode: 'do',
      sandboxMode: true,
      newContact: false,
      ...(!options.noApproval ? { approvalToken: secret } : {}),
    },
    state: PolicySnapshot = {
      paused: false,
      killed: false,
      sandboxMode: true,
      missionCurrency: 'USD',
      budgetRemainingMinor: 100000,
      mandates: [],
      approval: {
        tokenHash: tokenHash(secret),
        bindingHash: bindingHash(intent),
        expiresAt: new Date(now.getTime() + 3600000).toISOString(),
        consumed: false,
        revoked: false,
      },
    },
    repository = new MemoryEffectRepository(state, 'test'),
    requests: HttpRequest[] = [],
    acks: string[] = [];
  let pending = options.pending ?? false;
  const completed = () => ({
    registrationId,
    operationId,
    domain: options.wrongDomain ? 'other.example' : quote.domain,
    period: 1,
    price: { ...quote.price, value: options.wrongPrice ? 1 : 1199 },
    fees: quote.fees,
    status: pending ? 'EXECUTING' : 'COMPLETED',
    expiresAt: new Date(now.getTime() + 366 * 86400000).toISOString(),
    consent: {
      agreementTypes: ['API_DPA'],
      agreedAt,
      acknowledgedFees: quote.fees,
      agreedBy: { principal: options.wrongPrincipal ? randomUUID() : principal },
    },
  });
  const transport: Transport = async request => {
    requests.push(request);
    expect(request.url.startsWith('https://api.ote-godaddy.com/v3/domains/')).toBe(true);
    expect(request.headers['Authorization']).toBe('Bearer explicit-test-only-registrar-pat');
    if (request.url.includes('check-availability')) return { status: 200, headers: {}, body: { domain: quote.domain, available: true } };
    if (request.url.endsWith('registration-quotes'))
      return {
        status: 200,
        headers: {},
        body: {
          quoteToken,
          expiresAt: quote.expiresAt,
          requiredAgreements: quote.requiredAgreements,
          items: [{ domain: quote.domain, period: 1, price: quote.price, fees: quote.fees }],
        },
      };
    if (request.url.endsWith('/registrations')) {
      if (options.timeout) throw new Error('Explicit test timeout after request');
      return { status: 202, headers: {}, body: completed() };
    }
    expect(acks).toContain(registrationId);
    return { status: 200, headers: {}, body: completed() };
  };
  const adapter = new GoDaddyAdapter({
    repository,
    secrets: {
      resolve: async () => ({
        missionId: mission,
        sandboxMode: true,
        revoked: false,
        pat: 'explicit-test-only-registrar-pat',
        accountPrincipalId: principal,
        registrantProfileConfirmed: true,
        billingProfileConfirmed: true,
        counterpartyId: party,
      }),
    },
    context: { role: 'policy' },
    now: () => now,
    transport,
    approvedArtifacts: { get: async () => ({ status: options.unapproved ? 'proposed' : 'approved', content: proposal }) },
    preparations: { execute: async (_request, invoke) => invoke() },
  });
  return {
    adapter,
    intent,
    proposal,
    quoteToken,
    agreedAt,
    requests,
    repository,
    state,
    principal,
    registrationId,
    acks,
    complete: () => {
      pending = false;
    },
    ack: async (id: string) => {
      acks.push(id);
    },
  };
}
describe('FR-BRD05 FR-ACC01 real registrar protocol through explicit test-only transport', () => {
  it('quotes availability before the read-only quote endpoint and keeps token separate from safe display', async () => {
    const f = fixture(),
      result = await f.adapter.quote(f.intent, 'test-ref', { domain: f.proposal.domain, period: 1 });
    expect(result).toMatchObject({ ok: true, data: { quote: { totalMinor: 1500, fees: f.proposal.fees }, quoteToken: f.quoteToken } });
    if (!result.ok) throw new Error('Missing test quote');
    expect(JSON.stringify(result.data.quote)).not.toContain(f.quoteToken);
    expect(f.requests.map(r => r.method)).toEqual(['GET', 'POST']);
    expect(f.requests.some(r => r.url.endsWith('/registrations'))).toBe(false);
  });
  it('registers exact approved term and all fees, polls even a completed response, and never reissues a replay', async () => {
    const f = fixture();
    const result = await f.adapter.register(f.intent, 'test-ref', f.proposal, f.quoteToken, f.agreedAt, f.ack);
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'COMPLETED', domain: f.proposal.domain },
      receipt: { verification: { kind: 'founder_owned_domain', outcome: 'brand' } },
    });
    const first = f.requests[0];
    expect(first?.headers['Idempotency-Key']).toBe(registrationOperationKey(f.intent.idempotencyKey));
    expect(JSON.parse(first?.body ?? 'null')).toEqual({
      quoteToken: f.quoteToken,
      domain: f.proposal.domain,
      period: 1,
      consent: { agreedAt: f.agreedAt, agreementTypes: ['API_DPA'], acknowledgedFees: f.proposal.fees },
    });
    expect(f.requests.map(r => r.method)).toEqual(['POST', 'GET']);
    expect(await f.adapter.register(f.intent, 'test-ref', f.proposal, f.quoteToken, f.agreedAt, f.ack)).toMatchObject({
      ok: true,
      replay: true,
    });
    expect(f.requests).toHaveLength(2);
  });
  it.each(['noApproval', 'unapproved', 'expired'] as const)('%s prevents every registration HTTP request', async flag => {
    const f = fixture({ [flag]: true });
    expect((await f.adapter.register(f.intent, 'test-ref', f.proposal, f.quoteToken, f.agreedAt, f.ack)).ok).toBe(false);
    expect(f.requests).toHaveLength(0);
  });
  it('pause and budget failure prevent external registration', async () => {
    for (const pause of [true, false]) {
      const f = fixture();
      f.state.paused = pause;
      if (!pause) f.state.budgetRemainingMinor = 100;
      expect((await f.adapter.register(f.intent, 'test-ref', f.proposal, f.quoteToken, f.agreedAt, f.ack)).ok).toBe(false);
      expect(f.requests).toHaveLength(0);
    }
  });
  it.each(['wrongDomain', 'wrongPrice', 'wrongPrincipal'] as const)(
    '%s in the polled result cannot produce a performed receipt',
    async flag => {
      const f = fixture({ [flag]: true });
      expect(await f.adapter.register(f.intent, 'test-ref', f.proposal, f.quoteToken, f.agreedAt, f.ack)).toMatchObject({
        ok: false,
        retry: 'reconcile',
      });
      expect([...f.repository.reservations.values()].map(r => r.status)).toEqual(['ambiguous']);
      expect(f.requests).toHaveLength(2);
    },
  );
  it('pending operation keeps its durable acknowledgement and recovers by GET only', async () => {
    const f = fixture({ pending: true });
    expect(await f.adapter.register(f.intent, 'test-ref', f.proposal, f.quoteToken, f.agreedAt, f.ack)).toMatchObject({
      ok: false,
      retry: 'reconcile',
    });
    f.complete();
    expect(await f.adapter.reconcile(f.intent, 'test-ref', f.proposal, f.registrationId, f.agreedAt)).toMatchObject({
      ok: true,
      data: { data: { status: 'COMPLETED' } },
    });
    expect(f.requests.map(r => r.method)).toEqual(['POST', 'GET', 'GET']);
  });
  it('POST timeout followed by retry never creates a second registration attempt', async () => {
    const f = fixture({ timeout: true });
    expect(await f.adapter.register(f.intent, 'test-ref', f.proposal, f.quoteToken, f.agreedAt, f.ack)).toMatchObject({
      ok: false,
      retry: 'reconcile',
    });
    expect(await f.adapter.register(f.intent, 'test-ref', f.proposal, f.quoteToken, f.agreedAt, f.ack)).toMatchObject({
      ok: false,
      retry: 'reconcile',
    });
    expect(f.requests).toHaveLength(1);
    expect(f.acks).toHaveLength(0);
  });
  it('actual connection probe is read-only OTE PAT authentication and never claims verified ownership', async () => {
    const principal = randomUUID(),
      requests: HttpRequest[] = [];
    const result = await probeProviderConnection(
      'godaddy',
      {
        missionId: randomUUID(),
        sandboxMode: true,
        revoked: false,
        pat: 'explicit-test-only-pat',
        accountPrincipalId: principal,
        registrantProfileConfirmed: true,
        billingProfileConfirmed: true,
      },
      async request => {
        requests.push(request);
        return { status: 200, headers: {}, body: { domain: 'example.com', available: false } };
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'authenticated',
        providerAccountId: null,
        ownership: 'founder_attested',
        grantedScopes: ['domain_read_authenticated'],
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe('https://api.ote-godaddy.com/v3/domains/check-availability?domain=example.com');
  });
});
