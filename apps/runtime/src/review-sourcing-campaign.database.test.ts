import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PostgresMissionRepository, type JsonValue } from '@lo/state';
import type { Transport, HttpRequest } from '@lo/adapters';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { ProviderStorage, provisionProviderCredential, storeApprovalToken } from './provider-storage.js';
import { prepareApprovedPayPalOrder, captureApprovedPayPalOrder } from './provider-tools.js';
import { assessQuoteRoute, recordScorecard } from './sourcing.js';
import {
  prepareRfq,
  shortlistCampaign,
  registerCampaignSample,
  linkCampaignProforma,
  createSourcingCampaign,
  reconcileSourcingCampaigns,
  type CampaignRecipientSchema,
} from './sourcing-campaign.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_review_campaign_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  prior = { ...process.env };
let db: Client;
type Recipient = z.infer<typeof CampaignRecipientSchema>;
async function proposed(scope: ActorScope, type: string, content: Record<string, JsonValue>, outcome = 'supply') {
  return withRole('specialist_role', scope, async c => {
    const artifact = String(
        (await c.query("select public.create_artifact($1,$2,$3,'Synthetic campaign source')id", [scope.missionId, type, outcome])).rows[0]
          ?.id,
      ),
      version = String(
        (await c.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, artifact, content])).rows[0]?.id,
      );
    await c.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, version]);
    return { artifact, version };
  });
}
async function approve(
  scope: ActorScope,
  version: string,
  kind = 'selection',
  gate = 'campaign_source',
  token: boolean | { action: string; amountMinor: number; currency: string } = false,
) {
  const packet = {
      question: 'Review this exact synthetic campaign source',
      options: [
        {
          id: 'a',
          label: 'Approve exact source',
          artifactVersionIds: [version],
          evidenceIds: [],
          cost: null,
          timeDays: 0,
          consequences: 'Synthetic native fixture, no live supplier',
        },
      ],
      approvedVersionIds: [version],
      recommendation: { optionId: 'a', reasons: ['Native boundary regression'] },
      staleImpact: [],
      defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
    },
    decision = await withRole('lead_role', scope, async c =>
      String((await c.query("select public.propose_decision($1,$2,$3,'supply',$4)id", [scope.missionId, kind, packet, gate])).rows[0]?.id),
    );
  await withRole('founder_role', scope, async c => {
    await c.query("select public.resolve_decision($1,$2,'approve','a')", [scope.missionId, decision]);
    await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, version, decision]);
  });
  if (token) {
    const secret = randomBytes(32).toString('hex'),
      approval = await withRole('founder_role', scope, async c => {
        const content = (await c.query('select content from public.artifact_versions where id=$1', [version])).rows[0]?.content as {
          effectIntent: { counterpartyId: string };
        };
        const result = await new PostgresMissionRepository(c).issueApproval(
          z.uuid().parse(scope.missionId),
          decision,
          {
            action: typeof token === 'object' ? token.action : 'send_message',
            counterpartyId: content.effectIntent.counterpartyId,
            amountMinor: typeof token === 'object' ? token.amountMinor : null,
            currency: typeof token === 'object' ? token.currency : null,
            artifactVersionId: version,
          },
          secret,
          new Date(Date.now() + 3600000).toISOString(),
        );
        if (!result.ok) throw new Error('Synthetic approval fixture rejected');
        return result.value;
      });
    await storeApprovalToken(scope, approval, secret);
  }
  return decision;
}
async function fixture(count = 8, mode: 'guide' | 'do' = 'do') {
  const scope = { authUserId: user, missionId: randomUUID() },
    account = randomUUID(),
    recipients: Recipient[] = [];
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,involvement,metadata)values($1,$2,'launch','Synthetic campaign test only','SAR',true,$3,'{\"budgetMinor\":900000000}')",
    [scope.missionId, founder, mode],
  );
  const source = await proposed(
    scope,
    'product_spec',
    {
      components: [
        {
          name: 'Fixture component',
          material: 'Declared stock material',
          finish: 'Declared finish',
          dimensions: { width: 20 },
          tolerances: { width: 1 },
        },
      ],
      sourcingCompatibility: {
        dimensionsMm: { width: 20 },
        rules: [{ left: 'spec.width', right: 'quote.width', relation: 'equal', toleranceMm: 1 }],
      },
    },
    'product',
  );
  await approve(scope, source.version);
  const rfq = await prepareRfq(scope, {
    specVersionId: source.version,
    quantityMin: 100,
    quantityMax: 200,
    targetDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    artworkVersionIds: [],
    language: 'en',
    subject: 'Synthetic identical RFQ',
  });
  await approve(scope, rfq.artifactVersionId);
  for (let i = 0; i < count; i++) {
    const supplier = randomUUID(),
      evidence: string[] = [];
    await db.query(
      "insert into public.counterparties(id,founder_id,kind,name,channels,verification)values($1,$2,'supplier',$3,$4,'{\"emailVerified\":true}')",
      [supplier, founder, `Synthetic supplier ${i}`, { email: `candidate${i}@test.example`, businessHourStart: 0, businessHourEnd: 24 }],
    );
    for (const [signal, independentSource] of [
      ['registry', `registry-${i}.example`],
      ['address', `inspection-${i}.example`],
    ])
      evidence.push(
        await withRole('founder_role', scope, async c =>
          String(
            (
              await c.query(
                "select public.append_evidence($1,'supply','supplier_signal','founder_confirmed',$2,'document','Explicit synthetic candidate verification fixture')id",
                [scope.missionId, { supplierId: supplier, signalKind: signal, independentSource }],
              )
            ).rows[0]?.id,
          ),
        ),
      );
    recipients.push({ supplierId: supplier, verificationEvidenceIds: evidence, mandateId: randomUUID() });
  }
  await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'resend','connected','{send}')", [
    account,
    founder,
  ]);
  await provisionProviderCredential(scope, {
    accountId: account,
    provider: 'resend',
    sandboxMode: true,
    credential: {
      apiKey: 'explicit-test-only-resend',
      from: 'operator@test.example',
      testDomain: 'test.example',
      allowedSandboxRecipients: recipients.map((_, i) => `candidate${i}@test.example`),
    },
  });
  const expires = new Date(Date.now() + 86400000).toISOString(),
    mandateScope = {
      actions: ['send_message'],
      effectClasses: ['communicate'],
      counterpartyIds: recipients.map(r => r.supplierId),
      channels: ['email'],
      purposes: ['quotation_request'],
      instrumentIds: [account],
      maxNewContacts: count,
    },
    mandateSource = await proposed(scope, 'mandate', {
      mandate: { type: 'outreach', scope: mandateScope, ceilingPer: 0, ceilingTotal: 0, currency: 'SAR', expiresAt: expires },
    }),
    decision = await approve(scope, mandateSource.version, 'mandate', 'outreach'),
    mandate = await withRole('founder_role', scope, async c =>
      String(
        (await c.query("select public.grant_mandate($1,$2,'outreach',$3,0,0,$4)id", [scope.missionId, decision, mandateScope, expires]))
          .rows[0]?.id,
      ),
    );
  for (const r of recipients) r.mandateId = mandate;
  return { scope, account, recipients, source, rfq, mandate };
}
function captureTransport(requests: HttpRequest[]): Transport {
  return async request => {
    expect(request.url).toBe('https://api.resend.com/emails');
    requests.push(request);
    return { status: 200, headers: {}, body: { id: `SYNTHETIC_RFQ_${randomUUID()}` } };
  };
}
async function assessed(f: Awaited<ReturnType<typeof fixture>>, count = 3) {
  const selected = f.recipients.slice(0, count),
    expires = new Date(Date.now() + 86400000).toISOString(),
    scope = {
      actions: ['negotiate'],
      effectClasses: ['communicate'],
      counterpartyIds: selected.map(r => r.supplierId),
      channels: ['email'],
      purposes: ['negotiation'],
      instrumentIds: [],
      maxNewContacts: 0,
      bounds: { currency: 'SAR', maxUnitPriceMinor: 300, maxMoq: 1000, maxLeadDays: 30, maxDepositPercent: 50 },
    },
    source = await proposed(f.scope, 'mandate', {
      mandate: { type: 'negotiation', scope, ceilingPer: 0, ceilingTotal: 0, currency: 'SAR', expiresAt: expires },
    }),
    decision = await approve(f.scope, source.version, 'mandate', 'negotiation'),
    mandate = await withRole('founder_role', f.scope, async c =>
      String(
        (await c.query("select public.grant_mandate($1,$2,'negotiation',$3,0,0,$4)id", [f.scope.missionId, decision, scope, expires]))
          .rows[0]?.id,
      ),
    );
  const ranking: { supplierId: string; assessmentId: string; rank: number }[] = [],
    quotes: { supplierId: string; quoteId: string; evidenceId: string }[] = [];
  for (const [index, r] of selected.entries()) {
    const thread = String(
        (
          await db.query('select id from public.threads where mission_id=$1 and counterparty_id=$2 limit 1', [
            f.scope.missionId,
            r.supplierId,
          ])
        ).rows[0]?.id,
      ),
      message = String(
        (
          await db.query(
            "insert into public.messages(mission_id,thread_id,channel,direction,original,provider_id)values($1,$2,'email','inbound','Synthetic quoted terms for the exact RFQ',$3)returning id",
            [f.scope.missionId, thread, randomUUID()],
          )
        ).rows[0]?.id,
      ),
      reading = {
        currency: 'SAR',
        unitPriceMinor: 200,
        moq: 100,
        leadDays: 10,
        validUntil: expires,
        incoterm: 'FOB',
        depositPercent: 30,
        tiers: [],
        terms: 'Explicit synthetic supplier quotation',
        language: 'en',
        unit: 'unit',
        dimensionsMm: { width: 20 },
      },
      quote = await withRole('specialist_role', f.scope, async c =>
        z
          .object({ id: z.uuid(), sourceEvidenceId: z.uuid() })
          .passthrough()
          .parse(
            (
              await c.query('select public.record_sourcing_readings($1,$2,$3,$4,$5)result', [
                f.scope.missionId,
                message,
                randomUUID(),
                { extractorId: 'synthetic-first', reading, failure: null },
                { extractorId: 'synthetic-second', reading, failure: null },
              ])
            ).rows[0]?.result,
          ),
      ),
      route = await assessQuoteRoute(f.scope, { quoteId: quote.id, specVersionId: f.source.version, negotiationMandateId: mandate });
    expect(route.eligible).toBe(true);
    const card = await recordScorecard(f.scope, { quoteId: quote.id, specVersionId: f.source.version, observations: [] });
    expect(card.cells).toHaveLength(8);
    expect(card.cells.every(c => c.label === 'not yet observed')).toBe(true);
    ranking.push({ supplierId: r.supplierId, assessmentId: route.id, rank: index + 1 });
    quotes.push({ supplierId: r.supplierId, quoteId: quote.id, evidenceId: quote.sourceEvidenceId });
  }
  const comparison = await proposed(f.scope, 'supplier_comparison', { specVersionId: f.source.version, ranking });
  return { comparison, ranking, quotes };
}
function paypalFixture(): Transport {
  const orders = new Map<string, { unit: Record<string, unknown>; captured: boolean }>();
  return async request => {
    if (request.url.endsWith('/v1/oauth2/token'))
      return { status: 200, headers: {}, body: { access_token: 'synthetic-paypal-token', expires_in: 300 } };
    if (request.url.endsWith('/v2/checkout/orders') && request.method === 'POST') {
      const body = z
        .object({ purchase_units: z.array(z.record(z.string(), z.unknown())).length(1) })
        .passthrough()
        .parse(JSON.parse(String(request.body)));
      const unit = body.purchase_units[0];
      if (!unit) throw new Error('Expected exact synthetic purchase unit');
      const id = `SYNTHETIC_ORDER_${randomUUID()}`;
      orders.set(id, { unit, captured: false });
      return {
        status: 201,
        headers: {},
        body: {
          id,
          status: 'CREATED',
          purchase_units: [unit],
          links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
        },
      };
    }
    const match = request.url.match(/\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (!match?.[1]) throw new Error('Unexpected synthetic PayPal endpoint');
    const order = orders.get(match[1]);
    if (!order) throw new Error('Expected known synthetic order');
    if (match[2]) order.captured = true;
    return {
      status: 200,
      headers: {},
      body: {
        id: match[1],
        intent: 'CAPTURE',
        status: order.captured ? 'COMPLETED' : 'APPROVED',
        purchase_units: [
          {
            ...order.unit,
            ...(order.captured
              ? { payments: { captures: [{ id: `SYNTHETIC_CAPTURE_${match[1]}`, status: 'COMPLETED', amount: order.unit['amount'] }] } }
              : {}),
          },
        ],
      },
    };
  };
}
async function paidSample(
  f: Awaited<ReturnType<typeof fixture>>,
  campaignId: string,
  supplierId: string,
  account: string,
  transport: Transport,
) {
  const source = await proposed(f.scope, 'payment', {
    sampleOrder: { campaignId, supplierId, specVersionId: f.source.version },
    effectIntent: {
      action: 'payment_capture',
      effectClass: 'spend',
      counterpartyId: supplierId,
      instrumentId: account,
      amountMinor: 200,
      currency: 'SAR',
      purpose: 'paid sample',
    },
    payload: {
      artifactVersionId: randomUUID(),
      artifactStatus: 'approved',
      counterpartyId: supplierId,
      payeeMerchantId: `M${supplierId.replaceAll('-', '').slice(0, 20).toUpperCase()}`,
      amountMinor: 200,
      currency: 'SAR',
      purpose: 'paid sample',
      returnUrl: `http://127.0.0.1:3000/api/payments/return?mission=${f.scope.missionId}`,
      cancelUrl: 'http://127.0.0.1:3000/',
      intent: 'CAPTURE',
    },
  });
  await approve(f.scope, source.version, 'engagement', 'sample_payment', { action: 'payment_capture', amountMinor: 200, currency: 'SAR' });
  const prepared = z
    .object({ ok: z.literal(true), value: z.object({ orderId: z.string() }).passthrough() })
    .passthrough()
    .parse(await prepareApprovedPayPalOrder(f.scope, source.version, randomUUID(), transport));
  const result = z
    .object({ ok: z.literal(true), value: z.object({ paymentId: z.uuid() }).passthrough() })
    .passthrough()
    .parse(await captureApprovedPayPalOrder(f.scope, prepared.value.orderId, transport));
  return result.value.paymentId;
}
async function campaign(f: Awaited<ReturnType<typeof fixture>>) {
  return createSourcingCampaign(f.scope, { rfqVersionId: f.rfq.artifactVersionId, recipients: f.recipients, idempotencyKey: randomUUID() });
}
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  db = new Client({ connectionString: url.href });
  await db.connect();
  await db.query(
    (await readFile(`${root}/supabase/tests/bootstrap.sql`, 'utf8')).replace(
      'create role authenticated nologin noinherit nobypassrls;',
      () =>
        "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
    ),
  );
  for (const f of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(`${root}/supabase/migrations/${f}`, 'utf8'));
  if (!(await readdir(`${root}/supabase/migrations`)).includes('202611120039_sourcing_campaigns.sql'))
    await db.query(await readFile(`${root}/supabase/migrations/202611120039_sourcing_campaigns.sql.tmp`, 'utf8'));
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
  await db.query('update private.platform_controls set effects_enabled=true');
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
  process.env['PROVIDER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name}with(force)`);
  await admin.end();
});
describe('independent invoice exposure at the actual campaign payment boundary', () => {
  it.each([false, true])(
    'caps an invoice across separately approved captured or concurrently held payments (held race=%s)',
    async heldRace => {
      const f = await fixture(),
        id = await campaign(f),
        requests: HttpRequest[] = [];
      await reconcileSourcingCampaigns(f.scope, captureTransport(requests));
      const assessment = await assessed(f),
        suppliers = assessment.ranking.map(r => r.supplierId),
        first = suppliers[0],
        second = suppliers[1],
        sourceEvidence = assessment.quotes[0]?.evidenceId;
      if (!first || !second || !sourceEvidence) throw new Error('Missing synthetic supplier fixture');
      await shortlistCampaign(f.scope, { campaignId: id, comparisonVersionId: assessment.comparison.version, supplierIds: suppliers });
      const account = randomUUID();
      await db.query(
        "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'paypal','connected','{pay}')",
        [account, founder],
      );
      await provisionProviderCredential(f.scope, {
        accountId: account,
        provider: 'paypal',
        sandboxMode: true,
        credential: {
          clientId: 'synthetic-review-client',
          clientSecret: 'synthetic-review-secret',
          merchantId: 'OWNMERCHANT',
          webhookId: 'SYNTHETIC_WEBHOOK',
          verifiedPayees: Object.fromEntries(suppliers.map(s => [s, `M${s.replaceAll('-', '').slice(0, 20).toUpperCase()}`])),
        },
      });
      const transport = paypalFixture();
      for (const supplier of [first, second]) {
        const paymentId = await paidSample(f, id, supplier, account, transport);
        await registerCampaignSample(f.scope, {
          campaignId: id,
          paymentId,
          expectedArrival: new Date(Date.now() + 86400000).toISOString(),
          trackingReference: 'Synthetic paid sample tracking requested',
        });
      }
      const invoice = await proposed(f.scope, 'proforma_invoice', {
        proformaInvoice: {
          specVersionId: f.source.version,
          supplierId: first,
          amountMinor: 20000,
          currency: 'SAR',
          incoterm: 'FOB',
          stamped: true,
          stampEvidenceIds: [sourceEvidence],
        },
      });
      await approve(f.scope, invoice.version);
      await linkCampaignProforma(f.scope, id, invoice.version);
      const productionPayment = async (amountMinor: number) => {
        const source = await proposed(f.scope, 'payment', {
          campaignPayment: {
            campaignId: id,
            supplierId: first,
            specVersionId: f.source.version,
            stage: 'deposit',
            proformaVersionId: invoice.version,
          },
          effectIntent: {
            action: 'payment_capture',
            effectClass: 'spend',
            counterpartyId: first,
            instrumentId: account,
            amountMinor,
            currency: 'SAR',
            purpose: 'Exact invoice deposit',
          },
          payload: {
            artifactVersionId: randomUUID(),
            artifactStatus: 'approved',
            counterpartyId: first,
            payeeMerchantId: `M${first.replaceAll('-', '').slice(0, 20).toUpperCase()}`,
            amountMinor,
            currency: 'SAR',
            purpose: 'Exact invoice deposit',
            returnUrl: `http://127.0.0.1:3000/api/payments/return?mission=${f.scope.missionId}`,
            cancelUrl: 'http://127.0.0.1:3000/',
            intent: 'CAPTURE',
          },
        });
        await approve(f.scope, source.version, 'engagement', 'production_payment', {
          action: 'payment_capture',
          amountMinor,
          currency: 'SAR',
        });
        return source;
      };
      const initial = await productionPayment(heldRace ? 12000 : 20000);
      if (heldRace) {
        const other = await productionPayment(12000),
          storage = new ProviderStorage(f.scope),
          intents = await Promise.all(
            [initial, other].map(source =>
              storage.buildIntent(
                randomUUID(),
                'payment_capture',
                'spend',
                {
                  counterpartyId: first,
                  instrumentId: account,
                  amountMinor: 12000,
                  currency: 'SAR',
                  purpose: 'Exact invoice deposit',
                  artifactVersionId: source.version,
                },
                [],
              ),
            ),
          ),
          repository = storage.dependencies().repository,
          results = await Promise.all(intents.map(intent => repository.reserveEffect(intent))),
          allowed = results.filter(result => 'authorizationId' in result);
        expect(allowed).toHaveLength(1);
        expect(results.filter(result => 'ok' in result && result.ok === false)).toHaveLength(1);
        const winner = allowed[0];
        if (!winner) throw new Error('Missing accepted held claim');
        expect(await repository.beginEffect(winner.authorizationId)).toMatchObject({ ok: true });
        expect(
          (
            await db.query(
              "select sum((intent->>'amountMinor')::bigint)::text total from public.effect_authorizations where mission_id=$1 and intent->>'action'='payment_capture'and intent->>'artifactVersionId'=any($2::text[])",
              [f.scope.missionId, [initial.version, other.version]],
            )
          ).rows[0]?.total,
        ).toBe('12000');
        return;
      }
      const prepared = z
        .object({ ok: z.literal(true), value: z.object({ orderId: z.string() }).passthrough() })
        .passthrough()
        .parse(await prepareApprovedPayPalOrder(f.scope, initial.version, randomUUID(), transport));
      expect((await captureApprovedPayPalOrder(f.scope, prepared.value.orderId, transport)).ok).toBe(true);
      const duplicate = await productionPayment(100),
        secondPrepared = await prepareApprovedPayPalOrder(f.scope, duplicate.version, randomUUID(), transport);
      if (!secondPrepared.ok) return;
      const secondOrder = z.object({ orderId: z.string() }).passthrough().parse(secondPrepared.value);
      const captured = await captureApprovedPayPalOrder(f.scope, secondOrder.orderId, transport);
      expect(captured.ok).toBe(false);
    },
    20000,
  );
});
