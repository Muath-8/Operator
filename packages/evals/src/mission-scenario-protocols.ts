import { Client } from 'pg';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Usage, type Model, type ModelResponse } from '@openai/agents';
import { z } from 'zod';
import { PostgresMissionRepository, type JsonValue } from '@lo/state';
import { withRole, closeDatabasePools, TaskBriefSchema, type ActorScope, type PlanDelta } from '@lo/runtime';
import { createModelServices } from '../../../apps/runtime/src/model-services.js';
import {
  providerToolRegistry,
  prepareApprovedPayPalOrder,
  captureApprovedPayPalOrder,
  reconcileProviderPayments,
  executeApprovedProviderEffect,
  sendProviderMessage,
} from '../../../apps/runtime/src/provider-tools.js';
import { ProviderStorage, provisionProviderCredential, storeApprovalToken } from '../../../apps/runtime/src/provider-storage.js';
import { type Transport, type HttpRequest } from '@lo/adapters';
import { type MissionScenario, type MissionScenarioDriver, type ProtocolObservation, ScenarioBlocked } from './mission-scenarios.js';

const source = fileURLToPath(import.meta.url),
  root = fileURLToPath(new URL('../../..', import.meta.url)),
  fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Scope = ActorScope & { missionId: string };
interface State {
  scope: Scope;
  party: string;
  mailAccount: string;
  payAccount: string;
  outreach: string;
  requests: HttpRequest[];
  transport: Transport;
  plan: PlanDelta;
  summary: string;
  capturePosts: number;
  paymentVersion?: string;
  paymentId?: string;
  orderId?: string;
  captureId?: string;
  sourceVersion?: string;
  sourceArtifact?: string;
  fault: string;
  observe: (observation: ProtocolObservation) => void;
}
const emptyPlan = (message: string): PlanDelta => ({
  questions: [],
  runs: [],
  decisions: [],
  commitments: [],
  founderMessage: message,
  evidenceIds: [],
  focus: null,
});

/** All prices, users, accounts and responses in this module are explicitly
 * synthetic sandbox protocol fixtures. Actual production functions perform the
 * authorization, adapter parsing, receipts and ledger writes. No live provider
 * completion or model-quality score is inferred from these test protocols. */
