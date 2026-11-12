import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';
import { executeFounderCommand, ledgerVersion } from './commands.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const admin = new Client({ connectionString: adminUrl }),
  name = `lo_metrics_${Date.now()}`;
let db: Client;
const prior = { ...process.env };
const user = '00000000-0000-4000-8000-000000000001',
  mission = '20000000-0000-4000-8000-000000000001',
  scope = { authUserId: user, missionId: mission };
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
  process.env.DATABASE_URL = url.href;
  process.env.LO_EXECUTION_MODE = 'local';
  process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
  process.env.PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
});

async function proposal(
  content: object,
  outcome = 'commerce',
  gate = 'shipping_rate_confirmed',
  kind = 'engagement',
  type = 'founder_confirmation',
) {
  const p = await withRole('lead_role', scope, async d => {
    const a = (await d.query('select public.create_artifact($1,$2,$3,$4)id', [mission, type, outcome, 'Synthetic source proof'])).rows[0]
      ?.id;
    const version = (await d.query('select public.append_artifact_version($1,$2,$3)id', [mission, a, content])).rows[0]?.id as string;
    await d.query("select public.set_artifact_status($1,$2,'proposed')", [mission, version]);
    const packet = {
      question: 'Confirm the returned source?',
      options: [
        {
          id: 'yes',
          label: 'Confirm exact source',
          artifactVersionIds: [version],
          evidenceIds: [],
          cost: null,
          timeDays: 0,
          consequences: 'Record explicit founder evidence',
        },
      ],
      recommendation: { optionId: 'yes', reasons: ['Review actual source'] },
      approvedVersionIds: [version],
      staleImpact: [],
      defaultIfNoAnswer: { optionId: 'yes', at: null, binding: true },
    };
    const decision = (await d.query('select public.propose_decision($1,$2,$3,$4,$5)id', [mission, kind, packet, outcome, gate])).rows[0]
      ?.id as string;
    return { version, decision };
  });
  return {
    ...p,
    approve: async () =>
      executeFounderCommand(user, {
        kind: 'resolveDecision',
        missionId: mission,
        idempotencyKey: randomUUID(),
        seenLedgerVersion: await withRole('founder_role', scope, d => ledgerVersion(d, mission)),
        decisionId: p.decision,
        response: 'approve',
        optionId: 'yes',
      }),
  };
}
async function evidence() {
  return withRole(
    'founder_role',
    scope,
    async d =>
      (
        await d.query(
          "select public.append_evidence($1,'commerce','returned_document','founder_confirmed',$2,'document','synthetic-test')id",
          [mission, { summary: 'Synthetic returned source' }],
        )
      ).rows[0]?.id as string,
  );
}

describe('FR-MET-01 FR-MET-02 business measurements', () => {
  it('records the immutable first estimate and accepted source amount through actual founder command', async () => {
    const line = await withRole(
      'specialist_role',
      scope,
      async d =>
        (await d.query("select public.record_cost_estimate($1,'component','First component estimate',200,'SAR')id", [mission])).rows[0]?.id,
    );
    await expect(
      withRole('specialist_role', scope, d =>
        d.query("select public.record_cost_estimate($1,'component','First component estimate',201,'SAR')", [mission]),
      ),
    ).rejects.toThrow(/immutable/);
    const source = await withRole(
      'founder_role',
      scope,
      async d =>
        (
          await d.query(
            "select public.append_evidence($1,'supply','accepted_quote','founder_confirmed',$2,'document','synthetic-accepted-source')id",
            [mission, { accepted: true, unitPriceMinor: 120, currency: 'SAR' }],
          )
        ).rows[0]?.id,
    );
    const p = await proposal(
      { costAcceptance: { costLineId: line, evidenceId: source, quantity: 2 } },
      'commerce',
      'accepted_cost',
      'selection',
      'cost_acceptance',
    );
    await p.approve();
    const report = await withRole(
      'founder_role',
      scope,
      async d => (await d.query('select public.mission_business_metrics($1)report', [mission])).rows[0]?.report,
    );
    expect(report.estimateAccuracy).toEqual([
      expect.objectContaining({ firstEstimateMinor: 200, acceptedMinor: 240, relativeError: 0.2, sourceEvidenceId: source }),
    ]);
    expect(report.sandboxMode).toBe(true);
    expect(report.modeCEffortMinutes).toBeNull();
    expect(report.verifiedSupplierResponseRate).toBeNull();
    expect(report.readinessMilestones.length).toBeGreaterThan(0);
    expect(report.readinessHistoryCompleteFrom).toBeTruthy();
  });
  it('rejects model amounts and low-trust acceptance without binding a decision', async () => {
    const line = (await db.query('select id from public.cost_estimates where mission_id=$1', [mission])).rows[0]?.id;
    const source = await withRole(
      'specialist_role',
      scope,
      async d =>
        (
          await d.query("select public.append_evidence($1,'supply','quote','claimed',$2,'document','synthetic-claim')id", [
            mission,
            { unitPriceMinor: 120, currency: 'SAR' },
          ])
        ).rows[0]?.id,
    );
    for (const costAcceptance of [
      { costLineId: line, evidenceId: source, amountMinor: 1 },
      { costLineId: line, evidenceId: source },
    ]) {
      const p = await proposal({ costAcceptance }, 'commerce', 'accepted_cost', 'selection', 'cost_acceptance');
      await expect(p.approve()).rejects.toThrow();
      expect((await db.query('select from public.decision_resolutions where decision_id=$1', [p.decision])).rowCount).toBe(0);
    }
  });
  it('resolves obstacles only against observed proof and reports conservative autonomous counts', async () => {
    const source = await evidence();
    const obstacle = await withRole(
      'lead_role',
      scope,
      async d =>
        (await d.query("select public.record_obstacle($1,'quality_failure','Synthetic sample issue',$2)id", [mission, [source]])).rows[0]
          ?.id,
    );
    await expect(
      withRole('lead_role', scope, d => d.query('select public.resolve_obstacle($1,$2,$3)', [mission, obstacle, []])),
    ).rejects.toThrow(/observed/);
    await withRole('lead_role', scope, d => d.query('select public.resolve_obstacle($1,$2,$3)', [mission, obstacle, [source]]));
    const report = await withRole(
      'founder_role',
      scope,
      async d => (await d.query('select public.mission_business_metrics($1)report', [mission])).rows[0]?.report,
    );
    expect(report).toMatchObject({ obstaclesTotal: 1, obstaclesResolved: 1, obstaclesResolvedWithoutFounderDecision: 1 });
  });
  it('denies cross-founder and raw private metrics while operator receives bounded measurements', async () => {
    await expect(
      withRole('founder_role', { authUserId: randomUUID() }, d => d.query('select public.mission_business_metrics($1)', [mission])),
    ).rejects.toThrow(/mission denied/);
    await expect(withRole('founder_role', scope, d => d.query('select private.business_metrics_data($1)', [mission]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(withRole('founder_role', scope, d => d.query('select public.operator_business_metrics()'))).rejects.toThrow(
      /permission denied/,
    );
    await db.query('begin');
    await db.query('set local role operator_role');
    const report = (await db.query('select public.operator_business_metrics()report')).rows[0]?.report;
    await db.query('rollback');
    expect(report.missions).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain('Synthetic sample issue');
  });
});
