import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { executeFounderCommand, ledgerVersion } from './commands.js';
import { withRole, closeDatabasePools } from './database.js';
import { missionTick, type EngineServices } from './engine.js';
import { TaskBriefSchema, type TaskBrief } from './contracts.js';
import { ProviderStorage } from './provider-storage.js';
import { publishDemandPage, closeDemandPool } from './demand.js';
import type { JsonValue } from '@lo/state';
import { PayPalAdapter, evaluateChannel, outboundMessageSchema, type Transport } from '@lo/adapters';
import { connectProviderAccount } from './accounts.js';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_review_${Date.now()}`;
const admin = new Client({ connectionString: adminUrl });
let db: Client;
const priorEnv = { ...process.env };
const user = '00000000-0000-4000-8000-000000000001',
  mission = '20000000-0000-4000-8000-000000000001',
  party = '30000000-0000-4000-8000-000000000001',
  otherParty = '30000000-0000-4000-8000-000000000002',
  scope = { authUserId: user, missionId: mission };
const revision = () => withRole('founder_role', scope, client => ledgerVersion(client, mission));
const packet = (question: string, refs: string[], options: { id: string; label: string; versionIds: string[] }[]) => ({
  question,
  options: options.map(o => ({
    id: o.id,
    label: o.label,
    artifactVersionIds: o.versionIds,
    evidenceIds: [],
    cost: null,
    timeDays: 0,
    consequences: 'Review the exact frozen content',
  })),
  recommendation: { optionId: options[0]?.id ?? 'a', reasons: ['Synthetic review regression only'] },
  staleImpact: [],
  approvedVersionIds: refs,
  defaultIfNoAnswer: { optionId: options[0]?.id ?? 'a', at: null, binding: true },
});
async function version(content: Record<string, JsonValue>, outcome = 'brand') {
  return withRole('specialist_role', scope, async client => {
    const artifact = (
      await client.query("select public.create_artifact($1,'review_fixture',$2,'Synthetic review artifact')id", [mission, outcome])
    ).rows[0]?.id;
    const created = (await client.query('select public.append_artifact_version($1,$2,$3)id', [mission, artifact, content])).rows[0]?.id;
    await client.query("select public.set_artifact_status($1,$2,'proposed',null)", [mission, created]);
    return z.uuid().parse(created);
  });
}
async function propose(kind: string, gate: string, body: ReturnType<typeof packet>, outcome = 'brand') {
  return withRole('lead_role', scope, async client =>
    z
      .uuid()
      .parse(
        (await client.query('select public.propose_decision($1,$2,$3,$4,$5,null)id', [mission, kind, body, outcome, gate])).rows[0]?.id,
      ),
  );
}
async function approve(
  decisionId: string,
  optionId = 'a',
  mandateScope?: { ceiling: { amountMinor: number; currency: string }; count: number; expiresOn: string },
) {
  return executeFounderCommand(user, {
    kind: 'resolveDecision',
    missionId: mission,
    idempotencyKey: randomUUID(),
    seenLedgerVersion: await revision(),
    decisionId,
    optionId,
    response: 'approve',
    ...(mandateScope ? { mandateScope } : {}),
  });
}
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  db = new Client({ connectionString: url.href });
  await db.connect();
  const bootstrap = (await readFile(`${root}/supabase/tests/bootstrap.sql`, 'utf8')).replace(
    'create role authenticated nologin noinherit nobypassrls;',
    () =>
      "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
  );
  await db.query(bootstrap);
  for (const file of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(`${root}/supabase/migrations/${file}`, 'utf8'));
  await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
  await db.query('update private.platform_controls set effects_enabled=true');
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
  process.env['PROVIDER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  await closeDemandPool();
  process.env = priorEnv;
  await db?.end();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
});

describe('independent native runtime authority and state regressions', () => {
  it('FR-MIS-02/09 Discover becomes Launch through its selected brief; a reviewed Change pivots in place and cannot reinterpret existing money', async () => {
    const discovered = await withRole('founder_role', { authUserId: user }, async client =>
        z.uuid().parse((await client.query('select public.start_mission($1,true)id', [randomUUID()])).rows[0]?.id),
      ),
      local = { authUserId: user, missionId: discovered };
    const brief = async (goal: string, currency: string, previous: string | null = null) => {
      const ref = await withRole('specialist_role', local, async client => {
        const parent = z
            .uuid()
            .parse(
              (
                await client.query("select public.create_artifact($1,'mission_brief','brand','Synthetic mission direction')id", [
                  discovered,
                ])
              ).rows[0]?.id,
            ),
          versionId = z
            .uuid()
            .parse(
              (
                await client.query('select public.append_artifact_version($1,$2,$3)id', [
                  discovered,
                  parent,
                  { missionBrief: { type: 'launch', goalBrief: goal, currency, metadata: { title: goal, locale: 'en', market: 'SA' } } },
                ])
              ).rows[0]?.id,
            );
        await client.query("select public.set_artifact_status($1,$2,'proposed')", [discovered, versionId]);
        return versionId;
      });
      const body = {
        ...packet(`Approve goal: ${goal}`, [ref], [{ id: 'a', label: `Proceed with ${goal}`, versionIds: [ref] }]),
        ...(previous
          ? {
              impact: {
                decisionIds: [previous],
                artifactIds: [],
                commitmentIds: [],
                outcomes: ['brand', 'product', 'supply', 'commerce', 'compliance', 'demand'],
                cost: null,
                delayDays: 0,
              },
            }
          : {}),
      };
      const did = await withRole('lead_role', local, async client =>
        z
          .uuid()
          .parse(
            (
              await client.query("select public.propose_decision($1,$2,$3,'brand','mission_brief',$4)id", [
                discovered,
                previous ? 'change' : 'goal',
                body,
                previous,
              ])
            ).rows[0]?.id,
          ),
      );
      return { ref, did };
    };
    const resolve = async (did: string) =>
      executeFounderCommand(user, {
        kind: 'resolveDecision',
        missionId: discovered,
        idempotencyKey: randomUUID(),
        seenLedgerVersion: await withRole('founder_role', local, client => ledgerVersion(client, discovered)),
        decisionId: did,
        optionId: 'a',
        response: 'approve',
      });
    const launch = await brief('Synthetic approved launch opportunity', 'USD');
    await expect(
      withRole('specialist_role', local, client =>
        client.query('select public.apply_mission_brief($1,$2,$3)', [discovered, launch.did, launch.ref]),
      ),
    ).rejects.toThrow(/permission denied/);
    await resolve(launch.did);
    const first = await withRole('founder_role', local, client => client.query('select public.mission_snapshot($1)state', [discovered]));
    expect(first.rows[0]?.state).toMatchObject({
      status: 'active',
      mission: { id: discovered, type: 'launch', goal_brief: 'Synthetic approved launch opportunity', currency: 'USD' },
    });
    const pivot = await brief('Synthetic reviewed pivot opportunity', 'USD', launch.did);
    await resolve(pivot.did);
    const changed = await withRole('founder_role', local, client => client.query('select public.mission_snapshot($1)state', [discovered]));
    expect(changed.rows[0]?.state).toMatchObject({
      status: 'active',
      mission: { id: discovered, type: 'launch', goal_brief: 'Synthetic reviewed pivot opportunity', currency: 'USD' },
    });
    expect(changed.rows[0]?.state.mission_brief_revisions).toHaveLength(2);
    expect(changed.rows[0]?.state.decision_supersessions).toContainEqual(
      expect.objectContaining({ previous_id: launch.did, replacement_id: pivot.did }),
    );
    await db.query(
      "insert into public.money_ledger(mission_id,kind,amount_minor,currency,basis,envelope,sandbox_mode)values($1,'forecast',100,'USD','estimate','synthetic-review',true)",
      [discovered],
    );
    const repricing = await brief('Do not reinterpret the existing USD ledger', 'EUR', pivot.did);
    await expect(resolve(repricing.did)).rejects.toThrow(/currency|financial|reinterpret/);
    const retained = await withRole('founder_role', local, client => client.query('select public.mission_snapshot($1)state', [discovered]));
    expect(retained.rows[0]?.state.mission.currency).toBe('USD');
    expect(retained.rows[0]?.state.mission_brief_revisions).toHaveLength(2);
  });
  it('FR-MAN-01 a visual selection cannot activate a hidden outreach mandate', async () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const mandate = {
      type: 'outreach',
      scope: {
        actions: ['send_message'],
        effectClasses: ['communicate'],
        counterpartyIds: [party],
        channels: ['email'],
        purposes: ['introduction'],
        instrumentIds: [],
        maxNewContacts: 5,
      },
      ceilingPer: 0,
      ceilingTotal: 0,
      currency: 'SAR',
      expiresAt,
    };
    const ref = await version({ palette: ['#eee', '#111'], mandate }),
      decision = await propose(
        'selection',
        'direction',
        packet('Choose this visual direction', [ref], [{ id: 'a', label: 'Choose the palette', versionIds: [ref] }]),
      );
    await expect(approve(decision)).rejects.toThrow(/mandate|approval|scope/i);
    expect(
      (
        await withRole('founder_role', scope, client =>
          client.query('select id from public.mandates where mission_id=$1 and decision_id=$2', [mission, decision]),
        )
      ).rowCount,
    ).toBe(0);
  });
  it('I-1 a committed pause blocks preparatory PayPal writes as well as final capture', async () => {
    const fresh = await withRole('founder_role', { authUserId: user }, async client =>
        z.uuid().parse((await client.query('select public.start_mission($1,true)id', [randomUUID()])).rows[0]?.id),
      ),
      local = { authUserId: user, missionId: fresh };
    let orderPosts = 0;
    let ref = '';
    const transport: Transport = async request => {
      if (request.url.endsWith('/v1/oauth2/token'))
        return { status: 200, headers: {}, body: { access_token: 'SYNTHETIC_TEST_TOKEN', app_id: 'SYNTHETIC_TEST_APP' } };
      if (request.url.endsWith('/v2/checkout/orders')) {
        orderPosts++;
        return {
          status: 201,
          headers: {},
          body: {
            id: 'SYNTHETIC_REVIEW_ORDER',
            status: 'CREATED',
            intent: 'CAPTURE',
            purchase_units: [
              { reference_id: ref, amount: { currency_code: 'SAR', value: '1.00' }, payee: { merchant_id: 'PAYEEMERCHANT' } },
            ],
            links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=SYNTHETIC_REVIEW_ORDER' }],
          },
        };
      }
      throw new Error('No unplanned provider transport allowed');
    };
    const connected = await connectProviderAccount(
      local,
      {
        provider: 'paypal',
        mode: 'local',
        founderAttestsOwnership: true,
        credential: {
          clientId: 'SYNTHETIC_REVIEW_CLIENT',
          clientSecret: 'SYNTHETIC_REVIEW_SECRET',
          merchantId: 'SYNTHETICMERCHANT',
          webhookId: 'SYNTHETIC_WEBHOOK',
          verifiedPayees: { [party]: 'PAYEEMERCHANT' },
        },
      },
      transport,
    );
    expect(connected.ok).toBe(true);
    if (!connected.ok) throw new Error('Synthetic account fixture rejected');
    const payload = {
      payeeMerchantId: 'PAYEEMERCHANT',
      amountMinor: 100,
      currency: 'SAR',
      purpose: 'Synthetic review preparation',
      returnUrl: 'http://127.0.0.1:3000/api/payments/return',
      cancelUrl: 'http://127.0.0.1:3000/',
      intent: 'CAPTURE',
    };
    ref = await withRole('specialist_role', local, async client => {
      const parent = z
          .uuid()
          .parse(
            (await client.query("select public.create_artifact($1,'payment_proposal','supply','Synthetic preparatory order')id", [fresh]))
              .rows[0]?.id,
          ),
        versionId = z
          .uuid()
          .parse(
            (
              await client.query('select public.append_artifact_version($1,$2,$3)id', [
                fresh,
                parent,
                {
                  payload,
                  effectIntent: {
                    action: 'payment_capture',
                    effectClass: 'spend',
                    counterpartyId: party,
                    instrumentId: connected.value.accountId,
                    amountMinor: 100,
                    currency: 'SAR',
                    purpose: payload.purpose,
                  },
                },
              ])
            ).rows[0]?.id,
          );
      await client.query("select public.set_artifact_status($1,$2,'proposed')", [fresh, versionId]);
      return versionId;
    });
    const did = await withRole('lead_role', local, async client =>
      z
        .uuid()
        .parse(
          (
            await client.query("select public.propose_decision($1,'engagement',$2,'supply','payment')id", [
              fresh,
              {
                ...packet('Review this exact synthetic payment', [ref], [{ id: 'a', label: 'Approve SAR1', versionIds: [ref] }]),
                options: [
                  {
                    ...packet('', [], []).options[0],
                    id: 'a',
                    label: 'Approve SAR1',
                    artifactVersionIds: [ref],
                    evidenceIds: [],
                    cost: { amountMinor: 100, currency: 'SAR' },
                    timeDays: 0,
                    consequences: 'Synthetic review only',
                  },
                ],
              },
            ])
          ).rows[0]?.id,
        ),
    );
    await withRole('founder_role', local, async client => {
      await client.query("select public.resolve_decision($1,$2,'approve','a')", [fresh, did]);
      await client.query("select public.set_artifact_status($1,$2,'approved',$3)", [fresh, ref, did]);
      await client.query("select public.transition_mission($1,'paused')", [fresh]);
    });
    const storage = new ProviderStorage(local),
      connection = await storage.connection('paypal', connected.value.accountId),
      intent = await storage.buildIntent(
        randomUUID(),
        'payment_capture',
        'spend',
        {
          counterpartyId: party,
          artifactVersionId: ref,
          instrumentId: connected.value.accountId,
          amountMinor: 100,
          currency: 'SAR',
          purpose: payload.purpose,
        },
        [],
      ),
      source = await storage.artifact(ref),
      prepared = await new PayPalAdapter({ ...storage.dependencies(), transport }).prepare(source.payload, intent, connection.ref);
    expect(prepared.ok).toBe(false);
    expect(orderPosts).toBe(0);
  });
  it('FR-EASE-02 explicit question skip applies the recorded default once as founder input; roles and cross-mission answers stay denied', async () => {
    const fresh = await withRole('founder_role', { authUserId: user }, async client =>
        z.uuid().parse((await client.query('select public.start_mission($1,true)id', [randomUUID()])).rows[0]?.id),
      ),
      local = { authUserId: user, missionId: fresh },
      recommended = 'Start with the recorded synthetic target market';
    const question = await withRole('lead_role', local, async client =>
      z
        .uuid()
        .parse(
          (
            await client.query(
              "insert into public.mission_questions(mission_id,question,recommended_default,blocking,outcome)values($1,'Which target market should research start with?',$2,false,'brand')returning id",
              [fresh, recommended],
            )
          ).rows[0]?.id,
        ),
    );
    await expect(
      withRole('specialist_role', local, client =>
        client.query('select public.answer_mission_question($1,$2,$3,true)', [fresh, question, '']),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('founder_role', scope, client =>
        client.query('select public.answer_mission_question($1,$2,$3,true)', [mission, question, '']),
      ),
    ).rejects.toThrow();
    await expect(
      withRole('founder_role', local, client =>
        client.query('select public.answer_mission_question($1,$2,$3,false)', [fresh, question, ' ']),
      ),
    ).rejects.toThrow(/answer|skip/);
    const command = {
      kind: 'answerQuestion' as const,
      missionId: fresh,
      idempotencyKey: randomUUID(),
      seenLedgerVersion: await withRole('founder_role', local, client => ledgerVersion(client, fresh)),
      questionId: question,
      answer: 'An arbitrary skipped client string must not replace the recorded default',
      skipped: true,
    };
    await executeFounderCommand(user, command);
    await executeFounderCommand(user, command);
    const stored = await withRole('founder_role', local, client =>
      client.query(
        'select a.answer,a.skipped,e.trust,e.payload from public.question_answers a join public.evidence e on e.mission_id=a.mission_id and e.id=a.evidence_id where a.mission_id=$1 and a.question_id=$2',
        [fresh, question],
      ),
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]).toMatchObject({
      answer: recommended,
      skipped: true,
      trust: 'founder_confirmed',
      payload: { questionId: question, answer: recommended, appliedDefault: true },
    });
    await expect(
      withRole('founder_role', local, client =>
        client.query('select public.answer_mission_question($1,$2,$3,false)', [fresh, question, 'Replace the prior answer']),
      ),
    ).rejects.toThrow(/already answered/);
  });
  it('I-16 the voice database role cannot discover or decrypt payment provider credentials through SECURITY DEFINER helpers', async () => {
    const fresh = await withRole('founder_role', { authUserId: user }, async client =>
        z.uuid().parse((await client.query('select public.start_mission($1,true)id', [randomUUID()])).rows[0]?.id),
      ),
      local = { authUserId: user, missionId: fresh };
    const connected = await connectProviderAccount(
      local,
      {
        provider: 'paypal',
        mode: 'local',
        founderAttestsOwnership: true,
        credential: {
          clientId: 'SYNTHETIC_ROLE_CLIENT',
          clientSecret: 'SYNTHETIC_ROLE_SECRET',
          merchantId: 'SYNTHETICMERCHANT',
          webhookId: 'SYNTHETIC_WEBHOOK',
          verifiedPayees: { [party]: 'PAYEEMERCHANT' },
        },
      },
      async () => ({ status: 200, headers: {}, body: { access_token: 'SYNTHETIC_PROBE_TOKEN', app_id: 'SYNTHETIC_TEST_APP' } }),
    );
    if (!connected.ok) throw new Error('Synthetic provider fixture unavailable');
    const policy = new ProviderStorage(local),
      connection = await policy.connection('paypal', connected.value.accountId),
      voice = new ProviderStorage(local, 'voice_role');
    const attempts = await Promise.allSettled([
      voice.connection('paypal'),
      voice.resolve({ ref: connection.ref, provider: 'paypal', missionId: fresh, sandboxMode: true }),
    ]);
    expect(attempts.map(attempt => attempt.status)).toEqual(['rejected', 'rejected']);
  });
  it('FR-COM-07 real mission budget protection is derived even when a contact has no optional protected-budget override', async () => {
    const recorded = await new ProviderStorage(scope).contact(party),
      message = outboundMessageSchema.parse({
        channel: 'email',
        text: 'The founder budget ceiling is SAR30000.',
        translation: 'Synthetic confidentiality regression',
        language: 'en',
        purpose: 'follow_up',
        subject: 'Synthetic enquiry',
      });
    const policy = evaluateChannel(message, { ...recorded, email: 'synthetic@example.invalid', localHoursOpen: true });
    expect(policy.ok).toBe(false);
  });
  it('FR-COM-07 protected budget in actual WhatsApp template variables is rejected even when the summary text omits it', async () => {
    const recorded = await new ProviderStorage(scope).contact(party),
      message = outboundMessageSchema.parse({
        channel: 'whatsapp',
        text: 'Please reply to this enquiry.',
        translation: 'Synthetic confidentiality regression',
        language: 'en',
        purpose: 'follow_up',
        templateId: 'HX_SYNTHETIC_REVIEW',
        templateVariables: { '1': 'Our founder ceiling is SAR30000.' },
      }),
      policy = evaluateChannel(message, {
        ...recorded,
        localHoursOpen: true,
        phone: '+15555550123',
        phoneVerified: true,
        founderBudgetFigures: ['30000'],
        approvedTemplates: [{ id: 'HX_SYNTHETIC_REVIEW', language: 'en', purpose: 'follow_up' }],
      });
    expect(policy.ok).toBe(false);
  });
  it('FR-MAN-04 outreach count narrowing is persisted and SQL rejects scope beyond the selected mandate version', async () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString(),
      scopePayload = {
        actions: ['send_message'],
        effectClasses: ['communicate'],
        counterpartyIds: [party],
        channels: ['email'],
        purposes: ['introduction'],
        instrumentIds: [],
        maxNewContacts: 5,
      };
    const ref = await version({
        mandate: { type: 'outreach', scope: scopePayload, ceilingPer: 0, ceilingTotal: 0, currency: 'SAR', expiresAt },
      }),
      decision = await propose(
        'mandate',
        'outreach',
        packet(
          'Allow email introductions to this scoped shortlist',
          [ref],
          [{ id: 'a', label: 'Grant the reviewed outreach scope', versionIds: [ref] }],
        ),
      );
    await approve(decision, 'a', { ceiling: { amountMinor: 0, currency: 'SAR' }, count: 1, expiresOn: expiresAt.slice(0, 10) });
    const granted = await withRole('founder_role', scope, client =>
      client.query('select scope from public.mandates where mission_id=$1 and decision_id=$2', [mission, decision]),
    );
    expect(granted.rows[0]?.scope.maxNewContacts).toBe(1);
    await expect(
      withRole('founder_role', scope, client =>
        client.query("select public.grant_mandate($1,$2,'outreach',$3,0,0,$4)", [
          mission,
          decision,
          { ...scopePayload, counterpartyIds: [party, otherParty], maxNewContacts: 6 },
          expiresAt,
        ]),
      ),
    ).rejects.toThrow(/scope|selected|approval/i);
  });
  it('FR-DEC-08 Demand evaluates only the chosen frozen threshold alternative', async () => {
    const checklist = await withRole('specialist_role', scope, async client => {
        const artifact = z
            .uuid()
            .parse(
              (
                await client.query(
                  "select public.create_artifact($1,'compliance_checklist','compliance','Synthetic reviewed checklist')id",
                  [mission],
                )
              ).rows[0]?.id,
            ),
          ref = z
            .uuid()
            .parse(
              (
                await client.query('select public.append_artifact_version($1,$2,$3)id', [
                  mission,
                  artifact,
                  { prohibitedClaims: [], items: [] },
                ])
              ).rows[0]?.id,
            );
        await client.query("select public.set_artifact_status($1,$2,'proposed')", [mission, ref]);
        return ref;
      }),
      checklistDecision = await propose(
        'selection',
        'compliance_checklist',
        packet(
          'Approve the exact synthetic publication checklist',
          [checklist],
          [{ id: 'a', label: 'Use this synthetic checklist', versionIds: [checklist] }],
        ),
        'compliance',
      );
    await approve(checklistDecision);
    const endsAt = new Date(Date.now() + 86400000).toISOString(),
      first = await version({ threshold: { metric: 'distinct_consented_signups', target: 10, endsAt } }, 'demand'),
      second = await version({ threshold: { metric: 'distinct_consented_signups', target: 100, endsAt } }, 'demand');
    const thresholdDecision = await propose(
      'selection',
      'validation_threshold',
      packet(
        'Choose a predetermined validation target',
        [first, second],
        [
          { id: 'a', label: 'Ten consented sign-ups', versionIds: [first] },
          { id: 'b', label: 'One hundred consented sign-ups', versionIds: [second] },
        ],
      ),
      'demand',
    );
    await approve(thresholdDecision);
    const pageRef = await version(
        {
          contentReview: { checklistVersionId: checklist },
          title: 'Independent review sandbox',
          description: 'This is a test-only first-party validation page',
          consentText: 'I consent to joining this synthetic test waitlist',
          effectIntent: { action: 'marketing_publish', effectClass: 'publish', counterpartyId: party },
        },
        'demand',
      ),
      pageDecision = await propose(
        'engagement',
        'publication',
        packet('Publish this sandbox validation page', [pageRef], [{ id: 'a', label: 'Publish the reviewed page', versionIds: [pageRef] }]),
        'demand',
      );
    await approve(pageDecision);
    const storage = new ProviderStorage(scope),
      intent = await storage.buildIntent(
        randomUUID(),
        'marketing_publish',
        'publish',
        { counterpartyId: party, artifactVersionId: pageRef },
        [],
      ),
      published = await publishDemandPage(scope, intent, pageRef, thresholdDecision, 'review-selected-threshold');
    const measured = await withRole('policy_role', scope, client =>
      client.query('select public.measure_demand($1,$2)report', [mission, published['pageId']]),
    );
    expect(measured.rows[0]?.report).toMatchObject({ target: 10, count: 0, met: false });
  });
  it('FR-LEAD-05 a second tick cannot launch another writer for an unfinished outcome', async () => {
    const activeId = randomUUID();
    const task = (id: string): TaskBrief =>
      TaskBriefSchema.parse({
        id,
        missionId: mission,
        role: 'product',
        outcome: 'product',
        objective: 'Independent review of one product specification',
        constraints: [],
        budgetAuthority: [],
        deadline: new Date(Date.now() + 3600000).toISOString(),
        doneCriteria: ['Propose a source-linked specification'],
        evidenceRequired: ['current decision'],
        playbook: { id: 'test', version: 1, step: 'review', source: 'https://example.invalid/review' },
        maxToolCalls: 2,
        maxTokens: 256,
        tier: 'mid',
        requestedByFounder: false,
        overdueExposure: false,
        unblocks: [],
        parentRunId: null,
      });
    await withRole('lead_role', scope, client =>
      client.query(
        "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier,status)values($1,$2,'product',$3,'review-context','mid','scheduled')",
        [activeId, mission, task(activeId)],
      ),
    );
    let dispatches = 0;
    const services: EngineServices = {
      plan: async () => ({
        ok: true,
        value: {
          runs: [task(randomUUID())],
          decisions: [],
          questions: [],
          commitments: [],
          founderMessage: 'Attempt to dispatch a duplicate outcome writer',
          evidenceIds: [],
          focus: null,
        },
      }),
      run: async () => {
        throw new Error('No live model permitted');
      },
      review: async () => ({ accepted: false, defects: [] }),
      dispatch: async () => {
        dispatches++;
      },
    };
    const event = { id: randomUUID(), missionId: mission, authUserId: user, type: 'review.concurrent_outcome', payload: {} };
    let rejected = false;
    try {
      const result = await missionTick(event, { run: (_id, work) => work() }, services);
      rejected = result.started === 0;
    } catch (error: unknown) {
      rejected = error instanceof Error && /outcome|active|writer|running/i.test(error.message);
    }
    expect(rejected).toBe(true);
    expect(dispatches).toBe(0);
  });
  it('FR-PRD-04 only an explicit founder confirmation supplies sample evidence and changing its source stales it', async () => {
    const statement = 'I physically inspected and approved this sample.';
    const ref = await version(
        {
          founderConfirmation: {
            outcome: 'product',
            kind: 'physical_sample_approved',
            statement,
            payload: { sampleReference: 'Synthetic review sample' },
          },
        },
        'product',
      ),
      decision = await propose(
        'engagement',
        'physical_sample_approved',
        packet(statement, [ref], [{ id: 'a', label: statement, versionIds: [ref] }]),
        'product',
      );
    await expect(
      withRole('specialist_role', scope, client =>
        client.query('select public.confirm_founder_artifact($1,$2,$3)', [mission, decision, ref]),
      ),
    ).rejects.toThrow(/permission denied/);
    await approve(decision);
    const confirmed = await withRole('founder_role', scope, client =>
      client.query('select id,trust,payload from public.evidence where mission_id=$1 and source_reference=$2 order by kind', [
        mission,
        `founder-confirmation:${decision}:${ref}`,
      ]),
    );
    expect(confirmed.rowCount).toBe(2);
    expect(confirmed.rows.every(row => row.trust === 'founder_confirmed' && row.payload.artifactVersionId === ref)).toBe(true);
    const parent = (await db.query('select artifact_id from public.artifact_versions where id=$1', [ref])).rows[0]?.artifact_id;
    await withRole('specialist_role', scope, client =>
      client.query('select public.append_artifact_version($1,$2,$3)', [
        mission,
        parent,
        { note: 'The confirmed source changed; a new founder review is needed' },
      ]),
    );
    const stale = await withRole('founder_role', scope, client =>
      client.query('select node_id from public.stale_marks where mission_id=$1 and node_id=any($2::uuid[])', [
        mission,
        confirmed.rows.map(row => row.id),
      ]),
    );
    expect(stale.rowCount).toBe(2);
  });
  it('FR-MIS-09 launch cannot end a mission whose evidence-derived outcomes are below R5', async () => {
    const ref = await version({
        closingRecord: { terminal: 'launch', summary: 'Synthetic launch request that lacks the required launch evidence' },
      }),
      decision = await propose(
        'terminal',
        'terminal',
        packet('Approve launch only when the evidence supports it', [ref], [{ id: 'launch', label: 'Launch', versionIds: [ref] }]),
      );
    await expect(approve(decision, 'launch')).rejects.toThrow(/R5|launch requires|readiness/i);
    const status = await withRole('founder_role', scope, client => client.query('select public.mission_snapshot($1)state', [mission]));
    expect(status.rows[0]?.state.status).toBe('active');
  });
  it('FR-MIS-09 an explicit Stop ends the mission with exactly its selected closing-record version', async () => {
    const commitments = await withRole('founder_role', scope, client =>
        client.query(
          "select c.id,c.party_id,to_char(c.due_at at time zone'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')due_at from public.commitments c where c.mission_id=$1 and coalesce((select status from public.commitment_states s where s.commitment_id=c.id order by created_at desc,id desc limit 1),'open')not in('closed','cancelled')",
          [mission],
        ),
      ),
      openCommitments = commitments.rows.map(c => ({
        commitmentId: String(c.id),
        ownerId: c.party_id === null ? null : String(c.party_id),
        dueAt: String(c.due_at),
        recommendedAction: 'Founder reviews and handles this remaining synthetic obligation.',
      }));
    const stop = await version({
        closingRecord: {
          terminal: 'stop',
          summary: 'Founder stops this synthetic review mission; remaining obligations are listed.',
          openCommitments,
        },
      }),
      launch = await version({
        closingRecord: { terminal: 'launch', summary: 'Unselected alternative must not become the closing record', openCommitments },
      }),
      decision = await propose(
        'terminal',
        'terminal',
        packet(
          'Choose how to close this mission',
          [stop, launch],
          [
            { id: 'stop', label: 'Stop and retain the closing record', versionIds: [stop] },
            { id: 'launch', label: 'Launch', versionIds: [launch] },
          ],
        ),
      );
    await approve(decision, 'stop');
    const closed = await withRole('founder_role', scope, client =>
      client.query(
        'select status,terminal_decision_id,closing_record_version_id from public.mission_transitions where mission_id=$1 order by created_at desc,id desc limit 1',
        [mission],
      ),
    );
    expect(closed.rows[0]).toMatchObject({ status: 'ended', terminal_decision_id: decision, closing_record_version_id: stop });
  });
});
