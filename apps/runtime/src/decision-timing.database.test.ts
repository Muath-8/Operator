import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DecisionPacketSchema, type JsonValue } from '@lo/state';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { reconcileDecisionTiming, configureDecisionTiming, applySafeDefaults } from './decision-timing.js';
import { reconcileNotifications } from './notification-service.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_timing_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  priorEnv = { ...process.env };
let db: Client;
async function mission() {
  const id = randomUUID();
  await db.query(
    'insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,metadata)values($1,$2,\'launch\',\'Synthetic decision timing fixture\',\'SAR\',true,\'{"locale":"en","timeZone":"UTC"}\')',
    [id, founder],
  );
  return { authUserId: user, missionId: id };
}
interface Input {
  kind?: string;
  gate?: string;
  binding?: boolean;
  at?: string | null;
  cost?: { amountMinor: number; currency: string } | null;
  refs?: string[];
  evidenceIds?: string[];
  createdAt?: Date;
}
/** Controlled historical fixtures let native SQL exercise a full week without
 * exposing any clock override to an application role. No provider/model runs. */
async function decision(scope: ActorScope, input: Input = {}) {
  const id = randomUUID(),
    refs = input.refs ?? [],
    packet = DecisionPacketSchema.parse({
      question: 'Choose the synthetic non-binding colour preference',
      options: [
        {
          id: 'a',
          label: 'Recorded default',
          artifactVersionIds: refs,
          evidenceIds: input.evidenceIds ?? [],
          cost: input.cost ?? null,
          timeDays: 0,
          consequences: 'Preference only; no execution authority',
        },
      ],
      recommendation: { optionId: 'a', reasons: ['Recorded preference default'] },
      staleImpact: [],
      approvedVersionIds: refs,
      defaultIfNoAnswer: {
        optionId: 'a',
        at: input.at === undefined ? new Date(Date.now() - 60000).toISOString() : input.at,
        binding: input.binding ?? false,
      },
    });
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, mission_id: scope.missionId })]);
  await db.query(
    "insert into public.decisions(id,mission_id,kind,outcome,gate,packet,evidence_refs,approved_version_refs,actor_id,created_at)values($1,$2,$3,'brand',$4,$5,$6,$7,$8,$9)",
    [
      id,
      scope.missionId,
      input.kind ?? 'selection',
      input.gate ?? 'colour_variant',
      packet,
      input.evidenceIds ?? [],
      refs,
      user,
      input.createdAt ?? new Date(),
    ],
  );
  return id;
}
async function artifact(scope: ActorScope, content: Record<string, JsonValue>) {
  return withRole('specialist_role', scope, async client => {
    const id = z
        .uuid()
        .parse(
          (
            await client.query("select public.create_artifact($1,'visual_preference','brand','Synthetic colour variation')id", [
              scope.missionId,
            ])
          ).rows[0]?.id,
        ),
      ref = z
        .uuid()
        .parse((await client.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, id, content])).rows[0]?.id);
    return { id, ref };
  });
}
async function historicalTick(scope: ActorScope, at: Date) {
  return withRole(
    'lead_role',
    scope,
    async client =>
      (await client.query('select test_clock.tick($1,$2)result', [scope.missionId, at])).rows[0]?.result as {
        autoDefaulted: string[];
        momentIds: string[];
      },
  );
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
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
  // TEST ONLY: never installed by a migration, seed or application. This shim
  // exercises the identical SQL core with historical fixture clocks.
  await db.query(
    "create schema test_clock;create function test_clock.tick(uuid,timestamptz)returns jsonb language sql security definer set search_path=''as $$select private.reconcile_decision_timing_at($1,$2)$$;revoke all on function test_clock.tick(uuid,timestamptz)from public;grant usage on schema test_clock to lead_role;grant execute on function test_clock.tick(uuid,timestamptz)to lead_role",
  );
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
describe('FR-EASE-04/05/10 I-4/8 native safe defaults and durable decision moments', () => {
  it('a deferred colour preference defaults once after its date, records system provenance/notice and grants no artifact or effect authority', async () => {
    const scope = await mission(),
      visual = await artifact(scope, { palette: ['#eee', '#111'] }),
      did = await decision(scope, { refs: [visual.ref] });
    await withRole('lead_role', scope, client =>
      client.query("select public.add_dependency($1,$2,$3,'fixture visual source')", [scope.missionId, visual.ref, did]),
    );
    await withRole('founder_role', scope, client =>
      client.query("select public.resolve_decision($1,$2,'defer',null)", [scope.missionId, did]),
    );
    const attempts = await Promise.all([reconcileDecisionTiming(scope), reconcileDecisionTiming(scope)]);
    expect(attempts.flatMap(a => a.autoDefaulted)).toEqual([did]);
    const rows = (
      await db.query('select response,resolution_source from public.decision_resolutions where decision_id=$1 order by created_at,id', [
        did,
      ])
    ).rows;
    expect(rows).toEqual([
      { response: 'defer', resolution_source: 'founder' },
      { response: 'choose', resolution_source: 'system_default' },
    ]);
    expect((await db.query('select status from public.artifact_statuses where artifact_version_id=$1', [visual.ref])).rows).toEqual([
      { status: 'draft' },
    ]);
    expect(
      (await db.query('select count(*)::integer count from public.approvals where mission_id=$1', [scope.missionId])).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await db.query("select count(*)::integer count from public.outbox where mission_id=$1 and type='decision.defaulted'", [
          scope.missionId,
        ])
      ).rows[0]?.count,
    ).toBe(1);
    await expect(
      withRole('founder_role', scope, client => client.query("select public.resolve_decision($1,$2,'defer',null)", [scope.missionId, did])),
    ).rejects.toThrow(/final response/);
  });
  it('money, binding/final gates, protected artifact capabilities and future defaults never auto-resolve', async () => {
    const scope = await mission(),
      authority = await artifact(scope, { effectIntent: { action: 'production_order', effectClass: 'spend' } }),
      ids = [];
    for (const input of [
      { kind: 'mandate' },
      { kind: 'engagement' },
      { kind: 'goal' },
      { kind: 'terminal' },
      { gate: 'specification' },
      { binding: true, at: null },
      { cost: { amountMinor: 0, currency: 'SAR' } },
      { refs: [authority.ref] },
      { at: new Date(Date.now() + 86400000).toISOString() },
    ])
      ids.push(await decision(scope, input));
    const result = await reconcileDecisionTiming(scope);
    expect(result.autoDefaulted).toEqual([]);
    expect(
      (
        await db.query("select id from public.decision_resolutions where decision_id=any($1::uuid[])and response in('approve','choose')", [
          ids,
        ])
      ).rows,
    ).toHaveLength(0);
  });
  it('an unresolved clarification question and a changed source prevent automatic preference resolution', async () => {
    const scope = await mission(),
      question = await decision(scope);
    await withRole('founder_role', scope, client =>
      client.query("select public.resolve_decision($1,$2,'question',null)", [scope.missionId, question]),
    );
    const visual = await artifact(scope, { palette: ['#eee'] }),
      stale = await decision(scope, { refs: [visual.ref] });
    await withRole('lead_role', scope, client =>
      client.query("select public.add_dependency($1,$2,$3,'source')", [scope.missionId, visual.ref, stale]),
    );
    await withRole('specialist_role', scope, client =>
      client.query('select public.append_artifact_version($1,$2,$3)', [scope.missionId, visual.id, { palette: ['#111'] }]),
    );
    expect((await reconcileDecisionTiming(scope)).autoDefaulted).toEqual([]);
  });
  it('explicit JustGo applies only safe defaults, including before/null dates, and returns remaining mandatory requests', async () => {
    const scope = await mission(),
      safe = await decision(scope, { at: null }),
      future = await decision(scope, { at: new Date(Date.now() + 86400000).toISOString() }),
      money = await decision(scope, { cost: { amountMinor: 100, currency: 'SAR' } }),
      result = await applySafeDefaults(scope);
    expect(result.resolvedDecisionIds.sort()).toEqual([safe, future].sort());
    expect(result.remainingDecisionIds).toContain(money);
    expect(
      (
        await db.query('select distinct resolution_source from public.decision_resolutions where decision_id=any($1::uuid[])', [
          [safe, future],
        ])
      ).rows,
    ).toEqual([{ resolution_source: 'founder' }]);
    await expect(applySafeDefaults(scope, randomUUID())).rejects.toThrow(/scoped decision moment/);
  });
  it('an explicit moment-scoped JustGo cannot resolve a safe preference outside that moment or another mission', async () => {
    const scope = await mission(),
      other = await mission(),
      inside = await decision(scope, { at: null }),
      outside = await decision(scope, { at: null }),
      moment = randomUUID();
    await db.query(
      "insert into public.decision_moments(id,mission_id,urgent,reason,week_start,scheduled_for)values($1,$2,false,'scheduled',date_trunc('week',clock_timestamp())::date,clock_timestamp())",
      [moment, scope.missionId],
    );
    await db.query('insert into public.decision_moment_items(mission_id,moment_id,decision_id)values($1,$2,$3)', [
      scope.missionId,
      moment,
      inside,
    ]);
    const result = await applySafeDefaults(scope, moment);
    expect(result.resolvedDecisionIds).toEqual([inside]);
    expect(result.remainingDecisionIds).toContain(outside);
    await expect(applySafeDefaults(other, moment)).rejects.toThrow(/scoped decision moment/);
  });
  it('ten non-urgent decisions over one simulated historical week produce at most three regular moments; later work waits for the next slot', async () => {
    const scope = await mission(),
      monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
    const at = (day: number, hour: number) => new Date(monday.getTime() + day * 86400000 + hour * 3600000);
    for (const [day, count] of [
      [0, 3],
      [2, 3],
      [4, 3],
      [5, 1],
    ] as const) {
      for (let i = 0; i < count; i++) await decision(scope, { gate: 'direction', binding: true, at: null, createdAt: at(day, 8) });
      await historicalTick(scope, at(day, 10));
    }
    const moments = (
      await db.query('select id,urgent,scheduled_for from public.decision_moments where mission_id=$1 order by scheduled_for', [
        scope.missionId,
      ])
    ).rows;
    expect(moments).toHaveLength(3);
    expect(moments.every(m => !m.urgent)).toBe(true);
    expect(
      (await db.query('select count(*)::integer count from public.decision_moment_items where mission_id=$1', [scope.missionId])).rows[0]
        ?.count,
    ).toBe(9);
    await historicalTick(scope, at(7, 10));
    expect(
      (await db.query('select count(*)::integer count from public.decision_moments where mission_id=$1', [scope.missionId])).rows[0]?.count,
    ).toBe(4);
  });
  it('founder cadence changes alter actual slots and urgent money bypasses a fully used regular slot', async () => {
    const scope = await mission(),
      monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
    const at = (day: number, hour: number) => new Date(monday.getTime() + day * 86400000 + hour * 3600000);
    await configureDecisionTiming(scope, 1);
    await decision(scope, { gate: 'direction', binding: true, at: null, createdAt: at(0, 8) });
    await historicalTick(scope, at(0, 10));
    await decision(scope, { gate: 'direction', binding: true, at: null, createdAt: at(2, 8) });
    expect((await historicalTick(scope, at(2, 10))).momentIds).toHaveLength(0);
    const money = await decision(scope, { cost: { amountMinor: 100, currency: 'SAR' }, createdAt: at(2, 8) });
    const urgent = await historicalTick(scope, at(2, 10));
    expect(urgent.momentIds).toHaveLength(1);
    expect((await db.query('select urgent,reason from public.decision_moments where id=$1', [urgent.momentIds[0]])).rows[0]).toEqual({
      urgent: true,
      reason: 'money',
    });
    expect((await db.query('select decision_id from public.decision_moment_items where moment_id=$1', [urgent.momentIds[0]])).rows).toEqual(
      [{ decision_id: money }],
    );
    await configureDecisionTiming(scope, 3);
    expect((await historicalTick(scope, at(2, 10))).momentIds).toHaveLength(1);
  });
  it('a durable moment groups actual pending decision sources into one actionable in-app notification', async () => {
    const scope = await mission(),
      monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
    for (let i = 0; i < 10; i++) await decision(scope, { gate: 'direction', binding: true, at: null, createdAt: monday });
    await historicalTick(scope, new Date(monday.getTime() + 10 * 3600000));
    await reconcileNotifications(scope);
    const events = (
      await db.query("select kind,title,target from public.notification_events where mission_id=$1 and kind='decision'", [scope.missionId])
    ).rows;
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe('10 decisions ready for review');
    expect(events[0]?.target.kind).toBe('decision');
    expect(
      (await db.query('select count(*)::integer count from public.notification_releases where mission_id=$1', [scope.missionId])).rows[0]
        ?.count,
    ).toBe(10);
  });
  it('scoped privileged helpers cannot be called by the wrong role, with a caller-supplied clock or across tenants', async () => {
    const scope = await mission();
    await expect(
      withRole('founder_role', scope, client => client.query('select public.reconcile_decision_timing($1)', [scope.missionId])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('lead_role', scope, client => client.query('select public.apply_safe_defaults($1,null)', [scope.missionId])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('lead_role', scope, client =>
        client.query('select private.reconcile_decision_timing_at($1,clock_timestamp())', [scope.missionId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(reconcileDecisionTiming({ authUserId: randomUUID(), missionId: scope.missionId })).rejects.toThrow(/tenant|denied/);
    await expect(configureDecisionTiming(scope, 8)).rejects.toThrow();
  });
});
