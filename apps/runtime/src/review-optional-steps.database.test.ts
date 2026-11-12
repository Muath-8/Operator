import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { prepareOptionalStep } from './optional-steps.js';
import { createModelMeter } from './model-meter.js';
import { executeFounderCommand, ledgerVersion } from './commands.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = 'lo_review_optional_' + Date.now(),
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

describe('independent optional-step authority boundaries', () => {
  it('blocks execution of an already scheduled optional run after its Do approval source changes', async () => {
    await db.query('update private.platform_controls set effects_enabled=true where singleton');
    const scope = await fixture(),
      source = await evidence(scope),
      f = await offer(scope, [source]);
    await choose(scope, f.decision, 'do');
    const runId = String(
      (
        await db.query(
          "insert into public.runs(mission_id,role,brief,context_pack_hash,model_tier)values($1,'research',$2,'synthetic-dispatch-review','small')returning id",
          [scope.missionId, { maxTokens: 1000, playbook: { id: 'demand-validation', version: 1, step: 'landing_page' } }],
        )
      ).rows[0]?.id,
    );
    process.env.MODEL_PRICE_RATES_JSON = JSON.stringify({
      'optional-review-model': {
        inputPerMillion: 2,
        cachedInputPerMillion: 1,
        outputPerMillion: 8,
        source: 'https://example.test/review-price',
        observedAt: new Date().toISOString(),
      },
    });
    process.env.MODEL_FOUNDER_DAILY_CAP_MICRO_USD = '100000000';
    const meter = createModelMeter(scope, runId, 'optional-review-model'),
      key = `review:${randomUUID()}`;
    await meter.reserve(key, 300);
    await withRole('specialist_role', scope, c =>
      c.query("select public.append_evidence($1,'demand','experiment_source','claimed','{}','document','Synthetic correction',null,$2)", [
        scope.missionId,
        source,
      ]),
    );
    expect(
      (await db.query('select from public.stale_marks where mission_id=$1 and node_id=$2', [scope.missionId, f.doVersionId])).rowCount,
    ).toBeGreaterThan(0);
    let invoked = false;
    await expect(
      meter.dispatch(key, async () => {
        invoked = true;
        return 'synthetic network boundary';
      }),
    ).rejects.toThrow(/optional|approval|current|stale/);
    expect(invoked).toBe(false);
  });
  it('refuses an outstanding pre-Skip offer without new evidence and rolls its founder resolution back', async () => {
    const scope = await fixture(),
      first = await offer(scope),
      outstanding = await offer(scope);
    await choose(scope, first.decision, 'skip');
    await expect(choose(scope, outstanding.decision, 'do')).rejects.toThrow(/skipped/);
    expect((await db.query('select from public.decision_resolutions where decision_id=$1', [outstanding.decision])).rowCount).toBe(0);
    await expect(run(scope)).rejects.toThrow(/explicit Do/);
  });
  it('rechecks optional authority at both service preparation and its later paid dispatch lease', async () => {
    const scope = await fixture(),
      source = await evidence(scope),
      f = await offer(scope, [source]);
    await choose(scope, f.decision, 'do');
    const runId = String(
      (
        await db.query(
          "insert into public.runs(mission_id,role,brief,context_pack_hash,model_tier)values($1,'research',$2,'synthetic-service-lease','small')returning id",
          [scope.missionId, { playbook: { id: 'demand-validation', version: 1, step: 'landing_page' } }],
        )
      ).rows[0]?.id,
    );
    const account = randomUUID(),
      ref = randomUUID(),
      key = '1'.repeat(64);
    await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'openai','connected','{}')", [
      account,
      founder,
    ]);
    await db.query(
      'insert into private.provider_credentials(ref,mission_id,account_id,provider,sandbox_mode,encrypted)values($1,$2,$3,\'openai\',true,\'{"fixture":"no real provider credential"}\')',
      [ref, scope.missionId, account],
    );
    const start = (dispatchKey: string) =>
      withRole('policy_role', scope, c =>
        c.query("select public.start_provider_dispatch($1,$2,'openai_structured','openai',$3,null,$4,$5,'synthetic-model')", [
          scope.missionId,
          dispatchKey,
          ref,
          '2'.repeat(64),
          runId,
        ]),
      );
    await expect(start(key)).resolves.toBeDefined();
    await withRole('specialist_role', scope, c =>
      c.query(
        "select public.append_evidence($1,'demand','experiment_source','claimed','{}','document','Synthetic service source correction',null,$2)",
        [scope.missionId, source],
      ),
    );
    await expect(
      withRole('policy_role', scope, c => c.query('select public.lock_provider_dispatch($1,$2)', [scope.missionId, key])),
    ).rejects.toThrow(/optional/);
    await expect(start('3'.repeat(64))).rejects.toThrow(/optional/);
  });
  it('rechecks optional authority before retrying an already started external effect', async () => {
    const scope = await fixture(),
      source = await evidence(scope),
      f = await offer(scope, [source]);
    await choose(scope, f.decision, 'do');
    const runId = String(
      (
        await db.query(
          "insert into public.runs(mission_id,role,brief,context_pack_hash,model_tier)values($1,'research',$2,'synthetic-effect-lease','small')returning id",
          [scope.missionId, { playbook: { id: 'demand-validation', version: 1, step: 'landing_page' } }],
        )
      ).rows[0]?.id,
    );
    const approval = String(
        (
          await db.query(
            "insert into public.approvals(mission_id,decision_id,binding,token_hash,expires_at)values($1,$2,'{}',$3,clock_timestamp()+interval'1 hour')returning id",
            [scope.missionId, f.decision, randomUUID().replaceAll('-', '').repeat(2)],
          )
        ).rows[0]?.id,
      ),
      intent = {
        missionId: scope.missionId,
        taskId: runId,
        action: 'store_configure',
        effectClass: 'publish',
        counterpartyId: randomUUID(),
        mode: 'do',
        sandboxMode: true,
        idempotencyKey: randomUUID(),
      };
    const authorization = String(
      (
        await db.query(
          'insert into public.effect_authorizations(mission_id,intent,intent_hash,idempotency_key,approval_id,sandbox_mode)values($1,$2,$3,$4,$5,true)returning id',
          [scope.missionId, intent, '4'.repeat(64), intent.idempotencyKey, approval],
        )
      ).rows[0]?.id,
    );
    await db.query("insert into public.effect_states(mission_id,authorization_id,status)values($1,$2,'reserved')", [
      scope.missionId,
      authorization,
    ]);
    await expect(
      withRole('policy_role', scope, c => c.query('select public.begin_effect($1,$2)', [scope.missionId, authorization])),
    ).resolves.toBeDefined();
    await withRole('specialist_role', scope, c =>
      c.query(
        "select public.append_evidence($1,'demand','experiment_source','claimed','{}','document','Synthetic effect source correction',null,$2)",
        [scope.missionId, source],
      ),
    );
    await expect(
      withRole('policy_role', scope, c => c.query('select public.begin_effect($1,$2)', [scope.missionId, authorization])),
    ).rejects.toThrow(/optional/);
  });
  it('does not allow a selected Skip to execute optional work or a foreign source to renew it', async () => {
    const scope = await fixture(),
      f = await offer(scope);
    await choose(scope, f.decision, 'skip');
    await expect(run(scope)).rejects.toThrow(/explicit Do/);
    const foreign = await evidence(await fixture());
    await expect(prepareOptionalStep(scope, { ...input, evidenceIds: [foreign] })).rejects.toThrow(/cross-tenant|source/);
  });
  it('binds an approved effect to its immutable optional source run even when the command has a fresh task ID', async () => {
    const scope = await fixture(),
      source = await evidence(scope),
      f = await offer(scope, [source]);
    await choose(scope, f.decision, 'do');
    const runId = String(
        (
          await db.query(
            "insert into public.runs(mission_id,role,brief,context_pack_hash,model_tier)values($1,'commerce',$2,'synthetic-original-run','small')returning id",
            [scope.missionId, { playbook: { id: 'demand-validation', version: 1, step: 'landing_page' } }],
          )
        ).rows[0]?.id,
      ),
      party = randomUUID();
    await db.query(
      "insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'service','Synthetic optional effect destination')",
      [party, founder],
    );
    const version = await withRole('lead_role', scope, async c => {
      const artifact = String(
          (await c.query("select public.create_artifact($1,'note','demand','Synthetic optional output')id", [scope.missionId])).rows[0]?.id,
        ),
        v = String(
          (
            await c.query('select public.append_artifact_version($1,$2,$3,$4,$5,$6,$7,$8,$9)id', [
              scope.missionId,
              artifact,
              {
                summary: 'Synthetic optional output',
                paragraphs: ['Synthetic proposed content'],
                effectIntent: { action: 'store_configure', effectClass: 'publish', counterpartyId: party },
              },
              [],
              [],
              [],
              [],
              null,
              runId,
            ])
          ).rows[0]?.id,
        );
      await c.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, v]);
      return v;
    });
    const packet = {
        question: 'Approve exact synthetic output?',
        options: [
          {
            id: 'do',
            label: 'Approve synthetic output',
            artifactVersionIds: [version],
            evidenceIds: [],
            cost: null,
            timeDays: 0,
            consequences: 'Native dispatch boundary only',
          },
        ],
        approvedVersionIds: [version],
        recommendation: { optionId: 'do', reasons: ['Synthetic authorization fixture'] },
        staleImpact: [],
        defaultIfNoAnswer: { optionId: 'do', at: null, binding: false },
      },
      decision = await withRole('lead_role', scope, async c =>
        String(
          (await c.query("select public.propose_decision($1,'engagement',$2,'demand','publication')id", [scope.missionId, packet])).rows[0]
            ?.id,
        ),
      );
    await choose(scope, decision, 'do');
    const approval = (
        await db.query("select id from public.approvals where mission_id=$1 and binding->>'artifactVersionId'=$2", [
          scope.missionId,
          version,
        ])
      ).rows[0]?.id,
      intent = {
        missionId: scope.missionId,
        taskId: randomUUID(),
        artifactVersionId: version,
        action: 'store_configure',
        effectClass: 'publish',
        counterpartyId: party,
        mode: 'do',
        sandboxMode: true,
        idempotencyKey: randomUUID(),
      };
    const authorization = String(
      (
        await db.query(
          'insert into public.effect_authorizations(mission_id,intent,intent_hash,idempotency_key,approval_id,sandbox_mode)values($1,$2,$3,$4,$5,true)returning id',
          [scope.missionId, intent, '5'.repeat(64), intent.idempotencyKey, approval],
        )
      ).rows[0]?.id,
    );
    await db.query("insert into public.effect_states(mission_id,authorization_id,status)values($1,$2,'reserved')", [
      scope.missionId,
      authorization,
    ]);
    await withRole('specialist_role', scope, c =>
      c.query(
        "select public.append_evidence($1,'demand','experiment_source','claimed','{}','document','Synthetic optional approval correction',null,$2)",
        [scope.missionId, source],
      ),
    );
    await expect(
      withRole('policy_role', scope, c => c.query('select public.begin_effect($1,$2)', [scope.missionId, authorization])),
    ).rejects.toThrow(/optional|stale|approval/);
  });
});
