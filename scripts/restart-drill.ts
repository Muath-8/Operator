import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
const root = fileURLToPath(new URL('..', import.meta.url)),
  executionId = randomUUID(),
  name = 'lo_restart_' + Date.now(),
  directory = resolve(root, '.local', name),
  adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const databaseUrl = new URL(adminUrl);
if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)) throw Error('Restart drill uses native loopback PostgreSQL only');
databaseUrl.pathname = '/' + name;
const port = 8398,
  workerPort = 8397,
  base = `http://127.0.0.1:${port}`,
  workerUrl = `http://127.0.0.1:${workerPort}`,
  cli =
    process.env.LO_INNGEST_BINARY ??
    join(root, 'node_modules', 'inngest-cli', 'bin', process.platform === 'win32' ? 'inngest.exe' : 'inngest');
if (!existsSync(cli)) throw Error('Installed pinned Inngest CLI required');
const restartOrchestrator = process.env.LO_DRILL_RESTART_ORCHESTRATOR === 'true';
const processes: ChildProcess[] = [];
const logs: Awaited<ReturnType<typeof open>>[] = [];
await mkdir(directory, { recursive: true });
const admin = new Client({ connectionString: adminUrl });
let db: Client | undefined;
let created = false;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, label: string, limit = 60000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(500);
  }
  throw Error('Timed out: ' + label);
}
async function start(kind: 'worker' | 'inngest', round: number) {
  const log = await open(join(directory, `${kind}-${round}.log`), 'a');
  logs.push(log);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    LO_EXECUTION_MODE: 'local',
    LO_RESTART_DRILL: 'true',
    LO_DRILL_DIRECTORY: directory,
    LO_DRILL_EXECUTION_ID: executionId,
    LO_DRILL_WORKER_PORT: String(workerPort),
    DATABASE_URL: databaseUrl.href,
    APP_ORIGIN: workerUrl,
    INNGEST_DEV: base,
    INNGEST_BASE_URL: base,
  };
  const child =
    kind === 'worker'
      ? spawn(
          process.execPath,
          [
            '--import',
            pathToFileURL(join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
            join(root, 'apps/runtime/tests/restart-worker.ts'),
          ],
          { cwd: root, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] },
        )
      : spawn(
          cli,
          [
            'dev',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--connect-gateway-port',
            '8399',
            '--connect-executor-grpc-port',
            '50153',
            '--connect-gateway-grpc-port',
            '50152',
            '--persist',
            '--no-discovery',
            '-u',
            workerUrl,
          ],
          { cwd: directory, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] },
        );
  processes.push(child);
  child.once('error', error => process.stderr.write('Drill child unavailable: ' + error.name + '\n'));
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Child did not stop')), 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGKILL');
  });
}
async function ready(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
async function send(id: string, event: string) {
  const response = await fetch(base + '/e/local-drill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, name: event, data: { executionId }, ts: Date.now() }),
  });
  if (!response.ok) throw Error('Local event submission failed');
  return z
    .object({ ids: z.array(z.string()).min(1) })
    .passthrough()
    .parse(await response.json()).ids[0];
}
try {
  await admin.connect();
  await admin.query('create database ' + name);
  created = true;
  db = new Client({ connectionString: databaseUrl.href });
  await db.connect();
  await db.query(
    (await readFile(join(root, 'supabase/tests/bootstrap.sql'), 'utf8')).replace(
      'create role authenticated nologin noinherit nobypassrls;',
      () =>
        "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
    ),
  );
  for (const file of (await readdir(join(root, 'supabase/migrations'))).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(join(root, 'supabase/migrations', file), 'utf8'));
  await db.query(await readFile(join(root, 'supabase/seed.sql'), 'utf8'));
  let worker = await start('worker', 1);
  await until(() => ready(workerUrl), 'worker initial readiness');
  let inngest = await start('inngest', 1);
  await until(() => ready(base), 'Inngest initial readiness');
  await until(async () => {
    try {
      return (await fetch(workerUrl, { method: 'PUT' })).ok;
    } catch {
      return false;
    }
  }, 'function registration');
  const eventId = await send(executionId, 'drill/run');
  await until(async () => existsSync(join(directory, 'waiting.json')), 'first checkpoint');
  // Poll the actual local API until a persisted run is visible before killing both processes.
  await until(async () => {
    const response = await fetch(`${base}/v1/events/${eventId}/runs`);
    if (!response.ok) return false;
    const body = (await response.json()) as { data?: unknown[] };
    return Array.isArray(body.data) && body.data.length === 1;
  }, 'persisted run visibility');
  await wait(1500);
  const before = { workerPid: worker.pid, inngestPid: inngest.pid };
  await stop(worker);
  if (restartOrchestrator) await stop(inngest);
  worker = await start('worker', 2);
  await until(() => ready(workerUrl), 'worker restart readiness');
  if (restartOrchestrator) inngest = await start('inngest', 2);
  await until(() => ready(base), 'Inngest restart readiness');
  await until(async () => (await fetch(workerUrl, { method: 'PUT' })).ok, 'function resync');
  await send(executionId + ':resume', 'drill/resume');
  await until(async () => existsSync(join(directory, 'complete.json')), 'resumed third tick', 90000);
  await send(executionId, 'drill/run');
  await wait(2000);
  const rows = (
    await db.query('select original,count(*)::integer n from public.messages where original like $1 group by original order by original', [
      `Synthetic restart drill ${executionId} phase %`,
    ])
  ).rows;
  const ticks = (await db.query('select count(*)::integer n from public.runtime_ticks where event_key like $1', [executionId + ':phase:%']))
    .rows[0]?.n;
  if (rows.length !== 3 || rows.some(row => row.n !== 1) || ticks !== 3)
    throw Error('Duplicate or missing durable phase after real restart and duplicate event');
  const report = {
    status: 'passed',
    executionId,
    completedAt: new Date().toISOString(),
    actualProcessRestart: true,
    orchestratorRestarted: restartOrchestrator,
    persistedInngest: true,
    before,
    after: { workerPid: worker.pid, inngestPid: inngest.pid },
    phaseMessages: rows,
    runtimeTicks: ticks,
    externalEffectsExercised: false,
    modelCalls: 0,
    providerCalls: 0,
    scope:
      'Scripted Phase0.7 durable engine and application worker SIGKILL/restart with actual Inngest checkpoint recovery; orchestrator restart is a separate explicit mode, not full provider mission or live model proof',
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: 'passed', report: join(directory, 'report.json') }) + '\n');
} catch (error) {
  await writeFile(
    join(directory, 'failure.json'),
    JSON.stringify({ status: 'failed', executionId, error: error instanceof Error ? error.message : 'Unknown error' }),
  );
  throw error;
} finally {
  for (const child of processes.reverse()) if (child.exitCode === null) await stop(child);
  for (const log of logs) await log.close();
  await db?.end();
  if (created) await admin.query('drop database ' + name + ' with(force)');
  await admin.end();
}