export async function createBuiltinScenarioDriver(options: {
  mode: 'test_protocol' | 'live';
  directory: string;
}): Promise<MissionScenarioDriver & { close(): Promise<void> }> {
  if (options.mode === 'test_protocol' && process.env.NODE_ENV !== 'test')
    throw new Error('Explicit NODE_ENV=test is required for sandbox protocol execution');
  const prior = { ...process.env },
    url = new URL(process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Protocol fixtures require isolated loopback PostgreSQL');
  const admin = new Client({ connectionString: url.href }),
    database = `lo_scenarios_${Date.now()}`,
    user = randomUUID(),
    founder = randomUUID(),
    states = new Map<string, State>();
  let db: Client | undefined,
    created = false;
  async function initialize() {
    if (db) return;
    if (options.mode === 'live' && (!process.env['OPENAI_API_KEY'] || process.env['LO_SCENARIO_LIVE_MODEL'] !== 'true'))
      throw new ScenarioBlocked(
        'Live scenario model execution requires configured credentials and explicit LO_SCENARIO_LIVE_MODEL=true; no paid call was attempted',
      );
    await admin.connect();
    await admin.query(`create database ${database}`);
    created = true;
    url.pathname = `/${database}`;
    db = new Client({ connectionString: url.href });
    await db.connect();
    await db.query(
      (await readFile(`${root}/supabase/tests/bootstrap.sql`, 'utf8')).replace(
        'create role authenticated nologin noinherit nobypassrls;',
        () =>
          "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
      ),
    );
    for (const file of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort())
      await db.query(await readFile(`${root}/supabase/migrations/${file}`, 'utf8'));
    await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
    await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
    await db.query('update private.platform_controls set effects_enabled=true');
    process.env = {
      ...process.env,
      DATABASE_URL: url.href,
      LO_EXECUTION_MODE: 'local',
      APP_ORIGIN: 'http://127.0.0.1:3000',
      PROVIDER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      ...(options.mode === 'test_protocol'
        ? {
            OPENAI_API_KEY: 'explicit-scripted-sdk-protocol-not-a-real-key',
            MODEL_FRONTIER: 'synthetic-protocol-2026-11-12',
            MODEL_MID: 'synthetic-protocol-2026-11-12',
            MODEL_SMALL: 'synthetic-protocol-2026-11-12',
            MODEL_REVIEWER: 'synthetic-protocol-2026-11-12',
            MODEL_PRICE_RATES_JSON: JSON.stringify({
              'synthetic-protocol-2026-11-12': {
                inputPerMillion: 0,
                cachedInputPerMillion: 0,
                outputPerMillion: 0,
                source: 'https://example.test/synthetic-unpriced-sdk-fixture',
                observedAt: new Date().toISOString(),
              },
            }),
            MODEL_FOUNDER_DAILY_CAP_MICRO_USD: '1000000',
          }
        : {}),
    };
  }
  async function query(sql: string, values: unknown[] = []) {
    if (!db) throw new Error('Isolated protocol database unavailable');
    return db.query(sql, values);
  }
  async function proposed(scope: Scope, type: string, content: Record<string, JsonValue>, outcome = 'supply') {
    return withRole('specialist_role', scope, async c => {
      const artifact = z
          .uuid()
          .parse(
            (
              await c.query('select public.create_artifact($1,$2,$3,$4)id', [
                scope.missionId,
                type,
                outcome,
                'Explicit synthetic canonical scenario source',
              ])
            ).rows[0]?.id,
          ),
        version = z
          .uuid()
          .parse((await c.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, artifact, content])).rows[0]?.id);
      await c.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, version]);
      return { artifact, version };
    });
  }
  async function approve(
    scope: Scope,
    version: string,
    kind = 'selection',
    gate = 'scenario_source',
    cost: { amountMinor: number; currency: string } | null = null,
    question = 'Review exact synthetic protocol source',
  ) {
    const packet = {
        question,
        options: [
          {
            id: 'a',
            label: 'Approve exact sandbox fixture',
            artifactVersionIds: [version],
            evidenceIds: [],
            cost,
            timeDays: 0,
            consequences: 'Synthetic controlled protocol only; no real recipient or money',
          },
        ],
        approvedVersionIds: [version],
        recommendation: { optionId: 'a', reasons: ['Explicit test scenario action'] },
        staleImpact: [],
        defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
      },
      decision = await withRole('lead_role', scope, async c =>
        z
          .uuid()
          .parse(
            (await c.query("select public.propose_decision($1,$2,$3,'supply',$4)id", [scope.missionId, kind, packet, gate])).rows[0]?.id,
          ),
      );
    await withRole('founder_role', scope, async c => {
      await c.query("select public.resolve_decision($1,$2,'approve','a')", [scope.missionId, decision]);
      await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, version, decision]);
    });
    return decision;
  }
  async function issue(f: State, version: string, decision: string, action: string, amountMinor: number | null, currency: string | null) {
    const token = randomBytes(32).toString('hex'),
      approval = await withRole('founder_role', f.scope, c =>
        new PostgresMissionRepository(c).issueApproval(
          f.scope.missionId,
          decision,
          { action, counterpartyId: f.party, amountMinor, currency, artifactVersionId: version },
          token,
          new Date(Date.now() + 3600000).toISOString(),
        ),
      );
    if (!approval.ok) throw new Error('Actual sandbox approval was denied');
    await storeApprovalToken(f.scope, approval.value, token);
  }
  function transportFor(f: State): Transport {
    const orders = new Map<string, { unit: Record<string, unknown>; captured: boolean }>();
    return async request => {
      f.requests.push(request);
      f.observe({
        kind: 'provider_request',
        at: new Date().toISOString(),
        requestHash: fingerprint(request),
        responseHash: null,
        provider: request.url.includes('resend') ? 'resend' : 'paypal',
        synthetic: true,
      });
      if (request.url === 'https://api.resend.com/emails') {
        if (f.fault === 'message_missing_receipt') return { status: 200, headers: {}, body: {} };
        return { status: 200, headers: {}, body: { id: `SYNTHETIC_CHANNEL_${randomUUID()}` } };
      }
      if (request.url.endsWith('/oauth2/token')) return { status: 200, headers: {}, body: { access_token: 'explicit-protocol-token' } };
      if (request.url.endsWith('/v2/checkout/orders') && request.method === 'POST') {
        const unit = z
          .object({ purchase_units: z.array(z.record(z.string(), z.unknown())).length(1) })
          .passthrough()
          .parse(JSON.parse(String(request.body))).purchase_units[0];
        if (!unit) throw new Error('Expected protocol purchase unit');
        const id = `ORDER_${randomUUID()}`;
        orders.set(id, { unit, captured: false });
        return {
          status: 201,
          headers: {},
          body: {
            id,
            status: 'CREATED',
            purchase_units: [unit],
            links: [
              {
                rel: 'approve',
                href:
                  f.fault === 'lookalike_link'
                    ? 'https://paypa1.example.test/checkout'
                    : `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
              },
            ],
          },
        };
      }
      if (request.url.includes('/captures/') && request.url.endsWith('/refund'))
        return {
          status: 201,
          headers: {},
          body: { id: 'SYNTHETIC_REFUND', status: 'PENDING', amount: { value: '1.00', currency_code: 'SAR' } },
        };
      if (request.url.endsWith('/refunds/SYNTHETIC_REFUND'))
        return {
          status: 200,
          headers: {},
          body: {
            id: 'SYNTHETIC_REFUND',
            status: 'COMPLETED',
            amount: { value: '1.00', currency_code: 'SAR' },
            links: [{ rel: 'up', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${f.captureId}` }],
          },
        };
      const match = request.url.match(/\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/),
        id = match?.[1];
      if (!id) throw new Error('Unregistered protocol endpoint');
      const order = orders.get(id);
      if (!order) throw new Error('Unknown protocol order');
      if (match[2]) {
        f.capturePosts++;
        if (f.fault === 'capture_declined') return { status: 422, headers: {}, body: { name: 'INSTRUMENT_DECLINED' } };
        order.captured = true;
        f.captureId = `CAPTURE_${id}`;
        if (f.fault === 'capture_timeout') {
          f.fault = 'none';
          throw new Error('Explicit uncertain protocol outcome after actual synthetic acceptance');
        }
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
                ? { payments: { captures: [{ id: `CAPTURE_${id}`, status: 'COMPLETED', amount: order.unit['amount'] }] } }
                : {}),
            },
          ],
        },
      };
    };
  }
  async function fixture(scenario: MissionScenario): Promise<State> {
    await initialize();
    const scope:Scope = {authUserId:user,missionId:randomUUID()},
      party = randomUUID(),
      mailAccount = randomUUID(),
      payAccount = randomUUID();
    await query("insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,involvement,metadata)values($1,$2,$3,$4,'SAR',true,'do','{\"budgetMinor\":10000}')",[scope.missionId,founder,scenario.id==='A16'?'discover':'launch','Explicit isolated canonical protocol: '+scenario.name]);
    await query('insert into public.threads(mission_id)values($1)',[scope.missionId]);
    await query(
      'insert into public.counterparties(id,founder_id,kind,name,channels,verification)values($1,$2,\'supplier\',\'Explicit protocol counterparty\',\'{"email":"scenario@test.example","businessHourStart":0,"businessHourEnd":24}\',\'{"emailVerified":true}\')',
      [party, founder],
    );
    await query(
      "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$3,'resend','connected','{send}'),($2,$3,'paypal','connected','{pay}')",
      [mailAccount, payAccount, founder],
    );
    await provisionProviderCredential(scope, {
      accountId: mailAccount,
      provider: 'resend',
      sandboxMode: true,
      credential: {
        apiKey: 'explicit-protocol-key',
        from: 'operator@test.example',
        testDomain: 'test.example',
        allowedSandboxRecipients: ['scenario@test.example'],
      },
    });
    await provisionProviderCredential(scope, {
      accountId: payAccount,
      provider: 'paypal',
      sandboxMode: true,
      credential: {
        clientId: 'explicit-protocol-client',
        clientSecret: 'explicit-protocol-secret',
        merchantId: 'OWNMERCHANT',
        webhookId: 'SYNTHETIC_WEBHOOK',
        verifiedPayees: { [party]: 'PAYEEMERCHANT' },
      },
    });
    const expiresAt = new Date(Date.now() + 86400000).toISOString(),
      coverage = {
        actions: ['send_message'],
        effectClasses: ['communicate'],
        counterpartyIds: [party],
        channels: ['email'],
        purposes: ['follow_up', 'introduction'],
        instrumentIds: [mailAccount],
        maxNewContacts: 5,
      },
      source = await proposed(scope, 'mandate', {
        mandate: { type: 'outreach', scope: coverage, ceilingPer: 0, ceilingTotal: 0, currency: 'SAR', expiresAt },
      }),
      decision = await approve(scope, source.version, 'mandate', 'outreach'),
      outreach = await withRole('founder_role', scope, async c =>
        z
          .uuid()
          .parse(
            (await c.query("select public.grant_mandate($1,$2,'outreach',$3,0,0,$4)id", [scope.missionId, decision, coverage, expiresAt]))
              .rows[0]?.id,
          ),
      );
    const f: State = {
      scope,
      party,
      mailAccount,
      payAccount,
      outreach,
      requests: [],
      transport: async () => {
        throw new Error('Protocol not initialized');
      },
      plan: emptyPlan(`Explicit synthetic ${scenario.name}: no completion is inferred.`),
      summary: 'Pending explicit protocol',
      capturePosts: 0,
      fault: 'none',
      observe: () => {},
    };
    f.transport = transportFor(f);
    states.set(scope.missionId, f);
    return f;
  }
  async function payment(f: State) {
    const content = {
        effectIntent: {
          action: 'payment_capture',
          effectClass: 'spend',
          counterpartyId: f.party,
          instrumentId: f.payAccount,
          amountMinor: 100,
          currency: 'SAR',
          purpose: 'Synthetic sample',
        },
        payload: {
          artifactVersionId: randomUUID(),
          artifactStatus: 'approved',
          counterpartyId: f.party,
          payeeMerchantId: f.fault === 'payee_change' ? 'UNAPPROVEDMERCHANT' : 'PAYEEMERCHANT',
          amountMinor: 100,
          currency: 'SAR',
          purpose: 'Synthetic sample',
          returnUrl: `http://127.0.0.1:3000/api/payments/return?mission=${f.scope.missionId}`,
          cancelUrl: 'http://127.0.0.1:3000/',
          intent: 'CAPTURE',
        },
      },
      source = await proposed(f.scope, 'payment_proposal', content),
      decision = await approve(f.scope, source.version, 'engagement', 'payment', { amountMinor: 100, currency: 'SAR' });
    await issue(f, source.version, decision, 'payment_capture', 100, 'SAR');
    f.paymentVersion = source.version;
    const prepared = await prepareApprovedPayPalOrder(f.scope, source.version, randomUUID(), f.transport);
    if (!prepared.ok) return false;
    const order = z.object({ orderId: z.string() }).passthrough().parse(prepared.value);
    f.orderId = order.orderId;
    const captured = await captureApprovedPayPalOrder(f.scope, order.orderId, f.transport);
    if (captured.ok) {
      f.paymentId = z.object({ paymentId: z.uuid() }).passthrough().parse(captured.value).paymentId;
    }
    return captured.ok;
  }
  async function send(f: State, text = 'I am an AI-assisted agent for the founder. Please confirm the sample lead time in writing.') {
    const task = TaskBriefSchema.parse({
      id: randomUUID(),
      missionId: f.scope.missionId,
      role: 'operations',
      outcome: 'supply',
      objective: 'Explicit protocol message boundary',
      constraints: ['Synthetic recipient only'],
      budgetAuthority: [f.outreach],
      deadline: new Date(Date.now() + 60000).toISOString(),
      doneCriteria: ['Record actual protocol receipt'],
      evidenceRequired: ['Approved mandate'],
      playbook: { id: 'scenario-protocol', version: 1, step: 'message', source: 'https://example.test/synthetic-protocol' },
      maxToolCalls: 1,
      maxTokens: 256,
      tier: 'small',
      requestedByFounder: false,
      overdueExposure: false,
      unblocks: ['supply'],
      parentRunId: null,
    });
    return sendProviderMessage(
      new ProviderStorage(f.scope),
      task,
      {
        counterpartyId: f.party,
        mandateId: f.outreach,
        text,
        translation: text,
        language: 'en',
        purpose: 'follow_up',
        subject: 'Explicit sandbox scenario',
      },
      'email',
      false,
      f.transport,
    );
  }
  function scriptedModel(f: State): Model {
    const response = (): ModelResponse => ({
      responseId: `resp_protocol_${randomUUID()}`,
      usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
      output: [
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(f.plan) }] },
      ],
    });
    return {
      getResponse: async () => response(),
      async *getStreamedResponse():AsyncGenerator<ReturnType<Model['getStreamedResponse']>extends AsyncIterable<infer Event>?Event:never,void,unknown> {
        const result = response();
        yield { type: 'output_text_delta', delta: JSON.stringify(f.plan) };
        yield {
          type: 'response_done',
          response: {
            id: result.responseId ?? 'resp_protocol',
            output: [{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(f.plan)}]}],
            usage: { requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          },
        };
      },
    };
  }
  const driver: MissionScenarioDriver & { close(): Promise<void> } = {
    mode: options.mode,
    capabilities: [
      'supplier_protocol',
      'negotiation',
      'clock',
      'channels',
      'arabic_voice_protocol',
      'founder_approval',
      'payment_protocol',
      'webhook_protocol',
      'dual_extraction',
      'store_protocol',
      'untrusted_attachment',
      'knowledge',
      'checkpoint_restart',
    ],
    sourceFiles: [source],
    create: async scenario => (await fixture(scenario)).scope,
    services: async (scope, _scenario, observe) => {
      const f = states.get(String(scope.missionId));
      if (!f) throw new Error('Scenario fixture unavailable');
      f.observe = observe;
      return createModelServices(
        scope,
        providerToolRegistry,
        async () => {
          throw new Error('Unexpected unconstrained protocol specialist dispatch');
        },
        options.mode === 'test_protocol' ? () => {f.observe({kind:'sdk_model_constructed',at:new Date().toISOString(),requestHash:fingerprint(f.plan),responseHash:null,provider:'openai',synthetic:true});return scriptedModel(f);} : undefined,
      );
    },
    advance: async (scope, scenario, turn) => {
      const f = states.get(String(scope.missionId));
      if (!f) throw new Error('Scenario fixture unavailable');
      if (turn > 0) return { done: true, eventType: 'scenario.continuation', payload: { synthetic: true,scenarioId:scenario.id } };
      switch (scenario.id) {
        case 'A1':
          await withRole('founder_role', scope, c => c.query("select public.transition_mission($1,'paused')", [scope.missionId]));
          await send(f);
          break;
        case 'A2':
          await withRole('founder_role', scope, c => c.query('select public.revoke_mandate($1,$2)', [scope.missionId, f.outreach]));
          await send(f);
          break;
        case 'S4':
        case 'A3':
        case 'A4':
        case 'A8':
        case 'A11':
        case 'A13':
        case 'A19': {
          f.fault =
            scenario.id === 'A3'
              ? 'capture_timeout'
              : scenario.id === 'A8'
                ? 'payee_change'
                : scenario.id === 'A11'
                  ? 'lookalike_link'
                  : scenario.id === 'A13'
                    ? 'capture_declined'
                    : 'none';
          const paid = await payment(f);
          if (scenario.id === 'A3' || scenario.id === 'A4') await reconcileProviderPayments(scope, f.transport);
          if (scenario.id === 'A13')
            f.plan.commitments = [
              {
                party: f.party,
                direction: 'owed_to_us',
                description: 'Synthetic sample payment failed; obtain alternate payment plan',
                dueAt: new Date(Date.now() + 86400000).toISOString(),
                evidenceIds: [],
              },
            ];
          f.summary = paid
            ? 'Sandbox protocol capture confirmed by the actual payment boundary.'
            : 'No completion inferred; the actual protocol result is recorded.';
          break;
        }
        case 'A6':
          f.fault = 'message_missing_receipt';
          await send(f);
          break;
        case 'A9':
          await send(f, 'The founder budget ceiling is SAR 10000.');
          break;
        case 'A17':
          f.summary = 'The category profile has not established compliant external prerequisites; compliance remains below R5.';
          break;
        default:
          throw new ScenarioBlocked(`Built-in protocol trajectory ${scenario.id} is not implemented yet; no scenario pass is inferred`);
      }
      f.plan.founderMessage = f.summary;
      return { done: scenario.id !== 'S4', eventType: 'scenario.protocol_observed', payload: { synthetic: true, scenarioId: scenario.id } };
    },
    close: async () => {
      await closeDatabasePools();
      process.env = prior;
      await db?.end();
      if (created) await admin.query(`drop database if exists ${database}with(force)`);
      await admin.end();
    },
  };
  return driver;
}
