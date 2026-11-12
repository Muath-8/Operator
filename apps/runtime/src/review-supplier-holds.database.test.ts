import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';
import { ingestQuote } from './sourcing.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_review_supplier_holds_${Date.now()}`;
const admin = new Client({ connectionString: adminUrl });
let db: Client;
const priorEnv = { ...process.env },
  actor = '00000000-0000-4000-8000-000000000001',
  missionId = '20000000-0000-4000-8000-000000000001';
const scope = { authUserId: actor, missionId };
let supplierId: string, messageId: string;
const quote = {
  currency: 'SAR',
  unitPriceMinor: 240,
  moq: 500,
  leadDays: 20,
  validUntil: new Date(Date.now() + 86400000).toISOString(),
  incoterm: 'FOB',
  depositPercent: 30,
  tiers: [],
  terms: 'Exact synthetic source quote.',
  language: 'en',
  unit: 'unit',
  dimensionsMm: { neck: 20 },
};
const extractor = (id: string, result: unknown = quote) => ({ id, extract: vi.fn(async () => result) });
async function approvedArtifact(outcome: 'product' | 'supply', content: unknown, evidenceIds: string[] = [], gate = 'specification') {
  const created = await withRole('lead_role', scope, async client => {
    const artifact = String(
      (
        await client.query('select public.create_artifact($1,$2,$3,$4) id', [
          missionId,
          outcome === 'product' ? 'product_spec' : 'quotation',
          outcome,
          'Sourcing native test artifact',
        ])
      ).rows[0]?.id,
    );
    const version = String(
      (
        await client.query('select public.append_artifact_version($1,$2,$3,$4,$5,$6) id', [
          missionId,
          artifact,
          content,
          [],
          [],
          evidenceIds,
        ])
      ).rows[0]?.id,
    );
    await client.query("select public.set_artifact_status($1,$2,'proposed')", [missionId, version]);
    const packet = {
      question: 'Approve this exact synthetic source?',
      options: [
        {
          id: 'a',
          label: 'Approve exact source',
          artifactVersionIds: [version],
          evidenceIds,
          cost: null,
          timeDays: 0,
          consequences: 'Synthetic test only',
        },
      ],
      approvedVersionIds: [version],
      recommendation: { optionId: 'a', reasons: ['Synthetic reviewed source'] },
      staleImpact: [],
      defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
    };
    const decision = String(
      (await client.query("select public.propose_decision($1,'selection',$2,$3,$4) id", [missionId, packet, outcome, gate])).rows[0]?.id,
    );
    return { version, decision };
  });
  await withRole('founder_role', scope, async client => {
    await client.query("select public.resolve_decision($1,$2,'approve','a')", [missionId, created.decision]);
    await client.query("select public.set_artifact_status($1,$2,'approved',$3)", [missionId, created.version, created.decision]);
  });
  return created;
}
async function sourceMessage(text = 'Second synthetic supplier quotation') {
  const thread = String((await db.query('select thread_id from public.messages where id=$1', [messageId])).rows[0]?.thread_id);
  return String(
    (
      await db.query(
        "insert into public.messages(mission_id,thread_id,channel,direction,original,provider_id)values($1,$2,'email','inbound',$3,$4)returning id",
        [missionId, thread, text, randomUUID()],
      )
    ).rows[0]?.id,
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
  for (const file of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort()) {
    try {
      await db.query(await readFile(`${root}/supabase/migrations/${file}`, 'utf8'));
    } catch (error) {
      throw new Error(`Migration ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  supplierId = String(
    (
      await db.query(
        "select c.id from public.counterparties c join public.missions m on m.founder_id=c.founder_id where m.id=$1 and c.kind='supplier'limit 1",
        [missionId],
      )
    ).rows[0]?.id,
  );
  const thread = String(
    (await db.query('insert into public.threads(mission_id,counterparty_id)values($1,$2)returning id', [missionId, supplierId])).rows[0]
      ?.id,
  );
  messageId = String(
    (
      await db.query(
        "insert into public.messages(mission_id,thread_id,channel,direction,original,provider_id)values($1,$2,'email','inbound','Synthetic quotation: SAR2.40 per unit, MOQ500, FOB, 30% deposit, 20 days.',$3)returning id",
        [missionId, thread, randomUUID()],
      )
    ).rows[0]?.id,
  );
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = priorEnv;
  await db?.end();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
});

describe('independent supplier hold forward migration', () => {
  it('blocks a legacy accepted quote whose specification was superseded before dependency backfill', async () => {
    const source = await sourceMessage(),
      stored = await ingestQuote(scope, { messageId: source, first: extractor('a'), second: extractor('b') }),
      spec = await approvedArtifact('product', { synthetic: true }),
      accepted = await approvedArtifact(
        'supply',
        { acceptedQuote: { quoteId: stored.id, specVersionId: spec.version } },
        [stored.sourceEvidenceId],
        'quote_acceptance',
      );
    // Legacy accepted rows did not bind spec->accepted version. No immutable row is edited.
    const artifact = (await db.query('select artifact_id from public.artifact_versions where id=$1', [spec.version])).rows[0]?.artifact_id;
    await withRole('lead_role', scope, d =>
      d.query('select public.append_artifact_version($1,$2,$3)', [missionId, artifact, { synthetic: 'changed specification' }]),
    );
    const migration = await readFile(`${root}/supabase/migrations/202611120037_sourcing_change_holds.sql`, 'utf8');
    await db.query(migration.slice(migration.indexOf('-- Tighten already accepted history')));
    expect(
      (
        await db.query('select from public.dependencies where mission_id=$1 and upstream_id=$2 and dependent_id=$3', [
          missionId,
          spec.version,
          accepted.version,
        ])
      ).rowCount,
    ).toBeGreaterThan(0);
    const repair = await readFile(`${root}/supabase/migrations/202611120038_metric_and_dispatch_guards.sql`, 'utf8');
    const start = repair.indexOf('do $$declare r record;begin'),
      end = repair.indexOf('create function public.lock_pending_outbox');
    await db.query(repair.slice(start, end));
    expect(
      (await db.query('select from public.stale_marks where mission_id=$1 and node_id=$2', [missionId, accepted.version])).rowCount,
    ).toBeGreaterThan(0);
    await expect(db.query('select private.check_version($1,$2)', [missionId, accepted.version])).rejects.toThrow(
      /stale|specification|approval/,
    );
  });
});
