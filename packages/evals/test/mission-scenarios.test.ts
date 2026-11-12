import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools, type EngineServices } from '@lo/runtime';
import {
  CANONICAL_MISSION_SCENARIOS,
  FileScenarioCheckpoints,
  runMissionScenarios,
  type MissionScenarioDriver,
} from '../src/mission-scenarios.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_canonical_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  prior = { ...process.env };
let db: Client;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lo-scenarios-'));
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
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name}with(force)`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
});
function driver(capabilities: string[]): MissionScenarioDriver {
  return {
    mode: 'test_protocol',
    capabilities,
    sourceFiles: [fileURLToPath(import.meta.url)],
    create: async () =>
      withRole('founder_role', { authUserId: user }, async c => ({
        authUserId: user,
        missionId: String((await c.query('select public.start_mission($1,true)id', [randomUUID()])).rows[0]?.id),
      })),
    services: async () =>
      ({
        plan: async () => ({
          ok: true,
          value: {
            runs: [],
            decisions: [],
            questions: [],
            commitments: [],
            founderMessage: 'Explicit scripted protocol test: compliance remains unverified; no outside work or verification is claimed.',
            evidenceIds: [],
            focus: null,
          },
        }),
        run: async () => {
          throw new Error('No synthetic model/provider output is needed for these control paths');
        },
        review: async () => ({ accepted: false, defects: ['No model-quality judgement in a scripted protocol test'] }),
        dispatch: async () => {
          throw new Error('Unexpected specialist dispatch');
        },
      }) satisfies EngineServices,
    advance: async (scope, scenario) => {
      if (scenario.id === 'A1')
        await withRole('founder_role', scope, c => c.query("select public.transition_mission($1,'paused')", [scope.missionId]));
      return { done: true, eventType: 'eval.explicit_protocol', payload: { synthetic: true } };
    },
  };
}
describe('canonical mission runner actual production engine controls', () => {
  it('enumerates exactly25 unique canonical scenarios including five judging cases; missing protocols are blocked', async () => {
    expect(CANONICAL_MISSION_SCENARIOS).toHaveLength(25);
    expect(new Set(CANONICAL_MISSION_SCENARIOS.map(c => c.id)).size).toBe(25);
    expect(CANONICAL_MISSION_SCENARIOS.filter(c => c.id.startsWith('S'))).toHaveLength(5);
    const report = await runMissionScenarios({
      driver: driver([]),
      checkpoints: new FileScenarioCheckpoints(join(directory, 'blocked-checkpoints')),
      directory: join(directory, 'blocked'),
    });
    expect(report.cases).toHaveLength(25);
    expect(report.cases.every(c => c.status === 'blocked' && c.missionId === null)).toBe(true);
    expect(report).toMatchObject({ releaseQualifying: false, liveModelGate: 'blocked', providerGate: 'blocked' });
  });
  it('runs committed pause and unverified compliance through actual missionTick and saves real scoped ledger artifacts', async () => {
    const report = await runMissionScenarios({
      driver: driver(['founder_approval', 'channels', 'knowledge']),
      checkpoints: new FileScenarioCheckpoints(join(directory, 'native-checkpoints')),
      directory: join(directory, 'native'),
      ids: ['A1', 'A17'],
    });
    expect(report.cases.map(c => [c.id, c.status, c.reason])).toEqual([
      ['A1', 'passed', null],
      ['A17', 'passed', null],
    ]);
    for (const result of report.cases) {
      expect(result.ledgerArtifactSha256).toMatch(/^[a-f0-9]{64}$/);
      if (!result.ledgerArtifact) throw new Error('Expected actual ledger artifact');
      const artifact = JSON.parse(await readFile(result.ledgerArtifact, 'utf8')) as { snapshot: { runtime_ticks: unknown[] } };
      expect(result.assertions.every(a => a.passed)).toBe(true);
      expect(artifact.snapshot).toBeTruthy();
    }
    const compliance = report.cases.find(c => c.id === 'A17');
    expect(
      (await db.query('select count(*)::int n from public.runtime_ticks where mission_id=$1', [compliance?.missionId])).rows[0]?.n,
    ).toBe(1);
  });
  it('caches completed checkpoints and holds interrupted ones instead of blindly replaying unknown effects', async () => {
    const path = join(directory, 'checkpoints'),
      store = new FileScenarioCheckpoints(path),
      id = randomUUID();
    let calls = 0;
    expect(await store.run(id, 'completed', async () => ++calls)).toBe(1);
    expect(await new FileScenarioCheckpoints(path).run(id, 'completed', async () => ++calls)).toBe(1);
    expect(calls).toBe(1);
    await expect(
      store.run(id, 'uncertain', async () => {
        throw new Error('Explicit test crash before durable completion');
      }),
    ).rejects.toThrow(/test crash/);
    await expect(new FileScenarioCheckpoints(path).run(id, 'uncertain', async () => ++calls)).rejects.toThrow(/reconciliation/);
    expect(calls).toBe(1);
  });
});
