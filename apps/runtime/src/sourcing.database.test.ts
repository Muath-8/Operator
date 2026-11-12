import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';
import { ingestQuote, normalizeQuote, assessQuoteRoute, recordScorecard, flagAcceptedTermChange } from './sourcing.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_sourcing_${Date.now()}`;
const admin = new Client({ connectionString: adminUrl });
let db: Client;
const priorEnv = { ...process.env },
  actor = '00000000-0000-4000-8000-000000000001',
  missionId = '20000000-0000-4000-8000-000000000001';
const scope = { authUserId: actor, missionId };
let supplierId: string, specId: string, messageId: string;
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
async function approvedArtifact(outcome: 'product' | 'supply', content: unknown, evidenceIds: string[] = []) {
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
      (await client.query("select public.propose_decision($1,'selection',$2,$3,'specification') id", [missionId, packet, outcome])).rows[0]
        ?.id,
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
  specId = String(
    (
      await db.query(
        "select v.id from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id where v.mission_id=$1 and a.type='product_spec'limit 1",
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
describe('native sourcing append-only failure and authority paths', () => {
  it('persists two independent readings, source-linked claimed evidence, and replay without extractor calls', async () => {
    const first = extractor('small-config'),
      second = extractor('mid-config');
    const result = await ingestQuote(scope, { messageId, first, second, attemptKey: 'recorded-once' });
    expect(result.status).toBe('confirmed_reading');
    expect(first.extract).toHaveBeenCalledTimes(1);
    expect(second.extract).toHaveBeenCalledTimes(1);
    const replay = await ingestQuote(scope, { messageId, first, second, attemptKey: 'recorded-once' });
    expect(replay.id).toBe(result.id);
    expect(first.extract).toHaveBeenCalledTimes(1);
    await expect(ingestQuote(scope, { messageId, attemptKey: 'recorded-once', first: extractor('changed'), second })).rejects.toThrow(
      'configuration changed',
    );
    expect(
      (await db.query('select count(*)::integer n from public.sourcing_quote_readings where ingestion_id=$1', [result.id])).rows[0]?.n,
    ).toBe(2);
    expect((await db.query('select trust,source_reference from public.evidence where id=$1', [result.sourceEvidenceId])).rows[0]).toEqual({
      trust: 'claimed',
      source_reference: `message:${messageId}`,
    });
    expect((await normalizeQuote(scope, { quoteId: result.id, targetCurrency: 'SAR' })).unitPriceMinor).toBe(240);
  });
  it('a contradictory/missing currency is stored as clarification and cannot be normalized', async () => {
    const result = await ingestQuote(scope, {
      messageId,
      attemptKey: 'contradiction',
      first: extractor('small', { ...quote, currency: null }),
      second: extractor('mid', { ...quote, currency: 'USD' }),
    });
    expect(result.status).toBe('needs_clarification');
    expect(result.quote).toBeNull();
    expect(result.unconfirmedFields).toContain('currency');
    expect(result.missingFields).toContain('currency');
    await expect(normalizeQuote(scope, { quoteId: result.id, targetCurrency: 'SAR' })).rejects.toThrow('unconfirmed');
  });
  it('failed model extraction remains failed instead of a successful supplier quote', async () => {
    const result = await ingestQuote(scope, {
      messageId,
      attemptKey: 'model-failed',
      first: {
        id: 'small',
        extract: async () => {
          throw new Error('provider secret must not be stored');
        },
      },
      second: extractor('mid'),
    });
    expect(result.status).toBe('extraction_failed');
    expect(result.clarification).toBeNull();
    const saved = await db.query('select failure,reading from public.sourcing_quote_readings where ingestion_id=$1 order by ordinal', [
      result.id,
    ]);
    expect(saved.rows[0]).toMatchObject({ failure: 'provider_down', reading: null });
    expect(JSON.stringify(saved.rows)).not.toContain('provider secret');
  });
  it('another founder cannot even load source text or trigger extraction', async () => {
    const first = extractor('a'),
      second = extractor('b');
    await expect(ingestQuote({ authUserId: randomUUID(), missionId }, { messageId, first, second })).rejects.toThrow('mission denied');
    expect(first.extract).not.toHaveBeenCalled();
  });
  it('rejects a founder conversation as a fabricated supplier source', async () => {
    const founderMessage = String(
      (await db.query("select id from public.messages where mission_id=$1 and direction='lead'limit 1", [missionId])).rows[0]?.id,
    );
    await expect(ingestQuote(scope, { messageId: founderMessage, first: extractor('a'), second: extractor('b') })).rejects.toThrow(
      'supplier source',
    );
  });
  it('direct ledger mutation and founder extraction writes are denied', async () => {
    await expect(
      withRole('specialist_role', scope, client =>
        client.query('delete from public.sourcing_quote_readings where mission_id=$1', [missionId]),
      ),
    ).rejects.toThrow('permission denied');
    await expect(
      withRole('founder_role', scope, client =>
        client.query('select public.record_sourcing_readings($1,$2,$3,$4,$5)', [missionId, messageId, 'forged', {}, {}]),
      ),
    ).rejects.toThrow('permission denied');
  });
  it('SQL independently rejects a reused extractor and malformed term types', async () => {
    const outcome = { extractorId: 'same', reading: quote, failure: null };
    await expect(
      withRole('specialist_role', scope, client =>
        client.query('select public.record_sourcing_readings($1,$2,$3,$4,$5)', [missionId, messageId, 'same-reader', outcome, outcome]),
      ),
    ).rejects.toThrow('independent');
    await expect(
      withRole('specialist_role', scope, client =>
        client.query('select public.record_sourcing_readings($1,$2,$3,$4,$5)', [
          missionId,
          messageId,
          'bad-types',
          { ...outcome, reading: { ...quote, unitPriceMinor: '240' } },
          { ...outcome, extractorId: 'other' },
        ]),
      ),
    ).rejects.toThrow('quote number');
  });
  it('assessment requires a current approved product source and active supplier-specific bounds', async () => {
    const result = await ingestQuote(scope, { messageId, attemptKey: 'for-assessment', first: extractor('a'), second: extractor('b') });
    await expect(
      assessQuoteRoute(scope, { quoteId: result.id, specVersionId: specId, negotiationMandateId: randomUUID() }),
    ).rejects.toThrow('negotiation bounds');
    await expect(recordScorecard(scope, { quoteId: result.id, specVersionId: randomUUID(), observations: [] })).rejects.toThrow(
      'approved specification',
    );
    const board = await recordScorecard(scope, { quoteId: result.id, specVersionId: specId, observations: [] });
    expect(board.cells).toHaveLength(8);
    expect(board.cells.every(c => c.label === 'not yet observed')).toBe(true);
    await expect(
      withRole('specialist_role', scope, client =>
        client.query('select public.record_sourcing_assessment($1,$2,$3,null,$4)', [
          missionId,
          result.id,
          specId,
          { kind: 'scorecard', cells: [] },
        ]),
      ),
    ).rejects.toThrow('eight unique');
  });
  it('native shortlist requires approved compatibility, current independent signals and actual bounds', async () => {
    const msg = await sourceMessage(),
      stored = await ingestQuote(scope, { messageId: msg, first: extractor('small'), second: extractor('mid') });
    const spec = await approvedArtifact('product', {
      sourcingCompatibility: {
        dimensionsMm: { neck: 20 },
        rules: [{ left: 'quote.neck', right: 'spec.neck', relation: 'equal', toleranceMm: 0.1 }],
      },
    });
    const mandate = randomUUID();
    await db.query(
      "insert into public.mandates(id,mission_id,decision_id,type,scope,ceiling_per,ceiling_total,currency,expires_at)values($1,$2,$3,'negotiation',$4,0,0,'SAR',clock_timestamp()+interval'1 day')",
      [
        mandate,
        missionId,
        spec.decision,
        {
          counterpartyIds: [supplierId],
          bounds: { currency: 'SAR', maxUnitPriceMinor: 250, maxMoq: 1000, maxLeadDays: 30, maxDepositPercent: 30 },
        },
      ],
    );
    const denied = await assessQuoteRoute(scope, { quoteId: stored.id, specVersionId: spec.version, negotiationMandateId: mandate });
    expect(denied.eligible).toBe(false);
    expect(denied.reasons).toContain('supplier_verification_missing');
    const signals: string[] = [];
    for (const [source, kind] of [
      ['registry.test', 'registry'],
      ['inspection.test', 'address'],
    ])
      signals.push(
        await withRole('founder_role', scope, async client =>
          String(
            (
              await client.query(
                "select public.append_evidence($1,'supply','supplier_signal','founder_confirmed',$2,'document','synthetic-review') id",
                [missionId, { supplierId, independentSource: source, signalKind: kind }],
              )
            ).rows[0]?.id,
          ),
        ),
      );
    expect(
      (await assessQuoteRoute(scope, { quoteId: stored.id, specVersionId: spec.version, negotiationMandateId: mandate })).eligible,
    ).toBe(true);
    await expect(
      recordScorecard(scope, {
        quoteId: stored.id,
        specVersionId: spec.version,
        observations: [
          { criterion: 'price', score: 4, evidenceIds: [signals[0]], reason: 'A registry lookup is not a price observation.' },
        ],
      }),
    ).rejects.toThrow('criterion');
    const board = await recordScorecard(scope, {
      quoteId: stored.id,
      specVersionId: spec.version,
      observations: [
        {
          criterion: 'price',
          score: 4,
          evidenceIds: [stored.sourceEvidenceId],
          reason: 'Source quote price on the stated unit and trade basis.',
        },
      ],
    });
    expect(board.cells.find(c => c.criterion === 'price')?.label).toBe('observed');
    await withRole('founder_role', scope, client =>
      client.query("select public.append_evidence($1,'supply','supplier_signal','claimed',$2,'document','corrected',null,$3)", [
        missionId,
        { supplierId, independentSource: 'registry.test', signalKind: 'registry' },
        signals[0],
      ]),
    );
    expect(
      (await assessQuoteRoute(scope, { quoteId: stored.id, specVersionId: spec.version, negotiationMandateId: mandate })).eligible,
    ).toBe(false);
  });
  it('changed accepted terms durably wake the Lead once and never silently replace the approval', async () => {
    const firstMessage = await sourceMessage(),
      prior = await ingestQuote(scope, { messageId: firstMessage, first: extractor('a'), second: extractor('b') });
    const accepted = await approvedArtifact('supply', { acceptedQuote: { quoteId: prior.id } }, [prior.sourceEvidenceId]);
    const nextMessage = await sourceMessage('Synthetic price increased by 5%'),
      next = await ingestQuote(scope, {
        messageId: nextMessage,
        first: extractor('a', { ...quote, unitPriceMinor: 252 }),
        second: extractor('b', { ...quote, unitPriceMinor: 252 }),
      });
    const signal = await flagAcceptedTermChange(scope, { acceptedVersionId: accepted.version, quoteId: next.id });
    expect(signal).toMatchObject({ needsDecision: true, changedFields: ['unitPriceMinor'] });
    expect((await flagAcceptedTermChange(scope, { acceptedVersionId: accepted.version, quoteId: next.id })).id).toBe(signal.id);
    expect(
      (
        await db.query(
          "select count(*)::integer n from public.outbox where mission_id=$1 and type='sourcing.accepted_terms_changed'and payload->>'changeId'=$2",
          [missionId, signal.id],
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      (await db.query('select id from public.active_decisions where mission_id=$1 and id=$2', [missionId, accepted.decision])).rowCount,
    ).toBe(0);
    expect(
      (await db.query('select id from public.decision_resolutions where mission_id=$1 and decision_id=$2', [missionId, accepted.decision]))
        .rowCount,
    ).toBe(1);
    expect(
      (await db.query('select id from public.stale_marks where mission_id=$1 and node_id=$2', [missionId, accepted.version])).rowCount,
    ).toBeGreaterThan(0);
  });
});
