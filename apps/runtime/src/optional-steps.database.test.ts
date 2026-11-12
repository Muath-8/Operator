import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { prepareOptionalStep } from './optional-steps.js';
import { executeFounderCommand, ledgerVersion } from './commands.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = 'lo_optional_' + Date.now(),
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  prior = { ...process.env };
let db: Client;
beforeAll(async () => {
  await admin.connect();
  await admin.query('create database ' + name);
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  db = new Client({ connectionString: url.href });
  await db.connect();
  await db.query(
    (await readFile(root + '/supabase/tests/bootstrap.sql', 'utf8')).replace(
      'create role authenticated nologin noinherit nobypassrls;',
      () =>
        "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
    ),
  );
  for (const file of (await readdir(root + '/supabase/migrations')).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(root + '/supabase/migrations/' + file, 'utf8'));
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
  process.env.DATABASE_URL = url.href;
  process.env.LO_EXECUTION_MODE = 'local';
  process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
  process.env.PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query('drop database if exists ' + name + ' with(force)');
  await admin.end();
});
async function fixture() {
  const scope = { authUserId: user, missionId: randomUUID() };
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode)values($1,$2,'launch','Synthetic optional experiment test','SAR',true)",
    [scope.missionId, founder],
  );
  return scope;
}
const input = {
  outcome: 'demand',
  title: 'Optional landing-page experiment',
  playbookId: 'demand-validation',
  playbookVersion: 1,
  stepId: 'landing_page',
  cost: { amountMinor: 1000, currency: 'SAR' },
  risk: 'A test may produce no validated demand.',
  evidenceIds: [],
};
async function evidence(scope: ActorScope) {
  return withRole('specialist_role', scope, async c =>
    String(
      (
        await c.query("select public.append_evidence($1,'demand','experiment_source','claimed','{}','document',$2)id", [
          scope.missionId,
          randomUUID(),
        ])
      ).rows[0]?.id,
    ),
  );
}
async function offer(scope: ActorScope, refs: string[] = []) {
  const versions = await prepareOptionalStep(scope, { ...input, evidenceIds: refs });
  return { ...versions, decision: await decision(scope, versions) };
}
async function decision(
  scope: ActorScope,
  versions: { doVersionId: string; skipVersionId: string },
  override: Record<string, unknown> = {},
) {
  const packet = {
    question: 'Run this optional experiment?',
    options: [
      {
        id: 'do',
        label: 'Do',
        artifactVersionIds: [versions.doVersionId],
        evidenceIds: [],
        cost: { amountMinor: 1000, currency: 'SAR' },
        timeDays: 1,
        consequences: 'Run the bounded experiment',
      },
      {
        id: 'skip',
        label: 'Skip',
        artifactVersionIds: [versions.skipVersionId],
        evidenceIds: [],
        cost: null,
        timeDays: 0,
        consequences: 'No experiment; readiness remains evidence-based',
      },
    ],
    recommendation: { optionId: 'skip', reasons: ['Explicit choice required'] },
    approvedVersionIds: [versions.doVersionId, versions.skipVersionId],
    staleImpact: [],
    defaultIfNoAnswer: { optionId: 'skip', at: null, binding: false },
  };
  return withRole('lead_role', scope, async c =>
    String(
      (
        await c.query("select public.propose_decision($1,'selection',$2,'demand','optional_step')id", [
          scope.missionId,
          { ...packet, ...override },
        ])
      ).rows[0]?.id,
    ),
  );
}
async function choose(scope: ActorScope, id: string, optionId: 'do' | 'skip') {
  return executeFounderCommand(user, {
    kind: 'resolveDecision',
    missionId: String(scope.missionId),
    idempotencyKey: randomUUID(),
    seenLedgerVersion: await withRole('founder_role', scope, c => ledgerVersion(c, String(scope.missionId))),
    decisionId: id,
    response: 'choose',
    optionId,
  });
}
async function run(scope: ActorScope) {
  return db.query(
    "insert into public.runs(mission_id,role,brief,context_pack_hash,model_tier)values($1,'demand',$2,'synthetic-test','small')",
    [scope.missionId, { playbook: { id: 'demand-validation', version: 1, step: 'landing_page' } }],
  );
}
describe('FR-EASE-11 explicit optional choice and no-repeat guard', () => {
  it('rejects missing or mandatory steps, malformed risk/cost and foreign evidence before producing choices', async () => {
    const scope = await fixture(),
      foreign = await evidence(await fixture());
    for (const patch of [
      { stepId: 'absent' },
      { risk: '' },
      { cost: { amountMinor: -1, currency: 'SAR' } },
      { cost: { amountMinor: 1, currency: 'USD' } },
      { evidenceIds: [foreign] },
    ])
      await expect(prepareOptionalStep(scope, { ...input, ...patch })).rejects.toThrow();
    expect((await db.query('select from public.artifacts where mission_id=$1', [scope.missionId])).rowCount).toBe(0);
  });
  it('requires matched Do/Skip with an exact visible price, and rejects a mandatory playbook step', async () => {
    const scope = await fixture(),
      versions = await prepareOptionalStep(scope, input);
    await expect(
      decision(scope, versions, {
        recommendation: { optionId: 'do', reasons: ['Synthetic missing Skip'] },
        defaultIfNoAnswer: { optionId: 'do', at: null, binding: false },
        options: [
          {
            id: 'do',
            label: 'Do',
            artifactVersionIds: [versions.doVersionId],
            evidenceIds: [],
            cost: { amountMinor: 1000, currency: 'SAR' },
            timeDays: 1,
            consequences: 'Synthetic missing Skip',
          },
        ],
      }),
    ).rejects.toThrow(/both Do and Skip/);
    const mandatory = (
      await db.query(
        "select b.id,b.version,s->>'id' step from public.playbooks b cross join lateral jsonb_array_elements(b.content->'steps')s where s->'optional'='false'::jsonb limit 1",
      )
    ).rows[0];
    if (!mandatory) throw new Error('Expected a real mandatory playbook step');
    await expect(
      prepareOptionalStep(scope, { ...input, playbookId: mandatory.id, playbookVersion: mandatory.version, stepId: mandatory.step }),
    ).rejects.toThrow(/optional playbook step/);
  });
  it('allows the founder to explicitly revisit a skipped step while preventing an autonomous repeat', async () => {
    const scope = await fixture(),
      f = await offer(scope);
    await choose(scope, f.decision, 'skip');
    await expect(prepareOptionalStep(scope, input)).rejects.toThrow(/skipped/);
    await executeFounderCommand(user, {
      kind: 'requestChange',
      missionId: String(scope.missionId),
      idempotencyKey: randomUUID(),
      seenLedgerVersion: await withRole('founder_role', scope, c => ledgerVersion(c, String(scope.missionId))),
      decisionId: f.decision,
    });
    await expect(offer(scope)).resolves.toHaveProperty('decision');
  });
  it('requires an explicit Do selection before scheduling and preserves Skip without reoffering unchanged evidence', async () => {
    const scope = await fixture(),
      f = await offer(scope);
    await expect(run(scope)).rejects.toThrow(/explicit Do/);
    await choose(scope, f.decision, 'skip');
    expect((await db.query('select choice from public.optional_step_choices where mission_id=$1', [scope.missionId])).rows).toEqual([
      { choice: 'skip' },
    ]);
    await expect(run(scope)).rejects.toThrow(/explicit Do/);
    await expect(prepareOptionalStep(scope, input)).rejects.toThrow(/skipped/);
    await expect(decision(scope, f)).rejects.toThrow(/skipped/);
    expect((await db.query('select from public.runs where mission_id=$1', [scope.missionId])).rowCount).toBe(0);
  });
  it('allows a new sourced offer after Skip, and an approved Do unlocks only its exact current version', async () => {
    const scope = await fixture(),
      f = await offer(scope);
    await choose(scope, f.decision, 'skip');
    const source = await evidence(scope),
      next = await offer(scope, [source]);
    await choose(scope, next.decision, 'do');
    await expect(run(scope)).resolves.toBeDefined();
    await withRole('specialist_role', scope, c =>
      c.query("select public.append_evidence($1,'demand','experiment_source','claimed','{}','document','Synthetic correction',null,$2)", [
        scope.missionId,
        source,
      ]),
    );
    await expect(run(scope)).rejects.toThrow(/current explicit Do/);
  });
  it('denies a nonselected version, cross-tenant calls and direct choice mutation', async () => {
    const scope = await fixture(),
      f = await offer(scope);
    await withRole('founder_role', scope, c =>
      c.query("select public.resolve_decision($1,$2,'choose','skip')", [scope.missionId, f.decision]),
    );
    await expect(
      withRole('founder_role', scope, c =>
        c.query('select public.apply_optional_step_choice($1,$2,$3)', [scope.missionId, f.decision, f.doVersionId]),
      ),
    ).rejects.toThrow(/selected explicit/);
    await expect(
      withRole('specialist_role', scope, c =>
        c.query('select public.apply_optional_step_choice($1,$2,$3)', [scope.missionId, f.decision, f.skipVersionId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('founder_role', { ...scope, authUserId: randomUUID() }, c =>
        c.query('select public.apply_optional_step_choice($1,$2,$3)', [scope.missionId, f.decision, f.skipVersionId]),
      ),
    ).rejects.toThrow(/mission denied/);
    await withRole('founder_role', scope, async c => {
      await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, f.skipVersionId, f.decision]);
      await c.query('select public.apply_optional_step_choice($1,$2,$3)', [scope.missionId, f.decision, f.skipVersionId]);
    });
    await expect(db.query("update public.optional_step_choices set choice='do'where mission_id=$1", [scope.missionId])).rejects.toThrow(
      /append.only/,
    );
  });
});
