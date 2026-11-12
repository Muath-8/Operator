import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PostgresMissionRepository, type JsonValue } from '@lo/state';
import type { Transport } from '@lo/adapters';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { provisionProviderCredential, storeApprovalToken } from './provider-storage.js';
import { prepareApprovedPayPalOrder, captureApprovedPayPalOrder, executeApprovedProviderEffect } from './provider-tools.js';
import {
  prepareProfessionalEngagement,
  createProfessionalEngagement,
  reconcileProfessionalEngagements,
  receiveProfessionalDeliverable,
  confirmProfessionalDeliverable,
  readProfessionalEngagement,
  registerProfessionalPayment,
} from './professional.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_professional_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  prior = { ...process.env };
let db: Client;
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
  for (const file of (await readdir(`${root}/supabase/migrations`))
    .filter(f => f.endsWith('.sql') || f === '202611120044_professionals.sql.tmp')
    .sort())
    await db.query(await readFile(`${root}/supabase/migrations/${file}`, 'utf8'));
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
async function proposed(scope: ActorScope, type: string, content: Record<string, JsonValue>) {
  return withRole('specialist_role', scope, async c => {
    const artifact = String(
        (
          await c.query("select public.create_artifact($1,$2,'compliance','Explicit synthetic professional source')id", [
            scope.missionId,
            type,
          ])
        ).rows[0]?.id,
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
  gate = 'fixture',
  cost: { amountMinor: number; currency: string } | null = null,
) {
  const packet = {
      question: 'Approve exact synthetic professional source',
      options: [
        {
          id: 'a',
          label: 'Approve exact source',
          artifactVersionIds: [version],
          evidenceIds: [],
          cost,
          timeDays: 0,
          consequences: 'Explicit local fixture; no real professional work',
        },
      ],
      approvedVersionIds: [version],
      recommendation: { optionId: 'a', reasons: ['Native authority regression'] },
      staleImpact: [],
      defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
    },
    decision = await withRole('lead_role', scope, async c =>
      String(
        (await c.query("select public.propose_decision($1,$2,$3,'compliance',$4)id", [scope.missionId, kind, packet, gate])).rows[0]?.id,
      ),
    );
  await withRole('founder_role', scope, async c => {
    await c.query("select public.resolve_decision($1,$2,'approve','a')", [scope.missionId, decision]);
    if (
      (
        await c.query(
          'select status from public.artifact_statuses where mission_id=$1 and artifact_version_id=$2 order by created_at desc,id desc limit 1',
          [scope.missionId, version],
        )
      ).rows[0]?.status !== 'approved'
    )
      await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, version, decision]);
  });
  return decision;
}
async function fixture(mode: 'guide' | 'do' = 'do', language: 'en' | 'ar' = 'en') {
  const scope = { authUserId: user, missionId: randomUUID() },
    professional = randomUUID(),
    account = randomUUID();
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,involvement,metadata)values($1,$2,'launch','Synthetic professional coordination','SAR',true,$3,'{\"budgetMinor\":900000000}')",
    [scope.missionId, founder, mode],
  );
  await db.query(
    'insert into public.counterparties(id,founder_id,kind,name,channels,verification)values($1,$2,\'specialist\',\'Synthetic qualified professional\',\'{"email":"professional@test.example","businessHourStart":0,"businessHourEnd":24}\',\'{"emailVerified":true}\')',
    [professional, founder],
  );
  const brief = await proposed(scope, 'professional_brief', {
    objective: 'Synthetic required document crosscheck only; no live certification',
    required: ['reference', 'issuer'],
  });
  await approve(scope, brief.version);
  const signals: string[] = [];
  for (const [signal, source] of [
    ['registry', 'registry.example'],
    ['qualification', 'licence.example'],
  ])
    signals.push(
      await withRole('founder_role', scope, async c =>
        String(
          (
            await c.query(
              "select public.append_evidence($1,'compliance','professional_signal','founder_confirmed',$2,'document','Explicit synthetic qualification, not real domain verification')id",
              [
                scope.missionId,
                {
                  professionalId: professional,
                  signalKind: signal,
                  independentSource: source,
                  licenceReference: 'EXPLICIT_SYNTHETIC_LICENCE',
                  validUntil: new Date(Date.now() + 365 * 86400000).toISOString(),
                },
              ],
            )
          ).rows[0]?.id,
        ),
      ),
    );
  const quote = await withRole('specialist_role', scope, async c =>
      String(
        (
          await c.query(
            "select public.append_evidence($1,'compliance','professional_quote','claimed',$2,'message','Synthetic returned quote from fixture professional')id",
            [
              scope.missionId,
              {
                professionalId: professional,
                briefVersionId: brief.version,
                amountMinor: 500,
                currency: 'SAR',
                deliverableIds: ['report'],
                validUntil: new Date(Date.now() + 86400000).toISOString(),
              },
            ],
          )
        ).rows[0]?.id,
      ),
    ),
    terms = {
      professionalId: professional,
      briefVersionId: brief.version,
      quoteEvidenceId: quote,
      verificationEvidenceIds: signals,
      amountMinor: 500,
      currency: 'SAR',
      dueAt: new Date(Date.now() + 2 * 86400000).toISOString(),
      service: 'Document review',
      regulated: true,
      language,
      deliverables: [{ id: 'report', title: 'Returned professional report', requiredFields: ['reference', 'issuer'] }],
    },
    version = await prepareProfessionalEngagement(scope, terms);
  await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'resend','connected','{send}')", [
    account,
    founder,
  ]);
  await provisionProviderCredential(scope, {
    accountId: account,
    provider: 'resend',
    sandboxMode: true,
    credential: {
      apiKey: 'explicit-synthetic-professional-key',
      from: 'operator@test.example',
      testDomain: 'test.example',
      allowedSandboxRecipients: ['professional@test.example'],
    },
  });
  const expiresAt = new Date(Date.now() + 86400000).toISOString(),
    coverage = {
      actions: ['send_message'],
      effectClasses: ['communicate'],
      counterpartyIds: [professional],
      channels: ['email'],
      purposes: ['follow_up'],
      instrumentIds: [account],
      maxNewContacts: 1,
    },
    mandateSource = await proposed(scope, 'mandate', {
      mandate: { type: 'outreach', scope: coverage, ceilingPer: 0, ceilingTotal: 0, currency: 'SAR', expiresAt },
    }),
    mandateDecision = await approve(scope, mandateSource.version, 'mandate', 'outreach'),
    mandate = await withRole('founder_role', scope, async c =>
      String(
        (
          await c.query("select public.grant_mandate($1,$2,'outreach',$3,0,0,$4)id", [
            scope.missionId,
            mandateDecision,
            coverage,
            expiresAt,
          ])
        ).rows[0]?.id,
      ),
    );
  return { scope, professional, account, brief, quote, signals, terms, version, mandate };
}
async function engaged(f: Awaited<ReturnType<typeof fixture>>) {
  const decision = await approve(f.scope, f.version, 'engagement', 'professional_engagement', { amountMinor: 500, currency: 'SAR' }),
    request = { decisionId: decision, artifactVersionId: f.version, mandateId: f.mandate, idempotencyKey: randomUUID() },
    id = await createProfessionalEngagement(f.scope, request);
  return { id, decision, request };
}
const sendFixture =
  (requests: string[]): Transport =>
  async request => {
    expect(request.url).toBe('https://api.resend.com/emails');
    requests.push(String(request.body));
    return { status: 200, headers: {}, body: { id: `EXPLICIT_PROFESSIONAL_SEND_${randomUUID()}` } };
  };
