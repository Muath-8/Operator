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
import {
  executeApprovedProviderEffect,
  sendProviderMessage,
  prepareApprovedPayPalOrder,
  captureApprovedPayPalOrder,
} from './provider-tools.js';
import { TaskBriefSchema } from './contracts.js';
import { assessQuoteRoute, recordScorecard } from './sourcing.js';
import {
  prepareRfq,
  shortlistCampaign,
  registerCampaignSample,
  linkCampaignProforma,
  linkCampaignInspection,
  confirmCampaignInspection,
  createSourcingCampaign,
  reconcileSourcingCampaigns,
  readSourcingCampaign,
  confirmCampaignException,
  type CampaignRecipientSchema,
} from './sourcing-campaign.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_campaign_${Date.now()}`,
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
describe('FR-PLY04/05 FR-SUP02/03/06 native durable sourcing campaign', () => {
  it('rechecks supplier verification inside the actual policy dispatch after a frozen recipient was selected', async () => {
    const f = await fixture(),
      id = await campaign(f),
      row = (await db.query('select id from public.sourcing_campaign_recipients where campaign_id=$1 order by id limit 1', [id])).rows[0];
    if (!row) throw new Error('Expected selected campaign recipient');
    const next = await withRole('lead_role', f.scope, async c =>
        z
          .object({ taskId: z.uuid(), supplierId: z.uuid(), mandateId: z.uuid(), dispatchVersionId: z.uuid() })
          .passthrough()
          .parse(
            (await c.query('select public.next_sourcing_campaign_recipient($1,$2)result', [f.scope.missionId, row.id])).rows[0]?.result,
          ),
      ),
      candidate = f.recipients.find(r => r.supplierId === next.supplierId);
    if (!candidate) throw new Error('Expected frozen candidate evidence');
    await withRole('founder_role', f.scope, c =>
      c.query(
        "select public.append_evidence($1,'supply','supplier_signal','claimed',$2,'document','Synthetic corrected registry verification',null,$3)",
        [
          f.scope.missionId,
          { supplierId: next.supplierId, signalKind: 'registry', independentSource: 'corrected.example' },
          candidate.verificationEvidenceIds[0],
        ],
      ),
    );
    const task = TaskBriefSchema.parse({
        id: next.taskId,
        missionId: f.scope.missionId,
        role: 'operations',
        outcome: 'supply',
        objective: 'Synthetic selected-to-dispatch verification race',
        constraints: [],
        budgetAuthority: [next.mandateId],
        deadline: new Date(Date.now() + 60000).toISOString(),
        doneCriteria: ['Matching real receipt'],
        evidenceRequired: ['Current verification'],
        playbook: { id: 'fixture', version: 1, step: 'rfq', source: 'https://example.test' },
        maxToolCalls: 1,
        maxTokens: 256,
        tier: 'small',
        requestedByFounder: false,
        overdueExposure: false,
        unblocks: [],
        parentRunId: null,
      }),
      requests: HttpRequest[] = [];
    const sent = await sendProviderMessage(
      new ProviderStorage(f.scope),
      task,
      { counterpartyId: next.supplierId, artifactVersionId: next.dispatchVersionId, mandateId: next.mandateId },
      'email',
      false,
      captureTransport(requests),
    );
    expect(sent.ok).toBe(false);
    expect(requests).toHaveLength(0);
    expect((await readSourcingCampaign(f.scope, id)).sentCount).toBe(0);
  });
  it('narrows to three actual compliant scorecards, counts two confirmed distinct sample payees, and gates deposit/balance on proforma/clean inspection', async () => {
    const f = await fixture(),
      id = await campaign(f),
      requests: HttpRequest[] = [];
    await reconcileSourcingCampaigns(f.scope, captureTransport(requests));
    const assessment = await assessed(f),
      suppliers = assessment.ranking.map(r => r.supplierId),
      first = suppliers[0],
      second = suppliers[1],
      sourceEvidence = assessment.quotes[0]?.evidenceId;
    if (!first || !second || !sourceEvidence) throw new Error('Expected three actual synthetic assessed suppliers');
    await expect(
      shortlistCampaign(f.scope, {
        campaignId: id,
        comparisonVersionId: assessment.comparison.version,
        supplierIds: suppliers.slice(0, 2),
      }),
    ).rejects.toThrow();
    await expect(
      withRole('specialist_role', f.scope, c =>
        c.query('select public.shortlist_sourcing_campaign($1,$2,$3,$4)', [
          f.scope.missionId,
          id,
          assessment.comparison.version,
          f.recipients.slice(0, 6).map(r => r.supplierId),
        ]),
      ),
    ).rejects.toThrow(/three to five/);
    await shortlistCampaign(f.scope, { campaignId: id, comparisonVersionId: assessment.comparison.version, supplierIds: suppliers });
    expect((await readSourcingCampaign(f.scope, id)).shortlistCurrent).toBe(true);
    const account = randomUUID();
    await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'paypal','connected','{pay}')", [
      account,
      founder,
    ]);
    await provisionProviderCredential(f.scope, {
      accountId: account,
      provider: 'paypal',
      sandboxMode: true,
      credential: {
        clientId: 'synthetic-campaign-client',
        clientSecret: 'synthetic-campaign-secret',
        merchantId: 'OWNMERCHANT',
        webhookId: 'SYNTHETIC_WEBHOOK',
        verifiedPayees: Object.fromEntries(suppliers.map(s => [s, `M${s.replaceAll('-', '').slice(0, 20).toUpperCase()}`])),
      },
    });
    const transport = paypalFixture(),
      payment = await paidSample(f, id, first, account, transport);
    await registerCampaignSample(f.scope, {
      campaignId: id,
      paymentId: payment,
      expectedArrival: new Date(Date.now() + 86400000).toISOString(),
      trackingReference: 'Tracking requested in the synthetic supplier thread',
    });
    expect((await readSourcingCampaign(f.scope, id)).paidSampleSupplierCount).toBe(1);
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
    await expect(linkCampaignProforma(f.scope, id, invoice.version)).rejects.toThrow(/two suppliers/);
    const payment2 = await paidSample(f, id, second, account, transport);
    await registerCampaignSample(f.scope, {
      campaignId: id,
      paymentId: payment2,
      expectedArrival: new Date(Date.now() + 86400000).toISOString(),
      trackingReference: 'Tracking requested for second actual synthetic paid sample',
    });
    expect((await readSourcingCampaign(f.scope, id)).paidSampleSupplierCount).toBe(2);
    await linkCampaignProforma(f.scope, id, invoice.version);
    const phase = async (stage: 'deposit' | 'balance', inspectionCommitmentId?: string) => {
      const v = await proposed(f.scope, 'payment', {
        campaignPayment: {
          campaignId: id,
          supplierId: first,
          specVersionId: f.source.version,
          stage,
          proformaVersionId: invoice.version,
          ...(inspectionCommitmentId ? { inspectionCommitmentId } : {}),
        },
        effectIntent: {
          action: 'payment_capture',
          effectClass: 'spend',
          counterpartyId: first,
          instrumentId: account,
          amountMinor: 100,
          currency: 'SAR',
        },
        payload: { synthetic: true },
      });
      await approve(f.scope, v.version);
      return v;
    };
    for (const [amountMinor, currency, stage] of [
      [30000, 'SAR', 'deposit'],
      [100, 'USD', 'deposit'],
      [100, 'SAR', null],
    ] as const) {
      const invalid = await proposed(f.scope, 'payment', {
        campaignPayment: { campaignId: id, supplierId: first, specVersionId: f.source.version, stage, proformaVersionId: invoice.version },
        effectIntent: {
          action: 'payment_capture',
          effectClass: 'spend',
          counterpartyId: first,
          instrumentId: account,
          amountMinor,
          currency,
        },
        payload: { synthetic: true },
      });
      await approve(f.scope, invalid.version);
      await expect(db.query('select private.check_version($1,$2)', [f.scope.missionId, invalid.version])).rejects.toThrow(/approval/);
    }
    const unbound = await proposed(f.scope, 'payment', {
      effectIntent: {
        action: 'payment_capture',
        effectClass: 'spend',
        counterpartyId: first,
        instrumentId: account,
        amountMinor: 100,
        currency: 'SAR',
      },
      payload: { synthetic: true },
    });
    await approve(f.scope, unbound.version);
    await expect(db.query('select private.check_version($1,$2)', [f.scope.missionId, unbound.version])).rejects.toThrow(/phase binding/);
    const deposit = await phase('deposit');
    await expect(db.query('select private.check_version($1,$2)', [f.scope.missionId, deposit.version])).resolves.toBeDefined();
    const balance = await phase('balance');
    await expect(db.query('select private.check_version($1,$2)', [f.scope.missionId, balance.version])).rejects.toThrow(/inspection/);
    const inspection = await withRole('specialist_role', f.scope, async c =>
      String(
        (
          await c.query('select public.open_inspection_commitment($1,null,$2,$3,$4)id', [
            f.scope.missionId,
            invoice.version,
            ['Dimensions and finish against the exact approved spec'],
            new Date(Date.now() + 10 * 86400000),
          ])
        ).rows[0]?.id,
      ),
    );
    await linkCampaignInspection(f.scope, id, inspection);
    const boundBalance = await phase('balance', inspection);
    await expect(db.query('select private.check_version($1,$2)', [f.scope.missionId, boundBalance.version])).rejects.toThrow(
      /clean inspection/,
    );
    const report = await withRole('specialist_role', f.scope, async c =>
        String(
          (
            await c.query(
              "select public.append_evidence($1,'supply','inspection_report','claimed',$2,'document','Synthetic inspection report; no live inspection occurred')id",
              [f.scope.missionId, { inspectionCommitmentId: inspection, synthetic: true }],
            )
          ).rows[0]?.id,
        ),
      ),
      confirmation = await proposed(f.scope, 'founder_confirmation', {
        founderConfirmation: {
          outcome: 'supply',
          kind: 'campaign_inspection_result',
          statement: 'I reviewed the synthetic report for this exact inspection and confirm its clean result in this test only.',
          payload: { campaignId: id, commitmentId: inspection, result: 'clean', sourceEvidenceIds: [report] },
        },
      }),
      decision = await approve(f.scope, confirmation.version, 'engagement', 'campaign_inspection_result');
    await confirmCampaignInspection(f.scope, decision, confirmation.version);
    await expect(db.query('select private.check_version($1,$2)', [f.scope.missionId, boundBalance.version])).resolves.toBeDefined();
    await withRole('specialist_role', f.scope, c =>
      c.query(
        "select public.append_evidence($1,'supply','inspection_report','claimed',$2,'document','Corrected synthetic inspection report',null,$3)",
        [f.scope.missionId, { inspectionCommitmentId: inspection, result: 'failed' }, report],
      ),
    );
    await expect(db.query('select private.check_version($1,$2)', [f.scope.missionId, boundBalance.version])).rejects.toThrow(
      /clean inspection/,
    );
    const third = suppliers[2];
    if (!third) throw new Error('Expected third frozen shortlisted supplier');
    const historicalPayment = await paidSample(f, id, third, account, transport);
    await withRole('specialist_role', f.scope, c =>
      c.query('select public.append_artifact_version($1,$2,$3)', [
        f.scope.missionId,
        f.source.artifact,
        { components: [{ revision: true }] },
      ]),
    );
    await registerCampaignSample(f.scope, {
      campaignId: id,
      paymentId: historicalPayment,
      expectedArrival: new Date(Date.now() + 86400000).toISOString(),
      trackingReference: 'Historical paid sample obligation survives later spec revision',
    });
    expect(await readSourcingCampaign(f.scope, id)).toMatchObject({ current: false, paidSampleSupplierCount: 3 });
  }, 15000);
  it('fans out one identical approved RFQ to eight verified suppliers and survives concurrent retry/restart without duplicates', async () => {
    const f = await fixture(),
      id = await campaign(f),
      requests: HttpRequest[] = [];
    await Promise.all([
      reconcileSourcingCampaigns(f.scope, captureTransport(requests)),
      reconcileSourcingCampaigns(f.scope, captureTransport(requests)),
    ]);
    expect(requests).toHaveLength(8);
    const messages = (
      await db.query("select artifact_version_refs from public.messages where mission_id=$1 and direction='outbound'", [f.scope.missionId])
    ).rows;
    expect(messages).toHaveLength(8);
    for (const message of messages)
      expect(message.artifact_version_refs).toEqual(expect.arrayContaining([f.rfq.artifactVersionId, f.source.version]));
    expect(new Set(requests.map(r => JSON.parse(String(r.body)).text))).toHaveLength(1);
    expect(await readSourcingCampaign(f.scope, id)).toMatchObject({
      current: true,
      recipientCount: 8,
      sentCount: 8,
      paidSampleSupplierCount: 0,
      shortlistCurrent: false,
    });
    await closeDatabasePools();
    expect(await reconcileSourcingCampaigns(f.scope, captureTransport(requests))).toMatchObject({ examined: 0, sent: 0 });
    expect(requests).toHaveLength(8);
  });
  it('rejects duplicate recipients, seven without explicit exception, and source-version mutation', async () => {
    const f = await fixture();
    await expect(
      createSourcingCampaign(f.scope, {
        rfqVersionId: f.rfq.artifactVersionId,
        recipients: f.recipients.slice(0, 7),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/eight/);
    await expect(
      createSourcingCampaign(f.scope, {
        rfqVersionId: f.rfq.artifactVersionId,
        recipients: [...f.recipients.slice(0, 7), f.recipients[0] as Recipient],
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/duplicate/);
    const key = randomUUID(),
      id = await createSourcingCampaign(f.scope, { rfqVersionId: f.rfq.artifactVersionId, recipients: f.recipients, idempotencyKey: key });
    expect(
      await createSourcingCampaign(f.scope, {
        rfqVersionId: f.rfq.artifactVersionId,
        recipients: [...f.recipients].reverse(),
        idempotencyKey: key,
      }),
    ).toBe(id);
    await withRole('specialist_role', f.scope, c =>
      c.query('select public.append_artifact_version($1,$2,$3)', [
        f.scope.missionId,
        f.source.artifact,
        { components: [{ changed: true }] },
      ]),
    );
    const requests: HttpRequest[] = [];
    expect((await reconcileSourcingCampaigns(f.scope, captureTransport(requests))).held).toBe(8);
    expect(requests).toHaveLength(0);
    expect((await readSourcingCampaign(f.scope, id)).current).toBe(false);
  });
  it('Guide drafts remain unsent; approving the exact original-task draft releases only that recipient', async () => {
    const f = await fixture(8, 'guide'),
      id = await campaign(f),
      requests: HttpRequest[] = [];
    expect((await reconcileSourcingCampaigns(f.scope, captureTransport(requests))).held).toBe(8);
    expect(requests).toHaveLength(0);
    expect((await readSourcingCampaign(f.scope, id)).sentCount).toBe(0);
    const row = (
      await db.query(
        "select v.id from public.artifact_versions v join public.sourcing_campaign_recipients r on r.task_id::text=v.content->>'originatingTaskId'where r.campaign_id=$1 order by v.created_at limit 1",
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('Expected held RFQ draft');
    await approve(f.scope, String(row.id), 'engagement', 'rfq_send', true);
    expect((await executeApprovedProviderEffect(f.scope, String(row.id), randomUUID(), captureTransport(requests))).ok).toBe(true);
    await reconcileSourcingCampaigns(f.scope, captureTransport(requests));
    expect(requests).toHaveLength(1);
    expect((await readSourcingCampaign(f.scope, id)).sentCount).toBe(1);
  });
  it('provider uncertainty remains held and does not fabricate deliveries or repeat ambiguous sends', async () => {
    const f = await fixture(),
      id = await campaign(f);
    let calls = 0;
    const down: Transport = async () => {
      calls++;
      throw new Error('Explicit test transport timeout');
    };
    await reconcileSourcingCampaigns(f.scope, down);
    await reconcileSourcingCampaigns(f.scope, down);
    expect(calls).toBe(8);
    expect((await readSourcingCampaign(f.scope, id)).sentCount).toBe(0);
  });
  it('a verified candidate opt-out after selection but before dispatch prevents the actual provider request', async () => {
    const f = await fixture(),
      id = await campaign(f),
      recipient = (await db.query('select id from public.sourcing_campaign_recipients where campaign_id=$1 order by id limit 1', [id]))
        .rows[0];
    if (!recipient) throw new Error('Expected campaign recipient');
    await withRole('lead_role', f.scope, c =>
      c.query('select public.next_sourcing_campaign_recipient($1,$2)', [f.scope.missionId, recipient.id]),
    );
    const supplier = (await db.query('select supplier_id from public.sourcing_campaign_recipients where id=$1', [recipient.id])).rows[0]
      ?.supplier_id;
    await db.query("insert into public.counterparty_optouts(mission_id,counterparty_id,source)values($1,$2,'Synthetic campaign opt-out')", [
      f.scope.missionId,
      supplier,
    ]);
    const requests: HttpRequest[] = [];
    await reconcileSourcingCampaigns(f.scope, captureTransport(requests));
    expect(requests).toHaveLength(7);
    expect((await readSourcingCampaign(f.scope, id)).sentCount).toBe(7);
  });
  it('narrow founder candidate-count exception binds exact RFQ and recipients and grants no broad sourcing readiness risk', async () => {
    const f = await fixture(4),
      source = await withRole('founder_role', f.scope, async c =>
        String(
          (
            await c.query(
              "select public.append_evidence($1,'supply','supply_limit','founder_confirmed','{\"synthetic\":true}','document','Synthetic limited supplier market fixture')id",
              [f.scope.missionId],
            )
          ).rows[0]?.id,
        ),
      ),
      v = await proposed(f.scope, 'founder_confirmation', {
        founderConfirmation: {
          outcome: 'supply',
          kind: 'sourcing_campaign_exception',
          statement: 'For this synthetic fixture, accept outreach to exactly these four verified suppliers.',
          payload: {
            riskAccepted: true,
            exception: 'rfq_candidate_count',
            rfqVersionId: f.rfq.artifactVersionId,
            supplierIds: f.recipients.map(r => r.supplierId),
            sourceEvidenceIds: [source],
          },
        },
      }),
      decision = await approve(f.scope, v.version, 'engagement', 'sourcing_campaign_exception'),
      exception = await confirmCampaignException(f.scope, decision, v.version),
      id = await createSourcingCampaign(f.scope, {
        rfqVersionId: f.rfq.artifactVersionId,
        recipients: f.recipients,
        idempotencyKey: randomUUID(),
        exceptionEvidenceId: exception,
      });
    expect((await readSourcingCampaign(f.scope, id)).recipientCount).toBe(4);
    expect(
      (
        await db.query("select count(*)::int n from public.evidence where mission_id=$1 and kind='sourcing_risk_accepted'", [
          f.scope.missionId,
        ])
      ).rows[0]?.n,
    ).toBe(0);
    await expect(
      createSourcingCampaign(f.scope, {
        rfqVersionId: f.rfq.artifactVersionId,
        recipients: f.recipients.slice(0, 3),
        idempotencyKey: randomUUID(),
        exceptionEvidenceId: exception,
      }),
    ).rejects.toThrow(/eight/);
  });
  it('denies cross-tenant campaign reads, direct ledger mutation and founder campaign creation', async () => {
    const f = await fixture(),
      id = await campaign(f);
    await expect(readSourcingCampaign({ authUserId: randomUUID(), missionId: f.scope.missionId }, id)).rejects.toThrow(/mission denied/);
    await expect(
      withRole('founder_role', f.scope, c =>
        c.query('select public.create_sourcing_campaign($1,$2,$3,$4,null)', [
          f.scope.missionId,
          f.rfq.artifactVersionId,
          JSON.stringify(f.recipients),
          randomUUID(),
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(db.query('update public.sourcing_campaigns set request_key=$1 where id=$2', [randomUUID(), id])).rejects.toThrow(
      /append.only/,
    );
  });
});
