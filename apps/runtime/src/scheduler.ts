import { Pool } from 'pg';
import { z } from 'zod';
import { environment } from './config.js';
import type { ActorScope } from './database.js';
let schedulerPool: Pool | undefined;
/** Scheduler can enumerate routing IDs only; it has no ledger read/write grant. */
export async function runtimeMissionScopes(): Promise<ActorScope[]> {
  const env = environment();
  const connectionString = process.env.DATABASE_SCHEDULER_URL ?? (env.LO_EXECUTION_MODE === 'local' ? env.DATABASE_URL : undefined);
  if (!connectionString) throw new Error('provider_down: scheduler role connection is not configured');
  schedulerPool ??= new Pool({ connectionString, max: 1 });
  const db = await schedulerPool.connect();
  try {
    await db.query('begin');
    await db.query('set local role scheduler_role');
    const rows = await db.query('select * from public.runtime_mission_scopes()');
    await db.query('commit');
    return z
      .array(z.object({ mission_id: z.uuid(), auth_user_id: z.uuid() }))
      .parse(rows.rows)
      .map(r => ({ missionId: r.mission_id, authUserId: r.auth_user_id }));
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    db.release();
  }
}
export async function closeSchedulerPool() {
  await schedulerPool?.end();
  schedulerPool = undefined;
}
