import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { PostgresMissionRepository, EffectIntentSchema } from '@lo/state';
import { executeGuarded, postgresEffectRepository } from '@lo/policy';
import { OpenAIGenerationAdapter } from '@lo/adapters';
import { z } from 'zod';
import { TaskBriefSchema } from '../../runtime/src/contracts.js';
import {
  ProviderStorage,
  provisionProviderCredential,
  encryptProviderValue,
  decryptProviderValue,
  signProviderRouting,
  verifyProviderRouting,
  storeApprovalToken,
} from '@lo/runtime/provider-storage';
import { withRole, policyRepository, closeDatabasePools } from '@lo/runtime';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const url = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const name = `lo_provider_${Date.now()}`;
const admin = new Client({ connectionString: url });
let db: Client;
const prior = { ...process.env };
const scope = { authUserId: '00000000-0000-4000-8000-000000000001', missionId: '20000000-0000-4000-8000-000000000001' };
const founder = '10000000-0000-4000-8000-000000000001';
const party = '30000000-0000-4000-8000-000000000001';
let accountId: string;
let connection: { ref: string; webhookRoute: string };
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${name}`);
  const local = new URL(url);
  local.pathname = `/${name}`;
  db = new Client({ connectionString: local.href });
  await db.connect();
  const bootstrap = (await readFile(`${root}/supabase/tests/bootstrap.sql`, 'utf8')).replace(
    'create role authenticated nologin noinherit nobypassrls;',
    () =>
      "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
  );
  await db.query(bootstrap);
  for (const f of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(`${root}/supabase/migrations/${f}`, 'utf8'));
  await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
  await db.query('update private.platform_controls set effects_enabled=true');
  accountId = randomUUID();
  await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'paypal','connected','{pay}')", [
    accountId,
    founder,
  ]);
  process.env['DATABASE_URL'] = local.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
  process.env['PROVIDER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  connection = await provisionProviderCredential(scope, {
    accountId,
    provider: 'paypal',
    sandboxMode: true,
    credential: { clientId: 'test-client', clientSecret: 'fixture-private-secret' },
    settings: { webhookSigningSecret: 'fixture-webhook-secret' },
  });
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
});
describe('native PostgreSQL provider services / I-1 I-3 I-4 I-11 I-12', () => {
  it('AES-GCM authenticates mission/provider/reference and never stores plaintext credentials', async () => {
    const encrypted = encryptProviderValue({ secret: 'fixture-private-secret' }, 'mission-A');
    expect(JSON.stringify(encrypted)).not.toContain('fixture-private-secret');
    expect(decryptProviderValue(encrypted, 'mission-A')).toEqual({ secret: 'fixture-private-secret' });
    expect(() => decryptProviderValue(encrypted, 'mission-B')).toThrow();
    const raw = (await db.query('select encrypted from private.provider_credentials where ref=$1', [connection.ref])).rows[0]?.encrypted;
    expect(JSON.stringify(raw)).not.toContain('fixture-private-secret');
    const storage = new ProviderStorage(scope);
    expect(await storage.resolve({ missionId: scope.missionId, ref: connection.ref, provider: 'paypal', sandboxMode: true })).toMatchObject(
      { clientId: 'test-client', clientSecret: 'fixture-private-secret', revoked: false },
    );
  });
  it('denies cross-mission/provider/environment and specialist credential reads', async () => {
    const storage = new ProviderStorage(scope);
    for (const patch of [{ missionId: randomUUID() }, { provider: 'twilio' as const }, { sandboxMode: false }])
      await expect(
        storage.resolve({ missionId: scope.missionId, ref: connection.ref, provider: 'paypal', sandboxMode: true, ...patch }),
      ).rejects.toThrow();
    await expect(withRole('specialist_role', scope, async d => d.query('select *from private.provider_credentials'))).rejects.toThrow(
      /permission denied/,
    );
  });
  it('routing signatures reject mutation, expiry and forged tenant identity', () => {
    const token = signProviderRouting(
      { ...scope, credentialRef: connection.ref, provider: 'paypal', sandboxMode: true },
      Date.now() + 10000,
    );
    expect(verifyProviderRouting(token).missionId).toBe(scope.missionId);
    expect(() => verifyProviderRouting(token + '.tampered')).toThrow();
    expect(() => verifyProviderRouting(token, Date.now() + 20000)).toThrow();
    expect(connection.webhookRoute).not.toContain('fixture-private-secret');
  });
  it('atomic service reservations enforce caps and do not reissue ambiguous tasks', async () => {
    await withRole('founder_role', scope, async d => {
      await d.query("select public.configure_service_budget($1,'openai',100)", [scope.missionId]);
    });
    const storage = new ProviderStorage(scope);
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(keys.map(key => storage.reserve(scope.missionId, key, 'openai', 60)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const first = keys[results[0] ? 0 : 1];
    if (!first) throw new Error('Reservation missing.');
    await storage.ambiguous(scope.missionId, first);
    expect(await storage.reserve(scope.missionId, first, 'openai', 60)).toBe(false);
    expect(await storage.reserve(scope.missionId, randomUUID(), 'openai', 50)).toBe(false);
  });
  it('research provenance persists claimed evidence once per task+URL and never promotes a fetch to verified', async () => {
    const storage = new ProviderStorage(scope),
      task = randomUUID(),
      url = 'https://fixture.invalid/research';
    const payload = {
      testFixture: true,
      title: 'Fixture research',
      excerpt: 'Untrusted quoted supplier data.',
      contentHash: 'a'.repeat(64),
      providerReference: 'explicit-test-session',
    };
    const first = await storage.saveResearchEvidence(task, url, 'supply', payload);
    expect(await storage.saveResearchEvidence(task, url, 'supply', payload)).toBe(first);
    expect(await storage.researchEvidence(task, url)).toMatchObject({ evidenceId: first, payload });
    const rows = await withRole(
      'founder_role',
      scope,
      async d =>
        (
          await d.query('select trust,source_type,source_reference from public.evidence where mission_id=$1 and id=$2', [
            scope.missionId,
            first,
          ])
        ).rows,
    );
    expect(rows).toEqual([{ trust: 'claimed', source_type: 'url', source_reference: url }]);
  });
  it('encrypted approvals resolve server-side, consume once and produce receipt-backed outbound messages', async () => {
    const packet = {
      question: 'Send this message?',
      options: [{ id: 'a', label: 'Approve', evidenceIds: [], cost: null, timeDays: 0, consequences: 'Send the exact draft' }],
      recommendation: { optionId: 'a', reasons: ['Reviewed draft'] },
      staleImpact: [],
      defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
    };
    const artifact = await withRole('specialist_role', scope, async d => {
      const a = (await d.query("select public.create_artifact($1,'outbound_message','supply','Test message')id", [scope.missionId])).rows[0]
        ?.id;
      const v = (
        await d.query('select public.append_artifact_version($1,$2,$3)id', [
          scope.missionId,
          a,
          { payload: { text: 'A disclosed fixture message.' } },
        ])
      ).rows[0]?.id;
      await d.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, v]);
      return String(v);
    });
    const decision = await withRole('lead_role', scope, async d =>
      String(
        (
          await d.query("select public.propose_decision($1,'selection',$2,'supply','direction',null)id", [
            scope.missionId,
            { ...packet, approvedVersionIds: [artifact] },
          ])
        ).rows[0]?.id,
      ),
    );
    const approval = await withRole('founder_role', scope, async d => {
      const repo = new PostgresMissionRepository(d);
      const resolved = await repo.resolveDecision(scope.missionId, decision, 'approve');
      if (!resolved.ok) throw new Error('Approval failed.');
      await d.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, artifact, decision]);
      const token = randomUUID() + randomUUID();
      const r = await repo.issueApproval(
        scope.missionId,
        decision,
        { action: 'send_message', counterpartyId: party, artifactVersionId: artifact, amountMinor: null, currency: null },
        token,
        new Date(Date.now() + 60000).toISOString(),
      );
      if (!r.ok) throw new Error('Token issuance failed.');
      return { id: r.value, token };
    });
    await storeApprovalToken(scope, approval.id, approval.token);
    const storage = new ProviderStorage(scope);
    const intent = EffectIntentSchema.parse({
      missionId: scope.missionId,
      taskId: randomUUID(),
      action: 'send_message',
      effectClass: 'communicate',
      counterpartyId: party,
      artifactVersionId: artifact,
      idempotencyKey: randomUUID(),
      mode: 'do',
      sandboxMode: true,
      newContact: false,
    });
    expect(await storage.resolveApproval(intent)).toBe(approval.token);
    const request = { ...intent, approvalToken: approval.token };
    const result = await executeGuarded(
      request,
      { role: 'sourcing' },
      postgresEffectRepository(policyRepository(scope), scope.missionId),
      async i => ({
        ok: true,
        data: { testOnly: true },
        receipt: {
          provider: 'test-email',
          providerId: 'test-email-receipt',
          operation: i.action,
          timestamp: new Date().toISOString(),
          payloadHash: 'a'.repeat(64),
          idempotencyKey: i.idempotencyKey,
          sandboxMode: true,
        },
      }),
    );
    expect(result.ok).toBe(true);
    await storage.recordOutbound(
      request,
      { original: 'A disclosed fixture message.', translation: 'رسالة اختبار معلنة.', channel: 'email' },
      'test-email-receipt',
    );
    await storage.recordOutbound(
      request,
      { original: 'A disclosed fixture message.', translation: 'رسالة اختبار معلنة.', channel: 'email' },
      'test-email-receipt',
    );
    expect(await storage.resolveApproval(intent)).toBeUndefined();
    const rows = await withRole(
      'founder_role',
      scope,
      async d =>
        (
          await d.query("select approval_id from public.messages where mission_id=$1 and provider_id='test-email-receipt'", [
            scope.missionId,
          ])
        ).rows,
    );
    expect(rows).toEqual([{ approval_id: approval.id }]);
  });
  it('durable webhook replay is one event and one outbox wake', async () => {
    const store = new ProviderStorage(scope, 'ingress_role').webhookStore('counterparty.replied');
    const event = {
      provider: 'resend' as const,
      providerEventId: randomUUID(),
      payload: { type: 'email.received', data: { email_id: randomUUID() } },
      payloadHash: 'a'.repeat(64),
      receivedAt: new Date().toISOString(),
      signatureVerified: true as const,
    };
    const first = await store.insertVerified(event);
    expect(first.duplicate).toBe(false);
    expect((await store.insertVerified(event)).duplicate).toBe(true);
    expect(
      (
        await db.query("select count(*)::int n from public.outbox where mission_id=$1 and payload->>'eventId'=$2", [
          scope.missionId,
          first.eventId,
        ])
      ).rows[0]?.n,
    ).toBe(1);
  });
  it('FR-PAY-07 refund money requires exact verified correlation; API receipt alone never changes totals', async () => {
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: scope.authUserId, mission_id: scope.missionId }),
    ]);
    const decision = String(
      (
        await db.query("select decision_id from public.decision_resolutions where mission_id=$1 and response='approve'limit 1", [
          scope.missionId,
        ])
      ).rows[0]?.decision_id,
    );
    const version = String(
      (
        await db.query("select artifact_version_id from public.artifact_statuses where mission_id=$1 and status='approved'limit 1", [
          scope.missionId,
        ])
      ).rows[0]?.artifact_version_id,
    );
    const capture = 'REFUND_TEST_CAPTURE',
      order = 'REFUND_TEST_ORDER',
      paymentId = randomUUID(),
      originalAuth = randomUUID(),
      refundAuth = randomUUID(),
      originalReceipt = randomUUID(),
      refundReceipt = randomUUID(),
      originalEvent = randomUUID();
    for (const [authorizationId, action, amount] of [
      [originalAuth, 'payment_capture', 1000],
      [refundAuth, 'payment_refund', 400],
    ] as const) {
      const approvalId = randomUUID();
      await db.query(
        "insert into public.approvals(id,mission_id,decision_id,binding,token_hash,expires_at)values($1,$2,$3,$4,$5,clock_timestamp()+interval'1 hour')",
        [
          approvalId,
          scope.missionId,
          decision,
          { action, counterpartyId: party, amountMinor: amount, currency: 'SAR', artifactVersionId: version },
          randomBytes(32).toString('hex'),
        ],
      );
      await db.query(
        'insert into public.effect_authorizations(id,mission_id,intent,intent_hash,idempotency_key,approval_id,amount_minor,sandbox_mode)values($1,$2,$3,$4,$5,$6,$7,true)',
        [
          authorizationId,
          scope.missionId,
          {
            missionId: scope.missionId,
            taskId: randomUUID(),
            action,
            effectClass: 'spend',
            counterpartyId: party,
            amountMinor: amount,
            currency: 'SAR',
            artifactVersionId: version,
            instrumentId: accountId,
            mode: 'do',
            sandboxMode: true,
          },
          'explicit-test-fixture',
          randomUUID(),
          approvalId,
          amount,
        ],
      );
    }
    await db.query(
      "insert into public.provider_receipts(id,mission_id,authorization_id,provider,provider_reference,operation,sandbox_mode,data)values($1,$2,$3,'paypal',$4,'payment_capture',true,$5),($6,$2,$7,'paypal','REFUND_TEST_ID','payment_refund',true,$8)",
      [
        originalReceipt,
        scope.missionId,
        originalAuth,
        capture,
        { testFixture: true, orderId: order, captureId: capture },
        refundReceipt,
        refundAuth,
        {
          testFixture: true,
          orderId: order,
          captureId: capture,
          payeeId: party,
          payeeMerchantId: 'PAYEE',
          amountMinor: 400,
          currency: 'SAR',
        },
      ],
    );
    await db.query(
      "insert into public.payments(id,mission_id,authorization_id,provider,payee_id,instrument_id,amount_minor,currency,purpose,artifact_version_id,sandbox_mode)values($1,$2,$3,'paypal',$4,$5,1000,'SAR','fixture',$6,true)",
      [paymentId, scope.missionId, originalAuth, party, accountId, version],
    );
    await db.query(
      "insert into public.events(id,mission_id,type,payload,provider,provider_event_id,signature_verified)values($1,$2,'payment.captured','{}','paypal',$3,true)",
      [originalEvent, scope.missionId, randomUUID()],
    );
    await db.query(
      "insert into public.payment_states(mission_id,payment_id,state,receipt_id,confirmation_event_id)values($1,$2,'captured',$3,$4)",
      [scope.missionId, paymentId, originalReceipt, originalEvent],
    );
    const refundId = await withRole('policy_role', scope, async d =>
      String((await d.query('select public.register_payment_refund($1,$2)id', [scope.missionId, refundReceipt])).rows[0]?.id),
    );
    expect(
      (await db.query("select count(*)::int n from public.money_ledger where mission_id=$1 and kind='refund'", [scope.missionId])).rows[0]
        ?.n,
    ).toBe(0);
    const store = new ProviderStorage(scope, 'ingress_role').webhookStore('payment.refund_verified_poll');
    const payload = {
      refundId,
      providerReference: 'REFUND_TEST_ID',
      orderId: order,
      captureId: capture,
      payeeId: party,
      amountMinor: 400,
      currency: 'SAR',
      sandboxMode: true,
    };
    for (const bad of [
      { payeeId: randomUUID() },
      { providerReference: 'WRONG' },
      { orderId: 'WRONG' },
      { captureId: 'WRONG' },
      { amountMinor: 1 },
      { currency: 'USD' },
      { sandboxMode: false },
    ]) {
      const event = await store.insertVerified({
        provider: 'paypal',
        providerEventId: randomUUID(),
        payload: { ...payload, ...bad },
        payloadHash: 'a'.repeat(64),
        receivedAt: new Date().toISOString(),
        signatureVerified: true,
      });
      await expect(
        withRole('policy_role', scope, async d =>
          d.query('select public.confirm_payment_refund($1,$2,$3)', [scope.missionId, refundId, event.eventId]),
        ),
      ).rejects.toThrow(/exact verified refund confirmation/);
    }
    const event = await store.insertVerified({
      provider: 'paypal',
      providerEventId: randomUUID(),
      payload,
      payloadHash: 'a'.repeat(64),
      receivedAt: new Date().toISOString(),
      signatureVerified: true,
    });
    for (let i = 0; i < 2; i++)
      await withRole('policy_role', scope, async d => {
        await d.query('select public.confirm_payment_refund($1,$2,$3)', [scope.missionId, refundId, event.eventId]);
      });
    const rows = (
      await db.query("select amount_minor,sandbox_mode from public.money_ledger where mission_id=$1 and kind='refund'", [scope.missionId])
    ).rows;
    expect(rows).toEqual([{ amount_minor: '400', sandbox_mode: true }]);
  });
  it('preparation holds mission/platform/account authority through invocation and replays only its encrypted completed result', async () => {
    const artifact = String(
        (
          await db.query("select artifact_version_id from public.artifact_statuses where mission_id=$1 and status='approved'limit 1", [
            scope.missionId,
          ])
        ).rows[0]?.artifact_version_id,
      ),
      storage = new ProviderStorage(scope);
    let entered: () => void = () => {},
      release: () => void = () => {};
    const inside = new Promise<void>(resolve => {
        entered = resolve;
      }),
      gate = new Promise<void>(resolve => {
        release = resolve;
      });
    let calls = 0;
    const request = {
      provider: 'paypal' as const,
      kind: 'paypal_order' as const,
      credentialRef: connection.ref,
      intent: EffectIntentSchema.parse({
        missionId: scope.missionId,
        taskId: randomUUID(),
        action: 'payment_capture',
        effectClass: 'spend',
        counterpartyId: party,
        artifactVersionId: artifact,
        instrumentId: accountId,
        amountMinor: 100,
        currency: 'SAR',
        idempotencyKey: randomUUID(),
        mode: 'do',
        sandboxMode: true,
        newContact: false,
      }),
      requestHash: 'c'.repeat(64),
    };
    const preparation = storage.executePreparation(request, async () => {
      calls++;
      entered();
      await gate;
      return { testFixture: true, orderId: 'PREPARED_TEST_ORDER' };
    });
    await inside;
    let paused = false;
    const pause = withRole('founder_role', scope, async d => {
      const result = await new PostgresMissionRepository(d).transitionMission(scope.missionId, 'paused');
      if (!result.ok) throw new Error('Fixture pause failed');
      paused = true;
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(paused).toBe(false);
    release();
    expect(await preparation).toEqual({ testFixture: true, orderId: 'PREPARED_TEST_ORDER' });
    await pause;
    await expect(
      storage.executePreparation({ ...request, intent: { ...request.intent, idempotencyKey: randomUUID() } }, async () => {
        calls++;
        return {};
      }),
    ).rejects.toThrow(/paused|ended/);
    await withRole('founder_role', scope, async d => {
      const resumed = await new PostgresMissionRepository(d).transitionMission(scope.missionId, 'active');
      if (!resumed.ok) throw new Error('Fixture resume failed');
    });
    expect(
      await storage.executePreparation(request, async () => {
        calls++;
        return { testFixture: false };
      }),
    ).toEqual({ testFixture: true, orderId: 'PREPARED_TEST_ORDER' });
    expect(calls).toBe(1);
  });
  it('paid generation reserves founder dollars before HTTP, caches image results, and accounts for input plus output tokens', async () => {
    const saved = { ...process.env };
    try {
      const run = randomUUID(),
        openaiAccount = randomUUID(),
        brief = TaskBriefSchema.parse({
          id: run,
          missionId: scope.missionId,
          role: 'brand',
          outcome: 'brand',
          objective: 'Explicit native generation fixture',
          constraints: [],
          budgetAuthority: [],
          deadline: new Date(Date.now() + 60000).toISOString(),
          doneCriteria: ['Return typed generation'],
          evidenceRequired: ['provider receipt'],
          playbook: { id: 'fixture', version: 1, step: 'generation', source: 'https://example.test/fixture' },
          maxToolCalls: 1,
          maxTokens: 10000,
          tier: 'small',
          requestedByFounder: false,
          overdueExposure: false,
          unblocks: [],
          parentRunId: null,
        });
      await db.query(
        "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier)values($1,$2,'brand',$3,'explicit-service-fixture','small')",
        [run, scope.missionId, brief],
      );
      await db.query(
        "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'openai','connected','{generate}')",
        [openaiAccount, founder],
      );
      const connected = await provisionProviderCredential(scope, {
        accountId: openaiAccount,
        provider: 'openai',
        sandboxMode: true,
        credential: { apiKey: 'explicit-test-key', allowedModels: ['test-image', 'test-structured'], maxOutputTokens: 16 },
      });
      await withRole('founder_role', scope, d => d.query("select public.configure_service_budget($1,'openai',100000)", [scope.missionId]));
      const storage = new ProviderStorage(scope),
        base = EffectIntentSchema.parse({
          missionId: scope.missionId,
          taskId: run,
          action: 'generate_image',
          effectClass: 'communicate',
          counterpartyId: party,
          idempotencyKey: randomUUID(),
          mode: 'do',
          sandboxMode: true,
          newContact: false,
        });
      let calls = 0;
      const deps = {
        ...storage.dependencies(),
        transport: async () => {
          calls++;
          return { status: 200, headers: {}, body: { created: 12345, data: [{ b64_json: 'ZXhwbGljaXQtdGVzdC1pbWFnZQ==' }] } };
        },
      };
      delete process.env['MODEL_FOUNDER_DAILY_CAP_MICRO_USD'];
      const input = { model: 'test-image', prompt: 'Explicit test image', size: '1024x1024', transparent: false };
      expect((await new OpenAIGenerationAdapter(deps, storage).image(base, connected.ref, input)).ok).toBe(false);
      expect(calls).toBe(0);
      process.env['MODEL_FOUNDER_DAILY_CAP_MICRO_USD'] = '400';
      process.env['MODEL_IMAGE_PRICE_CEILINGS_JSON'] = JSON.stringify({
        'test-image': {
          maximumCallMicroUsd: 400,
          source: 'https://example.test/synthetic-image-pricing',
          observedAt: new Date().toISOString(),
        },
      });
      const imageIntent = { ...base, idempotencyKey: randomUUID() },
        adapter = new OpenAIGenerationAdapter(deps, storage);
      expect((await adapter.image(imageIntent, connected.ref, input)).ok).toBe(true);
      expect((await adapter.image(imageIntent, connected.ref, input)).ok).toBe(true);
      expect(calls).toBe(1);
      expect((await adapter.image({ ...base, idempotencyKey: randomUUID() }, connected.ref, input)).ok).toBe(false);
      expect(calls).toBe(1);
      const usage = (await db.query('select cost_micro_usd,usage_complete from public.model_usage where run_id=$1', [run])).rows;
      expect(usage).toEqual([{ cost_micro_usd: null, usage_complete: false }]);
      process.env['MODEL_FOUNDER_DAILY_CAP_MICRO_USD'] = '100000';
      process.env['MODEL_PRICE_RATES_JSON'] = JSON.stringify({
        'test-structured': {
          inputPerMillion: 2,
          cachedInputPerMillion: 0.5,
          outputPerMillion: 8,
          source: 'https://example.test/synthetic-text-pricing',
          observedAt: new Date().toISOString(),
        },
      });
      const structuredIntent = { ...base, idempotencyKey: randomUUID(), action: 'generate_structured' },
        structured = new OpenAIGenerationAdapter(
          {
            ...storage.dependencies(),
            transport: async () => ({
              status: 200,
              headers: {},
              body: {
                id: 'explicit-test-response',
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text: '{"valid":true}' }] }],
                usage: { input_tokens: 50, output_tokens: 10 },
              },
            }),
          },
          storage,
        );
      expect(
        (
          await structured.structured(
            structuredIntent,
            connected.ref,
            { model: 'test-structured', instructions: 'Return test JSON', input: 'x'.repeat(2000), maxOutputTokens: 16 },
            z.object({ valid: z.boolean() }).strict(),
            'fixture',
          )
        ).ok,
      ).toBe(true);
      const tokenUsage = (
        await db.query(
          'select r.maximum_units,u.used_units from public.service_reservations r join public.service_usage_events u on u.reservation_id=r.id where r.task_key=$1',
          [structuredIntent.idempotencyKey],
        )
      ).rows[0];
      expect(Number(tokenUsage?.maximum_units)).toBeGreaterThan(2000);
      expect(tokenUsage?.used_units).toBe('60');
    } finally {
      process.env = saved;
    }
  });
  it('revoking a connected account stops the next step-time secret lookup', async () => {
    await withRole('founder_role', scope, async d => {
      await d.query('select public.revoke_account($1,$2)', [founder, accountId]);
    });
    await expect(
      new ProviderStorage(scope).resolve({ missionId: scope.missionId, ref: connection.ref, provider: 'paypal', sandboxMode: true }),
    ).rejects.toThrow();
  });
});
