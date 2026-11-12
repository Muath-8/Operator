import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';
import { ingestQuote, flagAcceptedTermChange } from './sourcing.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_sourcing_review_${Date.now()}`;
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

describe('independent changed supplier terms authority regression', () => {
  it('a known material change blocks the old accepted source at the actual effect version guard', async () => {
    const firstMessage = await sourceMessage(),
      prior = await ingestQuote(scope, { messageId: firstMessage, first: extractor('a'), second: extractor('b') });
    const accepted = await approvedArtifact('supply', { acceptedQuote: { quoteId: prior.id } }, [prior.sourceEvidenceId]);
    await expect(db.query('select private.check_version($1,$2)', [missionId, accepted.version])).resolves.toBeDefined();
    const nextMessage = await sourceMessage('Synthetic changed quotation from a new inbound message'),
      changed = await ingestQuote(scope, {
        messageId: nextMessage,
        first: extractor('a', { ...quote, unitPriceMinor: 252 }),
        second: extractor('b', { ...quote, unitPriceMinor: 252 }),
      });
    expect(await flagAcceptedTermChange(scope, { acceptedVersionId: accepted.version, quoteId: changed.id })).toMatchObject({
      needsDecision: true,
      changedFields: ['unitPriceMinor'],
    });
    // This is the same SQL guard called inside reserve_effect and begin_effect.
    // The database owner invokes it only as a read-only native review probe.
    await expect(db.query('select private.check_version($1,$2)', [missionId, accepted.version])).rejects.toThrow(/stale|changed|approval/);
  });
  it('a corrected accepted quote invalidates typed acceptance even when its author omitted explicit evidence refs', async () => {
    const source = await sourceMessage(),
      prior = await ingestQuote(scope, { messageId: source, first: extractor('a'), second: extractor('b') }),
      spec = await approvedArtifact('product', { synthetic: true }),
      accepted = await approvedArtifact(
        'supply',
        { acceptedQuote: { quoteId: prior.id, specVersionId: spec.version } },
        [],
        'quote_acceptance',
      );
    await withRole('founder_role', scope, c =>
      c.query('select public.accept_supplier_quote($1,$2,$3)', [missionId, accepted.decision, accepted.version]),
    );
    await ingestQuote(scope, {
      messageId: source,
      attemptKey: 'corrected-reading',
      first: extractor('a', { ...quote, unitPriceMinor: 252 }),
      second: extractor('b', { ...quote, unitPriceMinor: 252 }),
    });
    await expect(db.query('select private.check_version($1,$2)', [missionId, accepted.version])).rejects.toThrow(/stale|changed|approval/);
  });

  it('rechecks real quotation expiry at dispatch even when no source ledger changed after acceptance', async () => {
    const spec = await approvedArtifact('product', { synthetic: true }),
      source = await sourceMessage(),
      dated = { ...quote, validUntil: new Date(Date.now() + 2000).toISOString() },
      stored = await ingestQuote(scope, { messageId: source, first: extractor('a', dated), second: extractor('b', dated) }),
      accepted = await approvedArtifact(
        'supply',
        { acceptedQuote: { quoteId: stored.id, specVersionId: spec.version } },
        [],
        'quote_acceptance',
      );
    await withRole('founder_role', scope, c =>
      c.query('select public.accept_supplier_quote($1,$2,$3)', [missionId, accepted.decision, accepted.version]),
    );
    await expect(db.query('select private.check_version($1,$2)', [missionId, accepted.version])).resolves.toBeDefined();
    // Bounded real PostgreSQL clock wait, not an application clock override.
    await db.query('select pg_sleep(greatest(0,extract(epoch from $1::timestamptz-clock_timestamp()))+0.05)', [dated.validUntil]);
    await expect(db.query('select private.check_version($1,$2)', [missionId, accepted.version])).rejects.toThrow(
      /expired|validity|approval/,
    );
  });
});
