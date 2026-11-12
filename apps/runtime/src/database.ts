import { Client, Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { PostgresMissionRepository, type StateRole, type SqlLease } from '@lo/state';
import { environment, type Environment } from './config.js';

const pools = new Map<StateRole, Pool>();
const roleEnv: Record<StateRole, keyof Environment> = {
  founder_role: 'DATABASE_FOUNDER_URL',
  lead_role: 'DATABASE_LEAD_URL',
  specialist_role: 'DATABASE_SPECIALIST_URL',
  policy_role: 'DATABASE_POLICY_URL',
  ingress_role: 'DATABASE_INGRESS_URL',
  voice_role: 'DATABASE_VOICE_URL',
};
export interface ActorScope {
  authUserId: string;
  missionId?: string;
}
function rolePool(role: StateRole, env: Environment): Pool {
  let pool = pools.get(role);
  if (pool) return pool;
  const configured = env[roleEnv[role]];
  const connectionString = typeof configured === 'string' ? configured : env.LO_EXECUTION_MODE === 'local' ? env.DATABASE_URL : undefined;
  if (!connectionString) throw new Error('provider_down: role database connection is not configured');
  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: `launch-operator:${role}`,
  });
  pools.set(role, pool);
  return pool;
}
/** Each production pool uses a separately provisioned login with membership in
 * only its named role. The application never connects as a service superuser. */
export async function withRole<T>(
  role: StateRole,
  scope: ActorScope,
  work: (db: PoolClient) => Promise<T>,
  env: Environment = environment(),
  transactionMode: 'snapshot' | 'write' = 'write',
  signal?: AbortSignal,
): Promise<T> {
  z.uuid().parse(scope.authUserId);
  if (scope.missionId) z.uuid().parse(scope.missionId);
  if (role !== 'founder_role' && !scope.missionId) throw new Error('validation: runtime role needs mission scope');
  if (signal && transactionMode !== 'snapshot') throw new Error('validation: cancellable transactions are read-only snapshots');
  if (signal?.aborted) throw new DOMException('Snapshot cancelled', 'AbortError');
  const pool = rolePool(role, env);
  const db = await pool.connect();
  let cancelled = false,
    cancelRequest: Promise<void> | undefined;
  // The cancellation target is obtained from this leased connection and never
  // supplied by a caller. A separate connection with the same scoped login
  // avoids waiting for a free slot when every export connection is blocked.
  let backendId: number | undefined;
  const abort = () => {
    if (cancelled) return;
    cancelled = true;
    const configured = env[roleEnv[role]],
      connectionString = typeof configured === 'string' ? configured : env.LO_EXECUTION_MODE === 'local' ? env.DATABASE_URL : undefined;
    const control = new Client({
      connectionString,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      application_name: 'launch-operator:snapshot-cancel',
    });
    cancelRequest = (async () => {
      try {
        await control.connect();
        await control.query('select pg_cancel_backend($1)', [backendId]);
      } finally {
        await control.end();
      }
    })();
    // Attach immediately to prevent an unhandled rejection while the original
    // query unwinds. The transaction catch below still awaits and reports it.
    void cancelRequest.catch(() => undefined);
  };
  try {
    backendId = signal
      ? z
          .number()
          .int()
          .positive()
          .parse((await db.query('select pg_backend_pid()id')).rows[0]?.id)
      : undefined;
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (cancelled) throw new DOMException('Snapshot cancelled', 'AbortError');
    await db.query(transactionMode === 'snapshot' ? 'begin isolation level repeatable read read only' : 'begin');
    await db.query(`set local role ${role}`); // role is the closed StateRole union, never request text.
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: scope.authUserId, mission_id: scope.missionId, role }),
    ]);
    if (signal) await db.query("set local statement_timeout='30s'");
    const result = await work(db);
    if (cancelled) throw new DOMException('Snapshot cancelled', 'AbortError');
    await db.query('commit');
    return result;
  } catch (error) {
    await cancelRequest;
    await db.query('rollback');
    if (cancelled) throw new DOMException('Snapshot cancelled', 'AbortError');
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    db.release(cancelled);
  }
}
/** Reservation commits independently. A dispatch lease persists identity across
 * the claim commit and the second locked provider transaction. Destroying this
 * connection on release prevents session claims leaking to another tenant. */
export function policyRepository(scope: ActorScope, env: Environment = environment()): PostgresMissionRepository {
  z.uuid().parse(scope.authUserId);
  z.uuid().parse(scope.missionId);
  return new PostgresMissionRepository(
    { query: (sql, values) => withRole('policy_role', scope, db => db.query(sql, values), env) },
    async (): Promise<SqlLease> => {
      const client = await rolePool('policy_role', env).connect();
      try {
        await client.query('set role policy_role');
        await client.query("select set_config('request.jwt.claims',$1,false)", [
          JSON.stringify({ sub: scope.authUserId, mission_id: scope.missionId, role: 'policy_role' }),
        ]);
        return { query: (sql, values) => client.query(sql, values), release: () => client.release(true) };
      } catch (error) {
        client.release(true);
        throw error;
      }
    },
  );
}
export async function closeDatabasePools(): Promise<void> {
  await Promise.all([...pools.values()].map(p => p.end()));
  pools.clear();
}
