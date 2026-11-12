import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';
import { executeFounderCommand, ledgerVersion } from './commands.js';
import { loadMissionSnapshot } from './engine.js';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const admin = new Client({ connectionString: adminUrl }),
  name = `lo_finance_presence_${Date.now()}`;
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
async function proposal(content: object, kind = 'constraint', supersedes: string | null = null) {
  const versionId = await withRole('specialist_role', scope, async d => {
    const a = (await d.query("select public.create_artifact($1,'financial_plan','commerce','First-restock budget')id", [mission])).rows[0]
      ?.id;
    const v = (await d.query('select public.append_artifact_version($1,$2,$3)id', [mission, a, content])).rows[0]?.id as string;
    await d.query("select public.set_artifact_status($1,$2,'proposed')", [mission, v]);
    return v;
  });
  const packet = {
    ...(supersedes
      ? { impact: { decisionIds: [supersedes], artifactIds: [], commitmentIds: [], outcomes: ['commerce'], cost: null, delayDays: 0 } }
      : {}),
    question: 'Approve the exact plan?',
    options: [
      {
        id: 'yes',
        label: 'Approve',
        evidenceIds: [],
        artifactVersionIds: [versionId],
        cost: null,
        timeDays: 0,
        consequences: 'Record budget and first-restock forecast',
      },
    ],
    recommendation: { optionId: 'yes', reasons: ['Review sourced figures'] },
    approvedVersionIds: [versionId],
    staleImpact: [],
    defaultIfNoAnswer: { optionId: 'yes', at: null, binding: true },
  };
  const decisionId = await withRole(
    'lead_role',
    scope,
    async d =>
      (await d.query("select public.propose_decision($1,$2,$3,'commerce','financial_plan',$4)id", [mission, kind, packet, supersedes]))
        .rows[0]?.id as string,
  );
  const approve = async () =>
    executeFounderCommand(user, {
      kind: 'resolveDecision',
      missionId: mission,
      idempotencyKey: randomUUID(),
      seenLedgerVersion: await withRole('founder_role', scope, d => ledgerVersion(d, mission)),
      decisionId,
      response: 'approve',
      optionId: 'yes',
    });
  return { versionId, decisionId, approve };
}
const plan = (amountMinor = 200000) => ({
  financialPlan: {
    currency: 'SAR',
    envelopes: [{ name: 'production', amountMinor }],
    forecastToFirstRestock: [{ envelope: 'production', amountMinor: 150000, basis: 'estimate', evidenceIds: [] }],
  },
});
describe('FR-FIN budget activation, FR-MIS closing, FR-MET engagement', () => {
  let first: { versionId: string; decisionId: string };
  it('rejects an over-goal budget and atomically rolls back resolution and envelopes', async () => {
    const p = await proposal(plan(3000001));
    await expect(p.approve()).rejects.toThrow(/exceed/);
    expect((await db.query('select from public.decision_resolutions where decision_id=$1', [p.decisionId])).rowCount).toBe(0);
    expect((await db.query('select from public.financial_plans where artifact_version_id=$1', [p.versionId])).rowCount).toBe(0);
  });
  it('activates only a selected approved plan, writes ledger rows once, and includes it in the runtime snapshot', async () => {
    const p = await proposal(plan());
    await expect(
      withRole('founder_role', scope, d => d.query('select public.apply_financial_plan($1,$2,$3)', [mission, p.decisionId, p.versionId])),
    ).rejects.toThrow(/approved/);
    await p.approve();
    first = p;
    await withRole('founder_role', scope, d =>
      d.query('select public.apply_financial_plan($1,$2,$3)', [mission, p.decisionId, p.versionId]),
    );
    expect((await db.query('select kind,amount_minor from public.money_ledger where ref_id=$1 order by kind', [p.versionId])).rows).toEqual(
      [
        { kind: 'envelope', amount_minor: '200000' },
        { kind: 'forecast', amount_minor: '150000' },
      ],
    );
    expect((await loadMissionSnapshot(scope)).current_financial_plan).toBe(p.versionId);
  });
  it('denies direct specialist activation and cross-tenant finance access', async () => {
    await expect(
      withRole('specialist_role', scope, d =>
        d.query('select public.apply_financial_plan($1,$2,$3)', [mission, first.decisionId, first.versionId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('founder_role', { authUserId: randomUUID() }, d => d.query('select public.current_financial_plan($1)', [mission])),
    ).rejects.toThrow(/mission denied/);
  });
  it('requires Change for replacement and totals only the active forecast', async () => {
    const bad = await proposal(plan(250000));
    await expect(bad.approve()).rejects.toThrow(/Change/);
    const next = await proposal(plan(250000), 'change', first.decisionId);
    await next.approve();
    expect((await loadMissionSnapshot(scope)).current_financial_plan).toBe(next.versionId);
    expect(
      (await withRole('founder_role', scope, d => d.query('select forecast_minor from public.money_totals where mission_id=$1', [mission])))
        .rows[0]?.forecast_minor,
    ).toBe('150000');
    expect((await db.query('select count(*)::int n from public.financial_plans where mission_id=$1', [mission])).rows[0]?.n).toBe(2);
  });
  it('generates a canonical proposed Launch Record from the actual ledgers', async () => {
    const result = await withRole(
      'lead_role',
      scope,
      async d => (await d.query('select public.prepare_launch_record($1)id', [mission])).rows[0]?.id,
    );
    const content = (await db.query('select content from public.artifact_versions where id=$1', [result])).rows[0]?.content;
    expect(content.launchRecord.mission.id).toBe(mission);
    expect(content.launchRecord.money_ledger.length).toBeGreaterThan(0);
    expect(content.launchRecord.messages).toBeUndefined();
    expect(
      (await db.query('select source_revision from public.generated_launch_records where artifact_version_id=$1', [result])).rowCount,
    ).toBe(1);
  });
  it('denies Stop when the closing record omits live commitments', async () => {
    await withRole('lead_role', scope, d =>
      d.query("select public.open_commitment($1,null,'outbound','Return outstanding property',clock_timestamp()+interval '1 day')", [
        mission,
      ]),
    );
    const p = await proposal({ closingRecord: { terminal: 'stop', summary: 'Stop safely', openCommitments: [] } });
    await expect(db.query("select private.assert_terminal_checklist($1,'stop',$2)", [mission, p.versionId])).rejects.toThrow(/exact owner/);
  });
  it('deduplicates heartbeat windows and rejects privileged/foreign presence writes', async () => {
    await withRole('founder_role', scope, async d => {
      await d.query('select public.record_founder_presence($1,true)', [mission]);
      await d.query('select public.record_founder_presence($1,true)', [mission]);
    });
    expect((await db.query('select active_seconds from public.founder_presence where mission_id=$1', [mission])).rows).toEqual([
      { active_seconds: 0 },
    ]);
    await expect(withRole('lead_role', scope, d => d.query('select public.record_founder_presence($1,true)', [mission]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      withRole('founder_role', { authUserId: randomUUID() }, d => d.query('select public.record_founder_presence($1,true)', [mission])),
    ).rejects.toThrow(/mission denied/);
  });
  it('measures only a recent bounded heartbeat interval and exposes the estimate basis', async () => {
    const other = '20000000-0000-4000-8000-000000000002',
      otherScope = { authUserId: user, missionId: other };
    await db.query(
      "insert into public.founder_presence(mission_id,actor_id,window_id,active_seconds,created_at)values($1,$2,-1,0,clock_timestamp()-interval '35 seconds')",
      [other, user],
    );
    await db.query(
      "insert into public.founder_presence_signals(mission_id,actor_id,active,created_at)values($1,$2,true,clock_timestamp()-interval '35 seconds')",
      [other, user],
    );
    await withRole('founder_role', otherScope, d => d.query('select public.record_founder_presence($1,true)', [other]));
    const result = await withRole(
      'founder_role',
      otherScope,
      async d => (await d.query('select public.mission_engagement($1)value', [other])).rows[0]?.value,
    );
    expect(result).toMatchObject({ activeSeconds: 30, absenceHours: 48 });
    expect(result.basis).toContain('90 seconds');
    expect(result.lastSeenAt).toBeTruthy();
  });
});
