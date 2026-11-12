import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { OUTCOMES, READINESS_RULES, type JsonValue, type Outcome } from '@lo/state';
import { executeFounderCommand, ledgerVersion } from './commands.js';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_finance_review_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  otherUser = randomUUID(),
  otherFounder = randomUUID(),
  priorEnv = { ...process.env };
let db: Client;
async function mission(other = false) {
  const id = randomUUID();
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,metadata)values($1,$2,'launch','Synthetic independent finance/launch review','SAR',true,$3)",
    [id, other ? otherFounder : founder, { budgetMinor: 10000, timeZone: 'UTC', locale: 'en', categoryProfileId: 'generic' }],
  );
  return { authUserId: other ? otherUser : user, missionId: id };
}
const packet = (refs: string[], option = 'a') => ({
  question: 'Review this exact synthetic source',
  options: [
    {
      id: option,
      label: 'Approve the frozen source',
      artifactVersionIds: refs,
      evidenceIds: [],
      cost: null,
      timeDays: 0,
      consequences: 'Synthetic regression only',
    },
  ],
  recommendation: { optionId: option, reasons: ['Review the actual source values'] },
  staleImpact: [],
  approvedVersionIds: refs,
  defaultIfNoAnswer: { optionId: option, at: null, binding: true },
});
async function propose(scope: ActorScope, kind: string, gate: string, refs: string[] = [], outcome: Outcome = 'commerce', option = 'a') {
  return withRole('lead_role', scope, async client =>
    z
      .uuid()
      .parse(
        (
          await client.query('select public.propose_decision($1,$2,$3,$4,$5)id', [
            scope.missionId,
            kind,
            {
              ...packet(refs, option),
              ...(kind === 'change'
                ? { impact: { decisionIds: [], artifactIds: [], commitmentIds: [], outcomes: [outcome], cost: null, delayDays: 0 } }
                : {}),
            },
            outcome,
            gate,
          ])
        ).rows[0]?.id,
      ),
  );
}
async function resolve(scope: ActorScope, id: string, option = 'a') {
  return executeFounderCommand(scope.authUserId, {
    kind: 'resolveDecision',
    missionId: z.uuid().parse(scope.missionId),
    idempotencyKey: randomUUID(),
    seenLedgerVersion: await withRole('founder_role', scope, client => ledgerVersion(client, z.uuid().parse(scope.missionId))),
    decisionId: id,
    optionId: option,
    response: 'approve',
  });
}
async function version(scope: ActorScope, content: Record<string, JsonValue>, type = 'note', outcome: Outcome = 'commerce') {
  return withRole('specialist_role', scope, async client => {
    const a = z
        .uuid()
        .parse(
          (
            await client.query('select public.create_artifact($1,$2,$3,$4)id', [
              scope.missionId,
              type,
              outcome,
              'Synthetic independent review source',
            ])
          ).rows[0]?.id,
        ),
      v = z
        .uuid()
        .parse((await client.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, a, content])).rows[0]?.id);
    await client.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, v]);
    return v;
  });
}
async function approved(
  scope: ActorScope,
  content: Record<string, JsonValue>,
  kind = 'selection',
  gate = 'source',
  type = 'note',
  outcome: Outcome = 'commerce',
) {
  const ref = await version(scope, content, type, outcome),
    did = await propose(scope, kind, gate, [ref], outcome);
  await resolve(scope, did);
  return { ref, did };
}
async function fact(scope: ActorScope, outcome: Outcome, kind: string, payload: Record<string, JsonValue> = { fixture: true }) {
  return withRole('founder_role', scope, async client =>
    z
      .uuid()
      .parse(
        (
          await client.query(
            "select public.append_evidence($1,$2,$3,'founder_confirmed',$4,'founder','Synthetic review declaration; no real provider achievement')id",
            [scope.missionId, outcome, kind, payload],
          )
        ).rows[0]?.id,
      ),
  );
}
const plan = (evidenceId: string, amountMinor = 1000) => ({
  financialPlan: {
    currency: 'SAR',
    envelopes: [{ name: 'production', amountMinor: 5000 }],
    forecastToFirstRestock: [{ envelope: 'production', amountMinor, basis: 'accepted', evidenceIds: [evidenceId] }],
  },
});
async function launchSources(pricingAmount = 1000) {
  const scope = await mission();
  // Synthetic founder declarations exercise the real gate evaluator. They are
  // not measurements, provider receipts, domain review or release evidence.
  for (const outcome of OUTCOMES) {
    const kinds = new Set<string>(),
      gates = new Set<string>();
    for (const rule of READINESS_RULES.filter(r => r.outcome === outcome)) {
      for (const kind of rule.evidenceKinds)
        if (!kinds.has(kind)) {
          kinds.add(kind);
          await fact(scope, outcome, kind);
        }
      for (const gate of rule.decisionGates)
        if (!gates.has(gate)) {
          gates.add(gate);
          const id = await propose(scope, 'selection', gate, [], outcome);
          await resolve(scope, id);
        }
    }
  }
  await approved(
    scope,
    {
      founderConfirmation: {
        outcome: 'supply',
        kind: 'sourcing_risk_accepted',
        statement: 'For this synthetic test only, explicitly accept sourcing sequence risk.',
        payload: { riskAccepted: true },
      },
    },
    'engagement',
    'sourcing_risk_accepted',
    'founder_confirmation',
    'supply',
  );
  const quote = await fact(scope, 'supply', 'accepted_quote', { fixture: true, accepted: true, unitPriceMinor: 1000, currency: 'SAR' });
  await approved(scope, plan(quote), 'constraint', 'financial_plan', 'financial_plan');
  const pricing = await approved(
    scope,
    {
      pricing: {
        currency: 'SAR',
        priceMinor: 2000,
        landedCostMinor: pricingAmount,
        costs: [{ amountMinor: pricingAmount, basis: 'accepted', evidenceIds: [quote] }],
        scenarios: [
          { priceMinor: 2000, fixedMinor: 0 },
          { priceMinor: 2500, fixedMinor: 0 },
        ],
      },
    },
    'selection',
    'pricing',
    'pricing',
  );
  const record = await withRole('lead_role', scope, async client =>
      z.uuid().parse((await client.query('select public.prepare_launch_record($1)id', [scope.missionId])).rows[0]?.id),
    ),
    recordDecision = await propose(scope, 'selection', 'launch_record', [record]);
  await resolve(scope, recordDecision);
  return { scope, quote, pricing: pricing.ref, record };
}
async function launch(source: Awaited<ReturnType<typeof launchSources>>) {
  const closing = await version(
    source.scope,
    {
      closingRecord: {
        terminal: 'launch',
        summary: 'Synthetic gate review; this does not claim a real business launch.',
        openCommitments: [],
        launch: { pricingVersionId: source.pricing, launchRecordVersionId: source.record, accountOwnershipConfirmedIds: [] },
      },
    },
    'closing_record',
  );
  const did = await propose(source.scope, 'terminal', 'terminal', [closing], 'commerce', 'launch');
  return resolve(source.scope, did, 'launch');
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
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2),($3,$4)', [founder, user, otherFounder, otherUser]);
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = priorEnv;
  await db?.end();
  await admin.query(`drop database if exists ${name}with(force)`);
  await admin.end();
});
describe('independent BRD17.2 financial truth, terminal freshness and presence review', () => {
  it('private SECURITY DEFINER helpers cannot disclose another tenant budget or financial version', async () => {
    const scope = await mission(),
      foreign = await mission(true);
    for (const sql of ['select private.current_budget_ceiling($1)', 'select private.current_financial_version($1)'])
      await expect(withRole('founder_role', scope, client => client.query(sql, [foreign.missionId]))).rejects.toThrow(
        /permission denied|mission denied/,
      );
    await expect(
      withRole('founder_role', scope, client => client.query('select public.current_financial_plan($1)', [foreign.missionId])),
    ).rejects.toThrow(/mission denied/);
  });
  it('accepted forecast amounts must match the current quote rather than merely cite its trusted UUID', async () => {
    const scope = await mission(),
      quote = await fact(scope, 'supply', 'accepted_quote', { accepted: true, unitPriceMinor: 1000, currency: 'SAR' }),
      ref = await version(scope, plan(quote, 1), 'financial_plan'),
      did = await propose(scope, 'constraint', 'financial_plan', [ref]);
    await expect(resolve(scope, did)).rejects.toThrow(/amount|currency|quote/);
    expect((await db.query('select id from public.financial_plans where mission_id=$1', [scope.missionId])).rows).toHaveLength(0);
  });
  it('forecast aggregates cannot overflow the shared safe integer money contract', async () => {
    const scope = await mission(),
      ref = await version(
        scope,
        {
          financialPlan: {
            currency: 'SAR',
            envelopes: [{ name: 'production', amountMinor: 5000 }],
            forecastToFirstRestock: Array.from({ length: 100 }, () => ({
              envelope: 'production',
              amountMinor: 999999999999999,
              basis: 'estimate',
              evidenceIds: [],
            })),
          },
        },
        'financial_plan',
      ),
      did = await propose(scope, 'constraint', 'financial_plan', [ref]);
    await expect(resolve(scope, did)).rejects.toThrow(/forecast|integer|range|safe/i);
    expect((await db.query('select id from public.financial_plans where mission_id=$1', [scope.missionId])).rows).toHaveLength(0);
  });
  it('a same-currency founder goal-budget cut cannot leave the older financial plan authorizing a higher ceiling', async () => {
    const scope = await mission(),
      quote = await fact(scope, 'supply', 'accepted_quote', { accepted: true, unitPriceMinor: 1000, currency: 'SAR' });
    await approved(scope, plan(quote), 'constraint', 'financial_plan', 'financial_plan');
    await approved(
      scope,
      {
        missionBrief: {
          type: 'launch',
          goalBrief: 'Synthetic revised goal with a smaller approved budget',
          currency: 'SAR',
          metadata: { budgetMinor: 1000 },
        },
      },
      'change',
      'mission_brief',
      'mission_goal',
    );
    let safe = false;
    try {
      const row = (await db.query('select private.current_budget_ceiling($1)::text ceiling', [scope.missionId])).rows[0];
      safe = BigInt(z.string().parse(row?.ceiling)) <= 1000n;
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message.startsWith('needs_approval:'))) throw error;
      safe = true;
    }
    expect(safe).toBe(true);
  });
  it('a fully evidenced synthetic mission can launch using the exact fresh canonical record and accepted pricing', async () => {
    const source = await launchSources();
    expect(
      (
        await withRole('founder_role', source.scope, client =>
          client.query('select level from public.readiness($1)', [source.scope.missionId]),
        )
      ).rows.every(r => r.level === 5),
    ).toBe(true);
    await launch(source);
    expect(
      (
        await db.query('select status from public.mission_transitions where mission_id=$1 order by created_at desc,id desc limit 1', [
          source.scope.missionId,
        ])
      ).rows[0]?.status,
    ).toBe('ended');
  });
  it('a SAR1000 accepted quote cannot justify SAR1 landed cost even when the cost sum is internally consistent', async () => {
    const source = await launchSources(1);
    await expect(launch(source)).rejects.toThrow(/amount|currency|source/);
  });
  it('a new unrelated business decision invalidates the generated record', async () => {
    const source = await launchSources();
    await propose(source.scope, 'selection', 'new_supplier_terms', [], 'supply');
    await expect(launch(source)).rejects.toThrow(/decisions changed|regenerate|source/);
  });
  it('an unrelated artifact cannot evade record freshness by carrying an empty closingRecord key', async () => {
    const source = await launchSources();
    await version(
      source.scope,
      { summary: 'A new unrelated business draft', paragraphs: ['Synthetic revision'], closingRecord: {} },
      'note',
    );
    await expect(launch(source)).rejects.toThrow(/artifacts changed|regenerate/);
  });
  it('inactive-to-active resumption credits no elapsed idle time, including a duplicate counter window', async () => {
    const scope = await mission();
    await withRole('founder_role', scope, client => client.query('select public.record_founder_presence($1,false)', [scope.missionId]));
    // TEST ONLY historical counter window; no application role can mutate it.
    await db.query('alter table public.founder_presence disable trigger immutable_row');
    await db.query(
      "update public.founder_presence set created_at=clock_timestamp()-interval'35 seconds',window_id=window_id-10000 where mission_id=$1",
      [scope.missionId],
    );
    await db.query('alter table public.founder_presence enable trigger immutable_row');
    await withRole('founder_role', scope, client => client.query('select public.record_founder_presence($1,true)', [scope.missionId]));
    const measured = await withRole(
      'founder_role',
      scope,
      async client => (await client.query('select public.mission_engagement($1)state', [scope.missionId])).rows[0]?.state,
    );
    expect(measured.activeSeconds).toBe(0);
  });
});
