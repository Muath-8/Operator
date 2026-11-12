import { Pool } from 'pg';
import { z } from 'zod';
import { JsonObjectSchema } from '@lo/state';
import { environment } from './config.js';
import { initializeTelemetry, reportOperationalError, flushTelemetry } from './telemetry.js';
const HealthSchema = z.object({
  observedAt: z.string(),
  alarmMicroUsd: z.number(),
  metrics: z.record(z.string(), z.number().nullable()),
  missionCosts: z.array(z.object({ mission_id: z.uuid(), known_micro_usd: z.number().nullable(), unpriced_calls: z.number() })),
  alerts: z.array(
    z.object({
      code: z.enum([
        'stuck_mission',
        'parked_event',
        'payment_executing',
        'payment_ambiguous',
        'model_spend_alarm',
        'unpriced_model_usage',
        'model_usage_pending',
        'invariant_violation',
      ]),
      mission_id: z.uuid(),
      reference_id: z.uuid(),
      since: z.string().nullable(),
    }),
  ),
});
let pool: Pool | undefined;
export async function operatorHealth() {
  const env = environment(),
    connectionString = process.env.DATABASE_OPERATOR_URL ?? (env.LO_EXECUTION_MODE === 'local' ? env.DATABASE_URL : undefined);
  if (!connectionString) throw new Error('provider_down: operator metrics connection required');
  const alarm = z.coerce
    .number()
    .int()
    .safe()
    .positive()
    .parse(process.env.MODEL_MISSION_ALARM_MICRO_USD ?? 600000000);
  pool ??= new Pool({ connectionString, max: 1 });
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query('set local role operator_role');
    const response = await db.query('select public.operator_health_snapshot($1)report', [alarm]);
    await db.query('commit');
    return HealthSchema.parse(response.rows[0]?.report);
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    db.release();
  }
}
export async function reportOperatorHealth() {
  const report = await operatorHealth();
  initializeTelemetry('runtime');
  // These observations contain counts and opaque IDs only, never ledger content.
  console.info(JSON.stringify({ event: 'operator_health', ...report }));
  for (const alert of report.alerts)
    reportOperationalError(new Error('invariant_violation: operator alarm'), {
      service: 'runtime',
      operation: alert.code,
      missionId: alert.mission_id,
    });
  await flushTelemetry();
  return { alerts: report.alerts.length, observedAt: report.observedAt };
}
export async function closeOperationsPool() {
  await pool?.end();
  pool = undefined;
}

export async function operatorBusinessMetrics() {
  const env = environment(),
    connectionString = process.env.DATABASE_OPERATOR_URL ?? (env.LO_EXECUTION_MODE === 'local' ? env.DATABASE_URL : undefined);
  if (!connectionString) throw new Error('provider_down: operator metrics connection required');
  pool ??= new Pool({ connectionString, max: 1 });
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query('set local role operator_role');
    const result = JsonObjectSchema.parse((await db.query('select public.operator_business_metrics()report')).rows[0]?.report);
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    db.release();
  }
}
