import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { PostgresMissionRepository, type JsonValue } from '@lo/state';
import { ShopifyAdapter, type Transport, type HttpRequest } from '@lo/adapters';
import { withRole, closeDatabasePools } from './database.js';
import { ProviderStorage, provisionProviderCredential, storeApprovalToken } from './provider-storage.js';
import { TaskBriefSchema } from './contracts.js';
import {
  prepareApprovedPayPalOrder,
  captureApprovedPayPalOrder,
  executeApprovedProviderEffect,
  reconcileProviderPayments,
  processVoiceWrittenConfirmation,
} from './provider-tools.js';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_settlement_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl });
let db: Client;
const prior = { ...process.env },
  user = '00000000-0000-4000-8000-000000000001',
  founder = '10000000-0000-4000-8000-000000000001',
  party = randomUUID(),
  account = randomUUID();
let scope: { authUserId: string; missionId: string }, invoice: string, paymentId: string;
let authorized = false,
  captured = false,
  refunds = 0,
  captureTimeout = false,
  refundTimeout = false;
const requests: HttpRequest[] = [];
function providerOrder(status: string) {
  return {
    id: 'TEST_AUTH_ORDER',
    status,
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        reference_id: invoice,
        amount: { value: '10.00', currency_code: 'SAR' },
        payee: { merchant_id: 'PAYEEMERCHANT' },
        payments: {
          refunds: Array.from({ length: refunds }, (_, n) => ({
            id: `TEST_REFUND_${n + 1}`,
            status: 'COMPLETED',
            amount: { value: '5.00', currency_code: 'SAR' },
          })),
          authorizations: authorized
            ? [
                {
                  id: 'TEST_AUTH',
                  status: captured ? 'CAPTURED' : 'CREATED',
                  expiration_time: new Date(Date.now() + 86400000).toISOString(),
                },
              ]
            : [],
          captures: captured
            ? [
                {
                  id: 'TEST_CAPTURE',
                  status: refunds ? 'PARTIALLY_REFUNDED' : 'COMPLETED',
                  amount: { value: '10.00', currency_code: 'SAR' },
                },
              ]
            : [],
        },
      },
    ],
    links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=TEST_AUTH_ORDER' }],
  };
}
const transport: Transport = async request => {
  requests.push(request);
  if (request.url.endsWith('/oauth2/token')) return { status: 200, headers: {}, body: { access_token: 'explicit-test-only' } };
  if (request.url.endsWith('/v2/checkout/orders') && request.method === 'POST')
    return { status: 201, headers: {}, body: providerOrder('CREATED') };
  if (request.url.endsWith('/TEST_AUTH_ORDER/authorize')) {
    authorized = true;
    return { status: 201, headers: {}, body: providerOrder('COMPLETED') };
  }
  if (request.url.endsWith('/authorizations/TEST_AUTH/capture')) {
    captured = true;
    if (captureTimeout) {
      captureTimeout = false;
      throw new Error('Explicit test timeout after provider capture');
    }
    return {
      status: 201,
      headers: {},
      body: { id: 'TEST_CAPTURE', status: 'COMPLETED', amount: { value: '10.00', currency_code: 'SAR' } },
    };
  }
  if (request.url.endsWith('/captures/TEST_CAPTURE/refund')) {
    refunds++;
    if (refundTimeout) {
      refundTimeout = false;
      throw new Error('Explicit test timeout after provider refund');
    }
    return {
      status: 201,
      headers: {},
      body: { id: `TEST_REFUND_${refunds}`, status: 'PENDING', amount: { value: '5.00', currency_code: 'SAR' } },
    };
  }
  if (request.url.includes('/v2/payments/refunds/TEST_REFUND_'))
    return {
      status: 200,
      headers: {},
      body: {
        id: request.url.split('/').at(-1),
        status: 'COMPLETED',
        amount: { value: '5.00', currency_code: 'SAR' },
        links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/TEST_CAPTURE' }],
      },
    };
  return { status: 200, headers: {}, body: providerOrder(authorized ? 'COMPLETED' : 'APPROVED') };
};
const packet = {
  question: 'Approve exact provider effect?',
  options: [{ id: 'a', label: 'Approve', evidenceIds: [], cost: null, timeDays: 0, consequences: 'Explicit synthetic sandbox test only' }],
  recommendation: { optionId: 'a', reasons: ['Exact source reviewed'] },
  staleImpact: [],
  defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
};
async function approve(
  action: string,
  effectClass: 'spend' | 'bind' | 'publish' | 'communicate',
  amountMinor: number | undefined,
  payload: Record<string, JsonValue>,
  targetParty = party,
  instrument = account,
  sidecar: Record<string, JsonValue> = {},
) {
  const effectIntent = {
    action,
    effectClass,
    counterpartyId: targetParty,
    instrumentId: instrument,
    purpose: 'samples',
    ...(amountMinor === undefined ? {} : { amountMinor, currency: 'SAR' }),
  };
  const version = await withRole('specialist_role', scope, async c => {
    const a = (
        await c.query("select public.create_artifact($1,'payment_proposal','supply','Synthetic settlement fixture')id", [scope.missionId])
      ).rows[0]?.id,
      v = String(
        (await c.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, a, { effectIntent, payload, ...sidecar }]))
          .rows[0]?.id,
      );
    await c.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, v]);
    return v;
  });
  const decision = await withRole('lead_role', scope, async c =>
      String(
        (
          await c.query("select public.propose_decision($1,'engagement',$2,'supply','payment')id", [
            scope.missionId,
            { ...packet, approvedVersionIds: [version] },
          ])
        ).rows[0]?.id,
      ),
    ),
    token = randomBytes(32).toString('hex');
  const approval = await withRole('founder_role', scope, async c => {
    const repo = new PostgresMissionRepository(c);
    const decisionResult = await repo.resolveDecision(scope.missionId, decision, 'approve', 'a');
    if (!decisionResult.ok) throw new Error('Fixture approval failed');
    await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, version, decision]);
    const r = await repo.issueApproval(
      scope.missionId,
      decision,
      {
        action,
        counterpartyId: targetParty,
        amountMinor: amountMinor ?? null,
        currency: amountMinor === undefined ? null : 'SAR',
        artifactVersionId: version,
      },
      token,
      new Date(Date.now() + 60000).toISOString(),
    );
    if (!r.ok) throw new Error('Fixture token failed');
    return r.value;
  });
  await storeApprovalToken(scope, approval, token);
  return version;
}
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${name}`);
  const local = new URL(adminUrl);
  local.pathname = `/${name}`;
  db = new Client({ connectionString: local.href });
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
  await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
  await db.query('update private.platform_controls set effects_enabled=true');
  process.env['DATABASE_URL'] = local.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
  process.env['PROVIDER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  const missionId = await withRole('founder_role', { authUserId: user }, async c => {
    const r = await new PostgresMissionRepository(c).createMission(founder, 'launch', 'Explicit settlement test only', 'SAR', true, {
      budgetMinor: 1000,
    });
    if (!r.ok) throw new Error('Fixture mission failed');
    return r.value;
  });
  scope = { authUserId: user, missionId };
  await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'supplier','Synthetic settlement payee')", [
    party,
    founder,
  ]);
  await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'paypal','connected','{pay}')", [
    account,
    founder,
  ]);
  await provisionProviderCredential(scope, {
    accountId: account,
    provider: 'paypal',
    sandboxMode: true,
    credential: {
      clientId: 'explicit-test-client',
      clientSecret: 'explicit-test-secret',
      merchantId: 'OWNMERCHANT',
      webhookId: 'TEST_WH',
      verifiedPayees: { [party]: 'PAYEEMERCHANT' },
    },
  });
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name}with(force)`);
  await admin.end();
});
describe('actual guarded adapter + native authorization settlement/refund lifecycle', () => {
  it('AUTHORIZE holds the approved budget and creates no spent fact', async () => {
    invoice = await approve('payment_capture', 'spend', 1000, {
      payeeMerchantId: 'PAYEEMERCHANT',
      amountMinor: 1000,
      currency: 'SAR',
      purpose: 'samples',
      returnUrl: `http://127.0.0.1:3000/api/payments/return?mission=${scope.missionId}`,
      cancelUrl: 'http://127.0.0.1:3000/',
      intent: 'AUTHORIZE',
    });
    const prepared = await prepareApprovedPayPalOrder(scope, invoice, randomUUID(), transport);
    expect(prepared.ok).toBe(true);
    const result = await captureApprovedPayPalOrder(scope, 'TEST_AUTH_ORDER', transport);
    expect(result).toMatchObject({ ok: true, value: { status: 'authorized', spent: false } });
    paymentId = String((await db.query('select id from public.payments where mission_id=$1', [scope.missionId])).rows[0]?.id);
    expect(
      (await db.query("select count(*)::int n from public.money_ledger where mission_id=$1 and kind='spent'", [scope.missionId])).rows[0]
        ?.n,
    ).toBe(0);
    expect((await db.query('select private.mission_exposure($1)amount', [scope.missionId])).rows[0]?.amount).toBe('1000');
  });
  it('a later specifically approved capture settles the original payment once without double budget exposure', async () => {
    const version = await approve('payment_authorization_capture', 'spend', 1000, {
      orderId: 'TEST_AUTH_ORDER',
      authorizationId: 'TEST_AUTH',
      artifactVersionId: invoice,
      payeeMerchantId: 'PAYEEMERCHANT',
      amountMinor: 1000,
      currency: 'SAR',
      sandboxMode: true,
    });
    const task = randomUUID();
    captureTimeout = true;
    const result = await executeApprovedProviderEffect(scope, version, task, transport);
    expect(result.ok).toBe(false);
    expect(
      (await db.query("select count(*)::int n from public.money_ledger where mission_id=$1 and kind='spent'", [scope.missionId])).rows[0]
        ?.n,
    ).toBe(0);
    expect(
      (
        await db.query(
          'select cs.status from public.authorization_obligations o join public.payment_authorizations pa on pa.id=o.payment_authorization_id join public.commitment_states cs on cs.commitment_id=o.commitment_id where pa.payment_id=$1 order by cs.created_at desc,cs.id desc limit 1',
          [paymentId],
        )
      ).rows[0]?.status,
    ).toBe('open');
    await reconcileProviderPayments(scope, transport);
    await executeApprovedProviderEffect(scope, version, task, transport);
    const spent = (
      await db.query("select amount_minor,currency,ref_id from public.money_ledger where mission_id=$1 and kind='spent'", [scope.missionId])
    ).rows;
    expect(spent).toEqual([{ amount_minor: '1000', currency: 'SAR', ref_id: paymentId }]);
    expect(requests.filter(r => r.url.endsWith('/authorizations/TEST_AUTH/capture'))).toHaveLength(1);
    expect(
      (
        await db.query(
          'select cs.status from public.authorization_obligations o join public.payment_authorizations pa on pa.id=o.payment_authorization_id join public.commitment_states cs on cs.commitment_id=o.commitment_id where pa.payment_id=$1 order by cs.created_at desc,cs.id desc limit 1',
          [paymentId],
        )
      ).rows[0]?.status,
    ).toBe('closed');
    expect((await db.query('select private.mission_exposure($1)amount', [scope.missionId])).rows[0]?.amount).toBe('1000');
  });
  it('a refund of another/untracked capture is rejected before any provider HTTP', async () => {
    const version = await approve('payment_refund', 'spend', 500, {
        orderId: 'OUTSIDE_ORDER',
        captureId: 'OUTSIDE_CAPTURE',
        artifactVersionId: invoice,
        payeeMerchantId: 'PAYEEMERCHANT',
        amountMinor: 1000,
        currency: 'SAR',
        sandboxMode: true,
      }),
      before = requests.length;
    expect((await executeApprovedProviderEffect(scope, version, randomUUID(), transport)).ok).toBe(false);
    expect(requests).toHaveLength(before);
  });
  it('an exhausted envelope does not prevent returning funds; confirmed refunds clear original exposure', async () => {
    for (let n = 0; n < 2; n++) {
      const version = await approve('payment_refund', 'spend', 500, {
        orderId: 'TEST_AUTH_ORDER',
        captureId: 'TEST_CAPTURE',
        artifactVersionId: invoice,
        payeeMerchantId: 'PAYEEMERCHANT',
        amountMinor: 1000,
        currency: 'SAR',
        sandboxMode: true,
      });
      if (n === 0) refundTimeout = true;
      const result = await executeApprovedProviderEffect(scope, version, randomUUID(), transport);
      if (n === 0) {
        expect(result.ok).toBe(false);
        await reconcileProviderPayments(scope, transport);
      } else expect(result).toMatchObject({ ok: true, value: { status: 'refunded_verified' } });
    }
    expect(
      (
        await db.query("select sum(amount_minor)::text amount from public.money_ledger where mission_id=$1 and kind='refund'", [
          scope.missionId,
        ])
      ).rows[0]?.amount,
    ).toBe('1000');
    expect((await db.query('select private.mission_exposure($1)amount', [scope.missionId])).rows[0]?.amount).toBe('0');
  });
  it('a Guide written-confirmation draft stays open; only its approved real email receipt fulfills the linked call obligation', async () => {
    const voiceParty = randomUUID(),
      run = randomUUID(),
      twilioAccount = randomUUID(),
      openaiAccount = randomUUID(),
      resendAccount = randomUUID(),
      storage = new ProviderStorage(scope),
      disclosure = 'I am an AI-assisted agent for the founder.';
    await db.query(
      "insert into public.counterparties(id,founder_id,kind,name,channels,verification)values($1,$2,'supplier','Synthetic voice confirmation contact',$3,'{}')",
      [voiceParty, founder, { email: 'voice-fixture@test.example', businessHourStart: 0, businessHourEnd: 24, disclosure }],
    );
    for (const [id, provider] of [
      [twilioAccount, 'twilio'],
      [openaiAccount, 'openai'],
      [resendAccount, 'resend'],
    ])
      await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,$3,'connected','{}')", [
        id,
        founder,
        provider,
      ]);
    const twilio = await provisionProviderCredential(scope, {
        accountId: twilioAccount,
        provider: 'twilio',
        sandboxMode: true,
        credential: {
          accountSid: `AC${'1'.repeat(32)}`,
          authToken: 'explicit-test',
          from: '+15555550000',
          allowedSandboxRecipients: [],
          voiceCallbackOrigin: 'https://voice.example',
        },
      }),
      openai = await provisionProviderCredential(scope, {
        accountId: openaiAccount,
        provider: 'openai',
        sandboxMode: true,
        credential: { apiKey: 'explicit-test', allowedModels: ['test-realtime'], maxOutputTokens: 16 },
      });
    await provisionProviderCredential(scope, {
      accountId: resendAccount,
      provider: 'resend',
      sandboxMode: true,
      credential: {
        apiKey: 'explicit-test',
        from: 'agent@test.example',
        testDomain: 'test.example',
        allowedSandboxRecipients: ['voice-fixture@test.example'],
      },
    });
    const task = TaskBriefSchema.parse({
      id: run,
      missionId: scope.missionId,
      role: 'sourcing',
      outcome: 'supply',
      objective: 'Explicit synthetic voice fixture',
      constraints: [],
      budgetAuthority: [],
      deadline: new Date(Date.now() + 60000).toISOString(),
      doneCriteria: ['Written confirmation'],
      evidenceRequired: ['receipt'],
      playbook: { id: 'fixture', version: 1, step: 'voice', source: 'https://example.test/fixture' },
      maxToolCalls: 1,
      maxTokens: 256,
      tier: 'small',
      requestedByFounder: false,
      overdueExposure: false,
      unblocks: [],
      parentRunId: null,
    });
    await db.query(
      "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier)values($1,$2,'sourcing',$3,'explicit-voice-fixture','small')",
      [run, scope.missionId, task],
    );
    const session = await withRole('policy_role', scope, async c =>
      String(
        (
          await c.query("select public.create_voice_session($1,$2,$3,null,$4,$5,'en',$6,null)id", [
            scope.missionId,
            run,
            voiceParty,
            twilio.ref,
            openai.ref,
            disclosure,
          ])
        ).rows[0]?.id,
      ),
    );
    await withRole('founder_role', scope, c => c.query("select public.configure_service_budget($1,'openai',100000)", [scope.missionId]));
    expect(await storage.reserve(scope.missionId, `voice:${session}`, 'openai', 100000)).toBe(true);
    await new ProviderStorage(scope, 'ingress_role').appendVoice(session, 'ended', 'ended', { testFixture: true, usedTokens: 0 });
    const thread = String(
      (await db.query('insert into public.threads(mission_id,counterparty_id)values($1,$2)returning id', [scope.missionId, voiceParty]))
        .rows[0]?.id,
    );
    await withRole('founder_role', scope, c =>
      c.query("insert into public.founder_preferences(mission_id,kind,value,actor_id)values($1,'help_mode',$2,$3)", [
        scope.missionId,
        { targetKind: 'thread', targetId: thread, mode: 'guide' },
        user,
      ]),
    );
    let emails = 0;
    const email: Transport = async request => {
      expect(request.url).toBe('https://api.resend.com/emails');
      emails++;
      return { status: 200, headers: {}, body: { id: 'EXPLICIT_VOICE_CONFIRM_EMAIL' } };
    };
    const draft = await processVoiceWrittenConfirmation(scope, session, email);
    expect(draft).toMatchObject({ ok: true, value: { ok: true, data: { status: 'draft', sent: false } } });
    expect(emails).toBe(0);
    const version = String(
        (await db.query('select artifact_version_id from public.voice_confirmation_drafts where session_id=$1', [session])).rows[0]
          ?.artifact_version_id,
      ),
      obligation = String(
        (await db.query('select commitment_id from public.voice_confirmation_obligations where session_id=$1', [session])).rows[0]
          ?.commitment_id,
      );
    expect(
      (
        await db.query('select status from public.commitment_states where commitment_id=$1 order by created_at desc,id desc limit 1', [
          obligation,
        ])
      ).rows[0]?.status,
    ).toBe('open');
    await expect(
      withRole('policy_role', scope, async c => {
        const unrelated = (
          await c.query("select public.append_evidence($1,'supply','arbitrary','claimed','{}','document','explicit-test')id", [
            scope.missionId,
          ])
        ).rows[0]?.id;
        await c.query('select public.close_commitment($1,$2,$3)', [scope.missionId, obligation, unrelated]);
      }),
    ).rejects.toThrow();
    const content = (await db.query('select content from public.artifact_versions where id=$1', [version])).rows[0]?.content as {
      effectIntent: { action: string; counterpartyId: string };
    };
    const decision = await withRole('lead_role', scope, async c =>
        String(
          (
            await c.query("select public.propose_decision($1,'engagement',$2,'supply','written_confirmation')id", [
              scope.missionId,
              { ...packet, approvedVersionIds: [version] },
            ])
          ).rows[0]?.id,
        ),
      ),
      token = randomBytes(32).toString('hex');
    const approval = await withRole('founder_role', scope, async c => {
      const repo = new PostgresMissionRepository(c);
      await repo.resolveDecision(scope.missionId, decision, 'approve', 'a');
      await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, version, decision]);
      const r = await repo.issueApproval(
        scope.missionId,
        decision,
        {
          action: content.effectIntent.action,
          counterpartyId: content.effectIntent.counterpartyId,
          amountMinor: null,
          currency: null,
          artifactVersionId: version,
        },
        token,
        new Date(Date.now() + 60000).toISOString(),
      );
      if (!r.ok) throw new Error('Fixture confirmation approval failed');
      return r.value;
    });
    await storeApprovalToken(scope, approval, token);
    const sent = await executeApprovedProviderEffect(scope, version, randomUUID(), email);
    expect(sent.ok).toBe(true);
    expect(emails).toBe(1);
    expect(
      (
        await db.query('select status from public.commitment_states where commitment_id=$1 order by created_at desc,id desc limit 1', [
          obligation,
        ])
      ).rows[0]?.status,
    ).toBe('closed');
    expect(
      (
        await db.query("select trust,kind from public.evidence where mission_id=$1 and payload->>'sessionId'=$2", [
          scope.missionId,
          session,
        ])
      ).rows,
    ).toEqual([{ trust: 'performed', kind: 'voice_written_confirmation' }]);
  });
  it('a real publication poll emits version-bound verified evidence; repeated approved resource updates retain separate receipts', async () => {
    const shop = randomUUID(),
      shopAccount = randomUUID(),
      productId = 'gid://shopify/Product/123',
      publicationId = 'gid://shopify/Publication/44';
    await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'service','Synthetic owned Shopify store')", [
      shop,
      founder,
    ]);
    await db.query(
      "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'shopify','connected','{publish}')",
      [shopAccount, founder],
    );
    await provisionProviderCredential(scope, {
      accountId: shopAccount,
      provider: 'shopify',
      sandboxMode: true,
      credential: {
        accessToken: 'explicit-test',
        shopDomain: 'fixture.myshopify.com',
        apiVersion: '2026-10',
        developmentStore: true,
        ownerFounderId: founder,
        counterpartyId: shop,
      },
    });
    const checklistVersionId = await withRole('specialist_role', scope, async c => {
      const a = (
        await c.query("select public.create_artifact($1,'compliance_checklist','compliance','Synthetic approved copy constraints')id", [
          scope.missionId,
        ])
      ).rows[0]?.id;
      const v = String(
        (
          await c.query('select public.append_artifact_version($1,$2,$3)id', [
            scope.missionId,
            a,
            { prohibitedClaims: ['cures disease'], reviewStatus: 'unverified' },
          ])
        ).rows[0]?.id,
      );
      await c.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, v]);
      return v;
    });
    const checklistDecision = await withRole('lead_role', scope, async c =>
      String(
        (
          await c.query("select public.propose_decision($1,'selection',$2,'compliance','copy_checklist')id", [
            scope.missionId,
            { ...packet, approvedVersionIds: [checklistVersionId] },
          ])
        ).rows[0]?.id,
      ),
    );
    await withRole('founder_role', scope, async c => {
      await c.query("select public.resolve_decision($1,$2,'approve','a')", [scope.missionId, checklistDecision]);
      await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, checklistVersionId, checklistDecision]);
    });
    const draft = {
        kind: 'product',
        title: 'Approved synthetic fragrance',
        descriptionHtml: '<p>Floral notes</p>',
        vendor: 'Founder',
        productType: 'Fragrance',
      },
      sourceVersionId = await approve('store_configure', 'communicate', undefined, draft, shop, shopAccount, {
        contentReview: { checklistVersionId },
      }),
      store = new ProviderStorage(scope),
      connection = await store.connection('shopify', shopAccount),
      sourceDraft = await store.artifact(sourceVersionId),
      draftIntent = await store.buildIntent(
        randomUUID(),
        'store_configure',
        'communicate',
        { counterpartyId: shop, instrumentId: shopAccount, artifactVersionId: sourceVersionId },
        [],
      );
    const configured = await new ShopifyAdapter({
      ...store.dependencies(),
      transport: async () => ({
        status: 200,
        headers: {},
        body: { data: { productCreate: { product: { id: productId, status: 'DRAFT' }, userErrors: [] } } },
      }),
    }).configure(draftIntent, connection.ref, sourceDraft.payload);
    expect(configured.ok).toBe(true);
    const contentReview = { checklistVersionId, sourceVersionId };
    let polls = 0;
    const shopTransport: Transport = async request => {
      const body = JSON.parse(request.body ?? '{}') as { query: string };
      if (body.query.includes('ReviewedProduct'))
        return {
          status: 200,
          headers: {},
          body: {
            data: {
              product: {
                id: productId,
                title: draft.title,
                descriptionHtml: draft.descriptionHtml,
                vendor: draft.vendor,
                productType: draft.productType,
              },
            },
          },
        };
      if (body.query.includes('mutation Activate'))
        return {
          status: 200,
          headers: {},
          body: { data: { productUpdate: { product: { id: productId, status: 'ACTIVE' }, userErrors: [] } } },
        };
      if (body.query.includes('mutation Publish'))
        return {
          status: 200,
          headers: {},
          body: { data: { publishablePublish: { publishable: { publicationCount: 1 }, userErrors: [] } } },
        };
      polls++;
      return { status: 200, headers: {}, body: { data: { product: { id: productId, status: 'ACTIVE', publishedOnPublication: true } } } };
    };
    const source = await approve('store_publish', 'publish', undefined, { productId, publicationId }, shop, shopAccount, { contentReview }),
      first = await executeApprovedProviderEffect(scope, source, randomUUID(), shopTransport);
    expect(first.ok).toBe(true);
    const proof = (
      await db.query("select id,trust,payload from public.evidence where mission_id=$1 and kind='store_published'", [scope.missionId])
    ).rows;
    expect(proof).toHaveLength(1);
    expect(proof[0]?.trust).toBe('verified');
    expect(proof[0]?.payload).toMatchObject({
      artifactVersionId: source,
      resourceId: productId,
      checkoutUiVerified: false,
      emailDeliveryVerified: false,
    });
    expect(polls).toBe(1);
    const next = await approve('store_publish', 'publish', undefined, { productId, publicationId }, shop, shopAccount, { contentReview });
    expect((await executeApprovedProviderEffect(scope, next, randomUUID(), shopTransport)).ok).toBe(true);
    expect(
      (
        await db.query(
          "select count(*)::int n from public.provider_receipts where mission_id=$1 and provider='shopify'and operation='store_publish'and provider_reference=$2",
          [scope.missionId, productId],
        )
      ).rows[0]?.n,
    ).toBe(2);
    const artifactId = (await db.query('select artifact_id from public.artifact_versions where id=$1', [source])).rows[0]?.artifact_id;
    await withRole('specialist_role', scope, c =>
      c.query('select public.append_artifact_version($1,$2,$3)', [
        scope.missionId,
        artifactId,
        {
          effectIntent: { action: 'store_publish', effectClass: 'publish', counterpartyId: shop, instrumentId: shopAccount },
          payload: { productId, publicationId },
        },
      ]),
    );
    expect(
      (await db.query('select count(*)::int n from public.stale_marks where mission_id=$1 and node_id=$2', [scope.missionId, proof[0]?.id]))
        .rows[0]?.n,
    ).toBe(1);
    const shipping = {
      kind: 'shipping',
      name: 'Synthetic profile',
      countryCode: 'SA',
      rateName: 'Standard',
      amount: '4.00',
      currency: 'SAR',
      locationIds: ['gid://shopify/Location/1'],
      variantIds: ['gid://shopify/ProductVariant/1'],
      quoteEvidenceId: String(randomUUID()),
    };
    let configurations = 0;
    const configure: Transport = async request => {
      const body = JSON.parse(request.body ?? '{}') as {
        variables: { profile: { variantsToAssociate: string[]; locationGroupsToCreate: { locationsToAdd: string[] }[] } };
      };
      expect(body.variables.profile.variantsToAssociate).toEqual(shipping.variantIds);
      expect(body.variables.profile.locationGroupsToCreate[0]?.locationsToAdd).toEqual(shipping.locationIds);
      configurations++;
      return {
        status: 200,
        headers: {},
        body: { data: { deliveryProfileCreate: { profile: { id: 'gid://shopify/DeliveryProfile/99' }, userErrors: [] } } },
      };
    };
    const invalid = await approve('store_publish_shipping', 'publish', undefined, shipping, shop, shopAccount);
    expect((await executeApprovedProviderEffect(scope, invalid, randomUUID(), configure)).ok).toBe(false);
    expect(configurations).toBe(0);
    const quote = await withRole('specialist_role', scope, async c =>
      String(
        (
          await c.query("select public.append_evidence($1,'commerce','carrier_quote','claimed',$2,'document','explicit-test-carrier')id", [
            scope.missionId,
            { amountMinor: 300, currency: 'SAR', countryCode: 'SA' },
          ])
        ).rows[0]?.id,
      ),
    );
    const confirmation = await withRole('specialist_role', scope, async c => {
      const a = (
          await c.query("select public.create_artifact($1,'founder_confirmation','commerce','Confirm synthetic carrier quote')id", [
            scope.missionId,
          ])
        ).rows[0]?.id,
        v = String(
          (
            await c.query('select public.append_artifact_version($1,$2,$3)id', [
              scope.missionId,
              a,
              {
                founderConfirmation: {
                  outcome: 'commerce',
                  kind: 'shipping_rate_confirmed',
                  statement: 'I reviewed this synthetic carrier quote for the test.',
                  payload: {
                    rate: { amountMinor: 300, currency: 'SAR', countryCode: 'SA', rateName: 'Carrier rate' },
                    sourceEvidenceIds: [quote],
                  },
                },
              },
            ])
          ).rows[0]?.id,
        );
      await c.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, v]);
      return v;
    });
    const confirmDecision = await withRole('lead_role', scope, async c =>
      String(
        (
          await c.query("select public.propose_decision($1,'engagement',$2,'commerce','shipping_rate_confirmed')id", [
            scope.missionId,
            { ...packet, approvedVersionIds: [confirmation] },
          ])
        ).rows[0]?.id,
      ),
    );
    shipping.quoteEvidenceId = await withRole('founder_role', scope, async c => {
      await new PostgresMissionRepository(c).resolveDecision(scope.missionId, confirmDecision, 'approve', 'a');
      await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, confirmation, confirmDecision]);
      return String(
        (await c.query('select public.confirm_founder_artifact($1,$2,$3)id', [scope.missionId, confirmDecision, confirmation])).rows[0]?.id,
      );
    });
    const publishedShipping = await approve('store_publish_shipping', 'publish', undefined, shipping, shop, shopAccount);
    const shippingResult = await executeApprovedProviderEffect(scope, publishedShipping, randomUUID(), configure);
    if (!shippingResult.ok) throw new Error(JSON.stringify(shippingResult.error));
    expect(shippingResult.ok).toBe(true);
    expect(configurations).toBe(1);
    const shippingProof = (
      await db.query("select id,trust from public.evidence where mission_id=$1 and kind='shipping_configured'", [scope.missionId])
    ).rows[0];
    expect(shippingProof?.trust).toBe('performed');
    await withRole('specialist_role', scope, c =>
      c.query(
        "select public.append_evidence($1,'commerce','carrier_quote','claimed',$2,'document','corrected-synthetic-carrier',null,$3)",
        [scope.missionId, { amountMinor: 500, currency: 'SAR', countryCode: 'SA' }, quote],
      ),
    );
    expect(
      (
        await db.query('select count(*)::int n from public.stale_marks where mission_id=$1 and node_id=$2', [
          scope.missionId,
          shippingProof?.id,
        ])
      ).rows[0]?.n,
    ).toBe(1);
  });
  it('a receipt-backed authorization void releases the displayed commitment without inventing a refund', async () => {
    authorized = false;
    captured = false;
    refunds = 0;
    const voidTransport: Transport = async request => {
      if (request.url.endsWith('/authorizations/TEST_VOID_AUTH/void')) return { status: 204, headers: {}, body: null };
      const response = await transport({
        ...request,
        url: request.url.replaceAll('TEST_VOID_ORDER', 'TEST_AUTH_ORDER').replaceAll('TEST_VOID_AUTH', 'TEST_AUTH'),
      });
      return {
        ...response,
        body: JSON.parse(
          JSON.stringify(response.body).replaceAll('TEST_AUTH_ORDER', 'TEST_VOID_ORDER').replaceAll('TEST_AUTH', 'TEST_VOID_AUTH'),
        ) as unknown,
      };
    };
    invoice = await approve('payment_capture', 'spend', 1000, {
      payeeMerchantId: 'PAYEEMERCHANT',
      amountMinor: 1000,
      currency: 'SAR',
      purpose: 'samples',
      returnUrl: `http://127.0.0.1:3000/api/payments/return?mission=${scope.missionId}`,
      cancelUrl: 'http://127.0.0.1:3000/',
      intent: 'AUTHORIZE',
    });
    expect((await prepareApprovedPayPalOrder(scope, invoice, randomUUID(), voidTransport)).ok).toBe(true);
    expect(await captureApprovedPayPalOrder(scope, 'TEST_VOID_ORDER', voidTransport)).toMatchObject({
      ok: true,
      value: { status: 'authorized' },
    });
    expect(
      (await db.query('select committed_minor from public.money_totals where mission_id=$1', [scope.missionId])).rows[0]?.committed_minor,
    ).toBe('1000');
    const version = await approve('payment_authorization_void', 'bind', undefined, {
      orderId: 'TEST_VOID_ORDER',
      authorizationId: 'TEST_VOID_AUTH',
      artifactVersionId: invoice,
      payeeMerchantId: 'PAYEEMERCHANT',
      amountMinor: 1000,
      currency: 'SAR',
      sandboxMode: true,
    });
    expect(await executeApprovedProviderEffect(scope, version, randomUUID(), voidTransport)).toMatchObject({ ok: true });
    expect(
      (await db.query('select committed_minor from public.money_totals where mission_id=$1', [scope.missionId])).rows[0]?.committed_minor,
    ).toBe('0');
    expect(
      (
        await db.query(
          "select cs.status from public.authorization_obligations o join public.payment_authorizations pa on pa.id=o.payment_authorization_id join public.commitment_states cs on cs.commitment_id=o.commitment_id where pa.provider_authorization_id='TEST_VOID_AUTH'order by cs.created_at desc,cs.id desc limit 1",
        )
      ).rows[0]?.status,
    ).toBe('closed');
    expect((await db.query('select private.mission_exposure($1)amount', [scope.missionId])).rows[0]?.amount).toBe('0');
  });
});
