import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { closeDatabasePools } from '@lo/runtime';
import { projectMission, projectMissionSummary, projectPlate } from './projection';
import { readSnapshot, type Row } from './snapshot';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const databaseName = `lo_projection_test_${Date.now()}`;
const admin = new Client({ connectionString: adminUrl });
let db: Client;
const actor = '00000000-0000-4000-8000-000000000001',
  missionId = '20000000-0000-4000-8000-000000000001';
const oldDatabaseUrl = process.env['DATABASE_URL'];
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  db = new Client({ connectionString: url.toString() });
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
  process.env['DATABASE_URL'] = url.toString();
  process.env['LO_EXECUTION_MODE'] = 'local';
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  if (oldDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = oldDatabaseUrl;
  if (db) await db.end();
  await admin.query(`drop database if exists ${databaseName} with(force)`);
  await admin.end();
});

describe('real PostgreSQL snapshot → Option D view', () => {
  it('keeps seeded comparison geometry, source trust, recommendation and all six DB readiness levels', async () => {
    const snapshot = await readSnapshot(actor, missionId),
      view = projectMission(snapshot);
    const comparison = Object.values(view.artifacts).find(a => a.type === 'comparison');
    expect(comparison?.content.kind).toBe('canvas');
    if (comparison?.content.kind !== 'canvas') throw new Error('Expected comparison canvas');
    const shelf = comparison.content.frames.find(f => f.body.k === 'shelf');
    if (shelf?.body.k !== 'shelf') throw new Error('Expected shelf');
    expect(shelf.body.items).toHaveLength(3);
    expect(shelf.body.items[1]?.price).toMatchObject({
      trust: 'claimed',
      value: { kind: 'money', amount: { amountMinor: 240, currency: 'USD' } },
    });
    expect(shelf.body.items[1]?.price.source.reference).toBe('seed:quote-b');
    expect(shelf.body.items[1]?.tag).toBe('recommended');
    expect(shelf.body.items[1]?.plate.spec.dims_mm).toEqual({
      w: 42,
      h: 105,
      d: 28,
    });
    expect(view.readiness.outcomes).toHaveLength(6);
    for (const row of snapshot['readiness'] as Row[])
      expect(view.readiness.outcomes.find(r => r.outcome === row['outcome'])?.level).toBe(row['level']);
    expect(view.ledgerVersion).toBeGreaterThan(0);
    expect(view.sandbox).toBe(true);
    expect(view.money.receipts).toEqual([]);
    expect(view.money.totals.spent.amountMinor).toBe(0);
    expect(view.money.totals.forecast.source.label).toBe('No forecast recorded');
    expect(Object.values(view.artifacts).filter(a => a.type === 'visual')[0]?.content.kind).toBe('canvas');
  });
  it('a decision changes only in a later ledger snapshot, with a higher revision', async () => {
    const before = projectMission(await readSnapshot(actor, missionId));
    const pending = Object.values(before.decisions).find(d => d.status === 'pending');
    if (!pending) throw new Error('Expected pending fixture decision');
    await db.query('begin');
    try {
      await db.query('set local role founder_role');
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, mission_id: missionId })]);
      await db.query("select public.resolve_decision($1,$2,'approve',$3)", [missionId, pending.id, pending.recommendedOptionId]);
      await db.query('commit');
    } catch (error: unknown) {
      await db.query('rollback');
      throw error;
    }
    expect(before.decisions[pending.id]?.status).toBe('pending');
    const after = projectMission(await readSnapshot(actor, missionId));
    expect(after.decisions[pending.id]?.status).toBe('approved');
    expect(after.ledgerVersion).toBeGreaterThan(before.ledgerVersion);
    expect(projectMissionSummary(after).pendingDecisions).toBe(0);
  });
  it('second category uses the same renderer and its DB-derived Brand R2', async () => {
    const view = projectMission(await readSnapshot(actor, '20000000-0000-4000-8000-000000000002'));
    expect(view.readiness.outcomes.find(r => r.outcome === 'brand')?.level).toBe(2);
    expect(
      Object.values(view.artifacts)
        .map(a => a.type)
        .sort(),
    ).toEqual(['document', 'visual']);
    expect(JSON.stringify(view)).not.toMatch(/undefined|NaN/);
  });
  it('another founder cannot read the snapshot through SECURITY DEFINER', async () => {
    await expect(readSnapshot(randomUUID(), missionId)).rejects.toThrow(/mission denied/);
  });
  it('empty ledgers stay unexplored with no invented successes or receipts', () => {
    const view = projectMission({
      mission: {
        id: randomUUID(),
        founder_id: randomUUID(),
        currency: 'SAR',
        goal_brief: 'A first brief',
        sandbox_mode: true,
        metadata: { title: 'Untitled' },
      },
      status: 'active',
      ledger_version: 0,
    });
    expect(view.readiness.outcomes.every(r => r.level === 0)).toBe(true);
    expect(view.entries[0]?.blocks[0]?.k).toBe('empty');
    expect(view.artifacts).toEqual({});
    expect(view.activity).toEqual({});
    expect(view.money.totals.spent.amountMinor).toBe(0);
    expect(view.working.state).toBe('idle');
  });
  it('stale marks take precedence over a historical approved artifact status', async () => {
    const snapshot = await readSnapshot(actor, missionId);
    const artifact = (snapshot['artifacts'] as Row[])[0],
      version = (snapshot['artifact_versions'] as Row[]).find(v => v['artifact_id'] === artifact?.['id']);
    if (!version) throw new Error('Expected version');
    snapshot['stale_marks'] = [{ node_id: version['id'] ?? '', cause_id: randomUUID() }];
    const view = projectMission(snapshot);
    expect(view.artifacts[String(artifact?.['id'])]?.status).toBe('stale');
  });
  it('plate geometry is data driven across arbitrary kind labels', () => {
    const base = {
      dims_mm: { width: 20, height: 90, depth: 3 },
      parts: [
        { name: 'first', material: 'steel' },
        { name: 'second', material: 'wood' },
      ],
    };
    expect(projectPlate({ ...base, kind: 'one' }, 'A').spec.parts).toEqual(projectPlate({ ...base, kind: 'unrelated' }, 'B').spec.parts);
  });
  it('a mismatched source never lends its verified trust to a quote figure', async () => {
    const snapshot = await readSnapshot(actor, missionId);
    const comparison = (snapshot['artifacts'] as Row[]).find(a => a['type'] === 'comparison'),
      version = (snapshot['artifact_versions'] as Row[]).find(v => v['artifact_id'] === comparison?.['id']);
    if (!version || !version['content'] || typeof version['content'] !== 'object' || Array.isArray(version['content']))
      throw new Error('Fixture comparison missing');
    const content = version['content'],
      quotes = content['quotes'] as Row[];
    const quote = quotes[0];
    if (!quote) throw new Error('Fixture quote missing');
    quote['unitPriceMinor'] = 99999;
    const evidence = (snapshot['evidence'] as Row[]).find(e => e['id'] === quote['evidenceId']);
    if (!evidence) throw new Error('Fixture evidence missing');
    evidence['trust'] = 'verified';
    const view = projectMission(snapshot),
      canvas = view.artifacts[String(comparison?.['id'])]?.content;
    if (canvas?.kind !== 'canvas' || canvas.frames[0]?.body.k !== 'shelf') throw new Error('Fixture shelf missing');
    expect(canvas.frames[0].body.items[0]?.price.trust).toBe('planned');
    expect(canvas.frames[0].body.items[0]?.price.source.label).toContain('awaiting matching source');
  });
  it('finalized failed model runs stop the working signal without claiming completion', () => {
    const runId = randomUUID(),
      view = projectMission({
        mission: {
          id: randomUUID(),
          currency: 'SAR',
          goal_brief: 'Brief',
          sandbox_mode: true,
          metadata: {},
        },
        status: 'active',
        runs: [{ id: runId, status: 'scheduled' }],
        run_results: [
          {
            run_id: runId,
            result: { status: 'failed' },
            created_at: new Date().toISOString(),
          },
        ],
      });
    expect(view.working.state).toBe('blocked');
    expect(view.working.text).toContain('No completion');
  });
});
