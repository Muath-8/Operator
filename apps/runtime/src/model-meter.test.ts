import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';
import { createModelMeter, modelCostMicros } from './model-meter.js';
import { operatorHealth, closeOperationsPool } from './operations.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_meter_${Date.now()}`;
const admin = new Client({ connectionString: adminUrl });
let db: Client;
const prior = { ...process.env };
const scope = { authUserId: '00000000-0000-4000-8000-000000000001', missionId: '20000000-0000-4000-8000-000000000001' },
  runId = randomUUID();
const price = {
  inputPerMillion: 2,
  cachedInputPerMillion: 0.5,
  outputPerMillion: 8,
  source: 'https://example.test/synthetic-pricing',
  observedAt: '2026-11-12T00:00:00Z',
};
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
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
  await db.query('update private.platform_controls set effects_enabled=true');
  process.env.DATABASE_URL = url.href;
  process.env.LO_EXECUTION_MODE = 'local';
  process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
  await withRole('lead_role', scope, c =>
    c.query(
      "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier,status)values($1,$2,'lead',jsonb_build_object('maxTokens',40000),'meter-test','frontier','scheduled')",
      [runId, scope.missionId],
    ),
  );
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  await closeOperationsPool();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
});
describe('FR-MET model usage and founder daily cap', () => {
  it('uses integer micro-USD with cached input discounts and rounds fractional microcost upward', () => {
    expect(
      modelCostMicros({ callKey: 'test', inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50, totalTokens: 1050 }, price),
    ).toBe(2100);
    expect(modelCostMicros({ callKey: 'test', inputTokens: 1, cachedInputTokens: 1, outputTokens: 0, totalTokens: 1 }, price)).toBe(1);
    expect(() =>
      modelCostMicros({ callKey: 'test', inputTokens: 1, cachedInputTokens: 2, outputTokens: 0, totalTokens: 1 }, price),
    ).toThrow();
  });
  it('serializes simultaneous reservations against one founder, keeps ambiguous attempts held, and releases only measured cost difference', async () => {
    process.env.MODEL_PRICE_RATES_JSON = JSON.stringify({ 'test-model': price });
    process.env.MODEL_FOUNDER_DAILY_CAP_MICRO_USD = '1000';
    const meter = createModelMeter(scope, runId, 'test-model');
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(keys.map(key => meter.reserve(key, 100)));
    // Exactly one fulfilled result is asserted before its matching request key is selected.
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const key = keys[results.findIndex(r => r.status === 'fulfilled')]!;
    await expect(meter.reserve(randomUUID(), 100)).rejects.toThrow('budget');
    const measured = { callKey: key, inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, totalTokens: 20 };
    await meter.record(measured);
    await meter.record(measured);
    await expect(meter.record({ ...measured, outputTokens: 11, totalTokens: 21 })).rejects.toThrow('conflict');
    await expect(meter.reserve(randomUUID(), 100)).resolves.toBeUndefined();
    const cost = await withRole('policy_role', scope, c =>
      c.query('select * from public.mission_costs where mission_id=$1', [scope.missionId]),
    );
    expect(cost.rows[0]).toMatchObject({ measured_model_micro_usd: null, unresolved_reservations: '1', held_ceiling_micro_usd: '800' });
  });
  it('records explicit local unpriced usage as unknown and fails closed without sourced production pricing', async () => {
    delete process.env.MODEL_PRICE_RATES_JSON;
    delete process.env.MODEL_FOUNDER_DAILY_CAP_MICRO_USD;
    const meter = createModelMeter(scope, runId, 'test-model');
    await meter.record({ callKey: randomUUID(), inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, totalTokens: 20 });
    const cost = await withRole('policy_role', scope, c =>
      c.query('select * from public.mission_costs where mission_id=$1', [scope.missionId]),
    );
    expect(cost.rows[0]?.measured_model_micro_usd).toBeNull();
    expect(cost.rows[0]?.unpriced_calls).toBe('1');
    process.env.LO_EXECUTION_MODE = 'production';
    expect(() => createModelMeter(scope, runId, 'test-model')).toThrow('sourced model pricing');
    process.env.LO_EXECUTION_MODE = 'local';
  });
  it('denies metering writes from specialists and hides other tenants usage', async () => {
    await expect(
      withRole('specialist_role', scope, c =>
        c.query('select public.reserve_model_budget($1,$2,$3,1,1)', [scope.missionId, runId, randomUUID()]),
      ),
    ).rejects.toThrow('permission denied');
    const rows = await withRole('policy_role', { authUserId: randomUUID(), missionId: scope.missionId }, c =>
      c.query('select * from public.model_usage'),
    );
    expect(rows.rowCount).toBe(0);
  });
  it('NFR-11 exposes content-free health metrics and aged parked-event alarms only to the operator role', async () => {
    const event = randomUUID();
    await db.query(
      "insert into public.outbox(id,mission_id,type,payload,created_at)values($1,$2,'test.parked','{}',clock_timestamp()-interval '2 hours')",
      [event, scope.missionId],
    );
    const health = await operatorHealth();
    expect(health.alerts).toContainEqual(expect.objectContaining({ code: 'parked_event', reference_id: event }));
    expect(health.metrics.performedWithoutReceipt).toBe(0);
    expect(JSON.stringify(health)).not.toContain('Layla');
    expect(health.metrics.pendingModelReservations).toBe(1);
    expect(health.metrics.heldModelCeilingMicroUsd).toBe(800);
    await expect(withRole('founder_role', scope, c => c.query('select public.operator_health_snapshot(600000000)'))).rejects.toThrow(
      'permission denied',
    );
    await db.query('begin');
    try {
      await db.query('set local role operator_role');
      await expect(db.query('select * from public.messages')).rejects.toThrow('permission denied');
    } finally {
      await db.query('rollback');
    }
  });
});