async function returned(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  fields: Record<string, JsonValue> = { reference: 'SYNTHETIC_REPORT', issuer: 'Synthetic qualified professional' },
) {
  const source = await withRole('specialist_role', f.scope, async c =>
      String(
        (
          await c.query(
            "select public.append_evidence($1,'compliance','professional_returned_document','claimed',$2,'document','Explicit synthetic returned document')id",
            [f.scope.missionId, { professionalId: f.professional, synthetic: true }],
          )
        ).rows[0]?.id,
      ),
    ),
    document = await proposed(f.scope, 'professional_document', {
      professionalDocument: {
        professionalId: f.professional,
        briefVersionId: f.brief.version,
        deliverableId: 'report',
        sourceEvidenceId: source,
        fields,
      },
    });
  return {
    source,
    document,
    receive: () =>
      receiveProfessionalDeliverable(f.scope, {
        engagementId: id,
        deliverableId: 'report',
        documentVersionId: document.version,
        sourceEvidenceId: source,
      }),
  };
}
async function issue(scope: ActorScope, version: string, decision: string, party: string, action: string, amountMinor: number) {
  const token = randomBytes(32).toString('hex'),
    approval = await withRole('founder_role', scope, async c => {
      const result = await new PostgresMissionRepository(c).issueApproval(
        z.uuid().parse(scope.missionId),
        decision,
        { action, counterpartyId: party, amountMinor, currency: 'SAR', artifactVersionId: version },
        token,
        new Date(Date.now() + 3600000).toISOString(),
      );
      if (!result.ok) throw new Error('Synthetic payment approval rejected');
      return result.value;
    });
  await storeApprovalToken(scope, approval, token);
}
function paypalFixture(): Transport {
  const orders = new Map<string, { unit: Record<string, unknown>; captured: boolean }>();
  let capture = 0;
  return async request => {
    if (request.url.endsWith('/oauth2/token'))
      return { status: 200, headers: {}, body: { access_token: 'explicit-synthetic-professional-token' } };
    if (request.url.endsWith('/v2/checkout/orders') && request.method === 'POST') {
      const unit = z
        .object({ purchase_units: z.array(z.record(z.string(), z.unknown())).length(1) })
        .passthrough()
        .parse(JSON.parse(String(request.body))).purchase_units[0];
      if (!unit) throw new Error('Expected synthetic purchase unit');
      const id = `ORDER_${randomUUID()}`;
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
    if (request.url.includes('/v2/payments/captures/') && request.url.endsWith('/refund'))
      return {
        status: 201,
        headers: {},
        body: { id: 'SYNTHETIC_PROFESSIONAL_REFUND', status: 'PENDING', amount: { value: '5.00', currency_code: 'SAR' } },
      };
    if (request.url.endsWith('/v2/payments/refunds/SYNTHETIC_PROFESSIONAL_REFUND'))
      return {
        status: 200,
        headers: {},
        body: {
          id: 'SYNTHETIC_PROFESSIONAL_REFUND',
          status: 'COMPLETED',
          amount: { value: '5.00', currency_code: 'SAR' },
          links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE_1' }],
        },
      };
    const match = request.url.match(/\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/),
      id = match?.[1];
    if (!id) throw new Error('Unexpected synthetic endpoint');
    const order = orders.get(id);
    if (!order) throw new Error('Unknown synthetic order');
    if (match[2]) {
      order.captured = true;
      capture++;
      order.unit['syntheticCaptureId'] = `CAPTURE_${capture}`;
    }
    return {
      status: 200,
      headers: {},
      body: {
        id,
        intent: 'CAPTURE',
        status: order.captured ? 'COMPLETED' : 'APPROVED',
        purchase_units: [
          {
            ...order.unit,
            ...(order.captured
              ? { payments: { captures: [{ id: order.unit['syntheticCaptureId'], status: 'COMPLETED', amount: order.unit['amount'] }] } }
              : {}),
          },
        ],
      },
    };
  };
}
describe('AT-FR-SPC01..05 / BRD06 / CPL02..03 professional lifecycle', () => {
  it('records an approved Arabic briefing original with its English structured-content translation', async () => {
    const f = await fixture('do', 'ar'),
      e = await engaged(f),
      requests: string[] = [];
    expect(await reconcileProfessionalEngagements(f.scope, sendFixture(requests))).toMatchObject({ sent: 1, held: 0 });
    expect(requests).toHaveLength(1);
    const message = (
      await db.query("select original,translation from public.messages where mission_id=$1 and direction='outbound'", [f.scope.missionId])
    ).rows[0];
    expect(message?.original).toContain('أنا مساعد يعمل بالذكاء الاصطناعي');
    expect(message?.translation).toContain('I am an AI-assisted agent');
    expect(message?.original).toContain(f.brief.version);
    expect(message?.translation).toContain(f.brief.version);
    expect((await readProfessionalEngagement(f.scope, e.id)).started).toBe(true);
  });
  it('does not allow a typed professional brief to bypass Engagement cost approval using an unrelated task', async () => {
    const f = await fixture();
    await approve(f.scope, f.version, 'selection', 'professional_source_only');
    const intent = {
        missionId: f.scope.missionId,
        taskId: randomUUID(),
        action: 'send_message',
        effectClass: 'communicate',
        counterpartyId: f.professional,
        artifactVersionId: f.version,
        instrumentId: f.account,
        mandateId: f.mandate,
        channel: 'email',
        purpose: 'follow_up',
        mode: 'do',
        sandboxMode: true,
        idempotencyKey: randomUUID(),
      },
      authorization = await withRole(
        'policy_role',
        f.scope,
        async c =>
          (await c.query('select public.reserve_effect($1,$2,null)result', [f.scope.missionId, intent])).rows[0]?.result as {
            authorizationId: string;
          },
      );
    await expect(
      withRole('policy_role', f.scope, c =>
        c.query('select public.begin_effect($1,$2)', [f.scope.missionId, authorization.authorizationId]),
      ),
    ).rejects.toThrow(/registered approved engagement task/);
    expect(
      (await db.query('select count(*)::int n from public.professional_starts where mission_id=$1', [f.scope.missionId])).rows[0]?.n,
    ).toBe(0);
  });
  it('rechecks professional verification in both reserved and started dispatch claims after a source correction', async () => {
    const f = await fixture(),
      e = await engaged(f),
      next = await withRole(
        'lead_role',
        f.scope,
        async c =>
          (await c.query('select public.next_professional_engagement($1,$2)result', [f.scope.missionId, e.id])).rows[0]?.result as {
            taskId: string;
          },
      ),
      intent = {
        missionId: f.scope.missionId,
        taskId: next.taskId,
        action: 'send_message',
        effectClass: 'communicate',
        counterpartyId: f.professional,
        artifactVersionId: f.version,
        instrumentId: f.account,
        mandateId: f.mandate,
        channel: 'email',
        purpose: 'follow_up',
        mode: 'do',
        sandboxMode: true,
        idempotencyKey: randomUUID(),
      },
      authorization = await withRole(
        'policy_role',
        f.scope,
        async c =>
          (await c.query('select public.reserve_effect($1,$2,null)result', [f.scope.missionId, intent])).rows[0]?.result as {
            authorizationId: string;
          },
      );
    await withRole('policy_role', f.scope, c =>
      c.query('select public.begin_effect($1,$2)', [f.scope.missionId, authorization.authorizationId]),
    );
    const signal = f.signals[0];
    if (!signal) throw new Error('Expected exact verification source');
    await withRole('specialist_role', f.scope, c =>
      c.query(
        "select public.append_evidence($1,'compliance','professional_signal','claimed',$2,'document','Synthetic verification corrected between durable claim and invocation',null,$3)",
        [f.scope.missionId, { professionalId: f.professional, signalKind: 'registry', correction: true }, signal],
      ),
    );
    await expect(
      withRole('policy_role', f.scope, c =>
        c.query('select public.begin_effect($1,$2)', [f.scope.missionId, authorization.authorizationId]),
      ),
    ).rejects.toThrow(/approval|verification/);
    expect(
      (await db.query('select count(*)::int n from public.provider_receipts where mission_id=$1', [f.scope.missionId])).rows[0]?.n,
    ).toBe(0);
  });
  it('recovers a Guide-approved exact draft into one started engagement without resending', async () => {
    const f = await fixture('guide'),
      e = await engaged(f),
      requests: string[] = [];
    expect(await reconcileProfessionalEngagements(f.scope, sendFixture(requests))).toMatchObject({ sent: 0, held: 1 });
    const version = z
        .uuid()
        .parse(
          (
            await db.query(
              "select v.id from public.artifact_versions v join public.professional_engagements e on e.task_id::text=v.content->>'originatingTaskId'where e.id=$1 order by v.created_at desc limit 1",
              [e.id],
            )
          ).rows[0]?.id,
        ),
      decision = await approve(f.scope, version, 'engagement', 'professional_brief_send'),
      token = randomBytes(32).toString('hex'),
      approval = await withRole('founder_role', f.scope, async c => {
        const result = await new PostgresMissionRepository(c).issueApproval(
          z.uuid().parse(f.scope.missionId),
          decision,
          { action: 'send_message', counterpartyId: f.professional, amountMinor: null, currency: null, artifactVersionId: version },
          token,
          new Date(Date.now() + 3600000).toISOString(),
        );
        if (!result.ok) throw new Error('Synthetic Guide approval denied');
        return result.value;
      });
    await storeApprovalToken(f.scope, approval, token);
    expect((await executeApprovedProviderEffect(f.scope, version, randomUUID(), sendFixture(requests))).ok).toBe(true);
    await reconcileProfessionalEngagements(f.scope, sendFixture(requests));
    expect(requests).toHaveLength(1);
    expect((await readProfessionalEngagement(f.scope, e.id)).started).toBe(true);
    expect((await db.query('select count(*)::int n from public.professional_starts where engagement_id=$1', [e.id])).rows[0]?.n).toBe(1);
  });
  it('rejects expired quotes/qualifications, duplicate engagements for one quote, and verification changes before dispatch', async () => {
    const f = await fixture(),
      e = await engaged(f);
    const repeat = await prepareProfessionalEngagement(f.scope, f.terms),
      repeatDecision = await approve(f.scope, repeat, 'engagement', 'professional_engagement', { amountMinor: 500, currency: 'SAR' });
    await expect(
      createProfessionalEngagement(f.scope, { decisionId: repeatDecision, artifactVersionId: repeat, idempotencyKey: randomUUID() }),
    ).rejects.toThrow(/unique constraint/);
    const expiredQuote = await withRole('specialist_role', f.scope, async c =>
      String(
        (
          await c.query(
            "select public.append_evidence($1,'compliance','professional_quote','claimed',$2,'message','Synthetic expired quote')id",
            [
              f.scope.missionId,
              {
                professionalId: f.professional,
                briefVersionId: f.brief.version,
                amountMinor: 500,
                currency: 'SAR',
                deliverableIds: ['report'],
                validUntil: new Date(Date.now() - 86400000).toISOString(),
              },
            ],
          )
        ).rows[0]?.id,
      ),
    );
    await expect(prepareProfessionalEngagement(f.scope, { ...f.terms, quoteEvidenceId: expiredQuote })).rejects.toThrow(/unexpired/);
    const registry = f.signals[0];
    if (!registry) throw new Error('Expected synthetic registry signal');
    const expiredQualification = await withRole('founder_role', f.scope, async c =>
      String(
        (
          await c.query(
            "select public.append_evidence($1,'compliance','professional_signal','founder_confirmed',$2,'document','Explicit expired synthetic qualification')id",
            [
              f.scope.missionId,
              {
                professionalId: f.professional,
                signalKind: 'qualification',
                independentSource: 'expired-licence.example',
                licenceReference: 'EXPIRED_SYNTHETIC',
                validUntil: new Date(Date.now() - 86400000).toISOString(),
              },
            ],
          )
        ).rows[0]?.id,
      ),
    );
    await expect(
      prepareProfessionalEngagement(f.scope, { ...f.terms, verificationEvidenceIds: [registry, expiredQualification] }),
    ).rejects.toThrow(/verified professional/);
    await withRole('specialist_role', f.scope, c =>
      c.query(
        "select public.append_evidence($1,'compliance','professional_signal','claimed',$2,'document','Corrected registry source',null,$3)",
        [f.scope.missionId, { professionalId: f.professional, signalKind: 'registry', correction: true }, registry],
      ),
    );
    const requests: string[] = [];
    expect(await reconcileProfessionalEngagements(f.scope, sendFixture(requests))).toMatchObject({ sent: 0, held: 1 });
    expect(requests).toHaveLength(0);
    expect((await readProfessionalEngagement(f.scope, e.id)).current).toBe(false);
  });
  it('links confirmed payments, enforces cumulative quoted cost, and only releases it after an actual verified refund', async () => {
    const f = await fixture(),
      e = await engaged(f),
      account = randomUUID();
    await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'paypal','connected','{pay}')", [
      account,
      founder,
    ]);
    await provisionProviderCredential(f.scope, {
      accountId: account,
      provider: 'paypal',
      sandboxMode: true,
      credential: {
        clientId: 'explicit-synthetic-professional-client',
        clientSecret: 'explicit-synthetic-professional-secret',
        merchantId: 'OWNMERCHANT',
        webhookId: 'SYNTHETIC_WEBHOOK',
        verifiedPayees: { [f.professional]: 'PROFESSIONALMERCHANT' },
      },
    });
    const transport = paypalFixture();
    const paymentSource = async (amountMinor: number, sidecar = true) => {
      const source = await proposed(f.scope, 'payment', {
          ...(sidecar
            ? { professionalPayment: { engagementId: e.id, artifactVersionId: f.version, briefVersionId: f.brief.version } }
            : {}),
          effectIntent: {
            action: 'payment_capture',
            effectClass: 'spend',
            counterpartyId: f.professional,
            instrumentId: account,
            amountMinor,
            currency: 'SAR',
            purpose: 'Professional work',
          },
          payload: {
            artifactVersionId: randomUUID(),
            artifactStatus: 'approved',
            counterpartyId: f.professional,
            payeeMerchantId: 'PROFESSIONALMERCHANT',
            amountMinor,
            currency: 'SAR',
            purpose: 'Professional work',
            returnUrl: `http://127.0.0.1:3000/api/payments/return?mission=${f.scope.missionId}`,
            cancelUrl: 'http://127.0.0.1:3000/',
            intent: 'CAPTURE',
          },
        }),
        decision = await approve(f.scope, source.version, 'engagement', 'professional_payment', { amountMinor, currency: 'SAR' });
      await issue(f.scope, source.version, decision, f.professional, 'payment_capture', amountMinor);
      return source;
    };
    const unbound = await paymentSource(100, false);
    await expect(db.query('select private.check_version($1,$2)', [f.scope.missionId, unbound.version])).rejects.toThrow(
      /exact approved professional engagement/,
    );
    const source = await paymentSource(500),
      prepared = z
        .object({ ok: z.literal(true), value: z.object({ orderId: z.string() }).passthrough() })
        .passthrough()
        .parse(await prepareApprovedPayPalOrder(f.scope, source.version, randomUUID(), transport)),
      captured = z
        .object({ ok: z.literal(true), value: z.object({ paymentId: z.uuid() }).passthrough() })
        .passthrough()
        .parse(await captureApprovedPayPalOrder(f.scope, prepared.value.orderId, transport));
    await registerProfessionalPayment(f.scope, { engagementId: e.id, paymentId: captured.value.paymentId });
    expect(await readProfessionalEngagement(f.scope, e.id)).toMatchObject({ paidMinor: '500', refundedMinor: '0' });
    const extra = await paymentSource(100),
      extraOrder = z
        .object({ ok: z.literal(true), value: z.object({ orderId: z.string() }).passthrough() })
        .passthrough()
        .parse(await prepareApprovedPayPalOrder(f.scope, extra.version, randomUUID(), transport));
    expect((await captureApprovedPayPalOrder(f.scope, extraOrder.value.orderId, transport)).ok).toBe(false);
    const refund = await proposed(f.scope, 'payment_refund', {
        effectIntent: {
          action: 'payment_refund',
          effectClass: 'spend',
          counterpartyId: f.professional,
          instrumentId: account,
          amountMinor: 500,
          currency: 'SAR',
        },
        payload: {
          orderId: prepared.value.orderId,
          captureId: 'CAPTURE_1',
          artifactVersionId: source.version,
          payeeMerchantId: 'PROFESSIONALMERCHANT',
          amountMinor: 500,
          currency: 'SAR',
          sandboxMode: true,
        },
      }),
      refundDecision = await approve(f.scope, refund.version, 'engagement', 'professional_refund', { amountMinor: 500, currency: 'SAR' });
    await issue(f.scope, refund.version, refundDecision, f.professional, 'payment_refund', 500);
    expect(await executeApprovedProviderEffect(f.scope, refund.version, randomUUID(), transport)).toMatchObject({
      ok: true,
      value: { status: 'refunded_verified' },
    });
    expect(await readProfessionalEngagement(f.scope, e.id)).toMatchObject({ paidMinor: '500', refundedMinor: '500' });
    const replacement = await paymentSource(500),
      replacementOrder = z
        .object({ ok: z.literal(true), value: z.object({ orderId: z.string() }).passthrough() })
        .passthrough()
        .parse(await prepareApprovedPayPalOrder(f.scope, replacement.version, randomUUID(), transport));
    expect((await captureApprovedPayPalOrder(f.scope, replacementOrder.value.orderId, transport)).ok).toBe(true);
  });
  it('requires current selected Engagement with exact cost, then records one real brief receipt across concurrent retry', async () => {
    const f = await fixture();
    await expect(
      createProfessionalEngagement(f.scope, {
        decisionId: randomUUID(),
        artifactVersionId: f.version,
        mandateId: f.mandate,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/approval/);
    const wrong = await approve(f.scope, f.version, 'engagement', 'professional_engagement', { amountMinor: 1, currency: 'SAR' });
    await expect(
      createProfessionalEngagement(f.scope, { decisionId: wrong, artifactVersionId: f.version, idempotencyKey: randomUUID() }),
    ).rejects.toThrow(/exact professional cost/);
    const e = await engaged(f);
    expect(await createProfessionalEngagement(f.scope, e.request)).toBe(e.id);
    await expect(createProfessionalEngagement(f.scope, { ...e.request, mandateId: randomUUID() })).rejects.toThrow(/idempotency/);
    const requests: string[] = [];
    await Promise.all([
      reconcileProfessionalEngagements(f.scope, sendFixture(requests)),
      reconcileProfessionalEngagements(f.scope, sendFixture(requests)),
    ]);
    expect(requests).toHaveLength(1);
    expect(await readProfessionalEngagement(f.scope, e.id)).toMatchObject({ current: true, started: true, paidMinor: '0' });
    await reconcileProfessionalEngagements(f.scope, sendFixture(requests));
    expect(requests).toHaveLength(1);
  });
  it('holds Guide and provider uncertainty without recording fictitious professional work', async () => {
    for (const mode of ['guide', 'do'] as const) {
      const f = await fixture(mode),
        e = await engaged(f);
      let calls = 0;
      const transport: Transport = async () => {
        calls++;
        throw new Error('Explicit synthetic timeout');
      };
      await reconcileProfessionalEngagements(f.scope, transport);
      await reconcileProfessionalEngagements(f.scope, transport);
      expect(calls).toBe(mode === 'guide' ? 0 : 1);
      expect((await readProfessionalEngagement(f.scope, e.id)).started).toBe(false);
    }
  });
  it('records returned documents as claimed; founder confirmation needs required fields and current actual source, never agent certification', async () => {
    const f = await fixture(),
      e = await engaged(f);
    await reconcileProfessionalEngagements(f.scope, sendFixture([]));
    const missing = await returned(f, e.id, { reference: 'ONLY_ONE_FIELD' });
    await expect(missing.receive()).rejects.toThrow(/missing required field issuer/);
    const delivery = await returned(f, e.id),
      deliveryId = await delivery.receive();
    expect(await delivery.receive()).toBe(deliveryId);
    const snapshot = await readProfessionalEngagement(f.scope, e.id);
    expect(snapshot.deliveries[0]).toMatchObject({ confirmed: false });
    expect(
      (await db.query('select trust from public.evidence where id=$1', [snapshot.deliveries[0]?.claimedEvidenceId])).rows[0]?.trust,
    ).toBe('claimed');
    const confirmation = await proposed(f.scope, 'founder_confirmation', {
        founderConfirmation: {
          outcome: 'compliance',
          kind: 'professional_deliverable_confirmation',
          statement:
            'I received this explicit synthetic professional report and checked its required fields. This is not agent certification.',
          payload: { engagementId: e.id, deliveryId, sourceEvidenceIds: [delivery.source] },
        },
      }),
      decision = await approve(f.scope, confirmation.version, 'engagement', 'professional_deliverable_confirmation');
    await expect(
      withRole('specialist_role', f.scope, c =>
        c.query('select public.confirm_professional_deliverable($1,$2,$3)', [f.scope.missionId, decision, confirmation.version]),
      ),
    ).rejects.toThrow(/permission denied/);
    const fact = await confirmProfessionalDeliverable(f.scope, decision, confirmation.version);
    expect(await confirmProfessionalDeliverable(f.scope, decision, confirmation.version)).toBe(fact);
    expect((await db.query('select trust,payload from public.evidence where id=$1', [fact])).rows[0]).toMatchObject({
      trust: 'founder_confirmed',
      payload: { agentCertified: false, requiredFieldsChecked: true },
    });
    expect((await readProfessionalEngagement(f.scope, e.id)).deliveries[0]?.confirmed).toBe(true);
    await withRole('specialist_role', f.scope, c =>
      c.query(
        "select public.append_evidence($1,'compliance','professional_returned_document','claimed',$2,'document','Corrected synthetic source',null,$3)",
        [f.scope.missionId, { professionalId: f.professional, correction: true }, delivery.source],
      ),
    );
    expect((await readProfessionalEngagement(f.scope, e.id)).deliveries[0]?.confirmed).toBe(false);
    await expect(confirmProfessionalDeliverable(f.scope, decision, confirmation.version)).rejects.toThrow(/current|source|approval/);
  });
  it('blocks changed verification/brief at dispatch and keeps tenant and append-only boundaries', async () => {
    const f = await fixture(),
      e = await engaged(f);
    await withRole('specialist_role', f.scope, c =>
      c.query('select public.append_artifact_version($1,$2,$3)', [
        f.scope.missionId,
        f.brief.artifact,
        { objective: 'Changed synthetic brief' },
      ]),
    );
    const requests: string[] = [];
    expect(await reconcileProfessionalEngagements(f.scope, sendFixture(requests))).toMatchObject({ sent: 0, held: 1 });
    expect(requests).toHaveLength(0);
    expect((await readProfessionalEngagement(f.scope, e.id)).current).toBe(false);
    await expect(
      db.query('update public.professional_engagements set email=$1 where id=$2', ['forged@example.test', e.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      withRole('lead_role', f.scope, c => c.query('select private.professional_source($1,$2)', [f.scope.missionId, f.version])),
    ).rejects.toThrow(/permission denied/);
    await expect(readProfessionalEngagement({ authUserId: randomUUID(), missionId: f.scope.missionId }, e.id)).rejects.toThrow();
  });
});
