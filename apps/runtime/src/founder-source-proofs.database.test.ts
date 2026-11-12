import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';
import { executeFounderCommand, ledgerVersion } from './commands.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const admin = new Client({ connectionString: adminUrl }),
  name = `lo_source_proofs_${Date.now()}`;
let db: Client;
const prior = { ...process.env };
const user = '00000000-0000-4000-8000-000000000001',
  mission = '20000000-0000-4000-8000-000000000001',
  scope = { authUserId: user, missionId: mission };
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
  for (const file of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(`${root}/supabase/migrations/${file}`, 'utf8'));
  await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
  process.env.DATABASE_URL = url.href;
  process.env.LO_EXECUTION_MODE = 'local';
  process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
  process.env.PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
});

async function proposal(
  content: object,
  outcome = 'commerce',
  gate = 'shipping_rate_confirmed',
  kind = 'engagement',
  type = 'founder_confirmation',
) {
  const p = await withRole('lead_role', scope, async d => {
    const a = (await d.query('select public.create_artifact($1,$2,$3,$4)id', [mission, type, outcome, 'Synthetic source proof'])).rows[0]
      ?.id;
    const version = (await d.query('select public.append_artifact_version($1,$2,$3)id', [mission, a, content])).rows[0]?.id as string;
    await d.query("select public.set_artifact_status($1,$2,'proposed')", [mission, version]);
    const packet = {
      question: 'Confirm the returned source?',
      options: [
        {
          id: 'yes',
          label: 'Confirm exact source',
          artifactVersionIds: [version],
          evidenceIds: [],
          cost: null,
          timeDays: 0,
          consequences: 'Record explicit founder evidence',
        },
      ],
      recommendation: { optionId: 'yes', reasons: ['Review actual source'] },
      approvedVersionIds: [version],
      staleImpact: [],
      defaultIfNoAnswer: { optionId: 'yes', at: null, binding: true },
    };
    const decision = (await d.query('select public.propose_decision($1,$2,$3,$4,$5)id', [mission, kind, packet, outcome, gate])).rows[0]
      ?.id as string;
    return { version, decision };
  });
  return {
    ...p,
    approve: async () =>
      executeFounderCommand(user, {
        kind: 'resolveDecision',
        missionId: mission,
        idempotencyKey: randomUUID(),
        seenLedgerVersion: await withRole('founder_role', scope, d => ledgerVersion(d, mission)),
        decisionId: p.decision,
        response: 'approve',
        optionId: 'yes',
      }),
  };
}
async function evidence() {
  return withRole(
    'founder_role',
    scope,
    async d =>
      (
        await d.query(
          "select public.append_evidence($1,'commerce','returned_document','founder_confirmed',$2,'document','synthetic-test')id",
          [mission, { summary: 'Synthetic returned source' }],
        )
      ).rows[0]?.id as string,
  );
}
const confirmation = (kind: string, payload: object, outcome = 'commerce') => ({
  founderConfirmation: { kind, outcome, statement: 'I reviewed this exact returned source.', payload },
});
describe('native founder source acceptance', () => {
  it('requires current returned source, stores exact shipping rate once, and links dependencies', async () => {
    const ev = await evidence(),
      payload = { rate: { amountMinor: 2500, currency: 'SAR', countryCode: 'SA', rateName: 'Standard' }, sourceEvidenceIds: [ev] };
    const p = await proposal(confirmation('shipping_rate_confirmed', payload));
    await p.approve();
    const fact = (
      await db.query("select id,payload from public.evidence where mission_id=$1 and kind='shipping_rate_confirmed'", [mission])
    ).rows[0];
    expect(fact?.payload.rate).toEqual(payload.rate);
    await withRole('founder_role', scope, d =>
      d.query('select public.confirm_founder_artifact($1,$2,$3)', [mission, p.decision, p.version]),
    );
    expect((await db.query('select from public.dependencies where upstream_id=$1 and dependent_id=$2', [ev, fact?.id])).rowCount).toBe(1);
    expect((await db.query("select from public.evidence where mission_id=$1 and kind='shipping_rate_confirmed'", [mission])).rowCount).toBe(
      1,
    );
  });
  it('rejects unsourced rate and malformed country atomically', async () => {
    const ev = await evidence();
    for (const payload of [
      { rate: { amountMinor: 10, currency: 'SAR', countryCode: 'SA', rateName: 'Rate' }, sourceEvidenceIds: [] },
      { rate: { amountMinor: 10, currency: 'SAR', countryCode: 'Saudi Arabia', rateName: 'Rate' }, sourceEvidenceIds: [ev] },
    ]) {
      const p = await proposal(confirmation('shipping_rate_confirmed', payload));
      await expect(p.approve()).rejects.toThrow(/validation/);
      expect((await db.query('select from public.decision_resolutions where decision_id=$1', [p.decision])).rowCount).toBe(0);
    }
  });
  it('verifies only a selected current kit with returned evidence, never arbitrary target IDs', async () => {
    const ev = await evidence();
    const kit = await proposal(
      {
        title: 'Connect founder account',
        whereToGo: 'https://example.test',
        whatToEnter: ['Business details'],
        whatToBringBack: ['Ownership proof'],
        howVerified: 'Founder reviews ownership proof',
        status: 'prepared',
        evidenceIds: [],
      },
      'commerce',
      'founder_kit',
      'selection',
      'founder_kit',
    );
    await kit.approve();
    const invalid = await proposal(
      confirmation('kit_verified', { kitVersionId: randomUUID(), sourceEvidenceIds: [ev] }),
      'commerce',
      'kit_verified',
    );
    await expect(invalid.approve()).rejects.toThrow(/approved kit/);
    const p = await proposal(
      confirmation('kit_verified', { kitVersionId: kit.version, sourceEvidenceIds: [ev] }),
      'commerce',
      'kit_verified',
    );
    await p.approve();
    expect(
      (await db.query("select payload from public.evidence where mission_id=$1 and kind='kit_verified'", [mission])).rows[0]?.payload
        .kitVersionId,
    ).toBe(kit.version);
  });
  it('accepts actual double-read quote terms, denies model-supplied replacement amounts, and enforces tenant scope', async () => {
    const supplier = (
      await db.query(
        "select c.id from public.counterparties c join public.missions m on m.founder_id=c.founder_id where m.id=$1 and c.kind='supplier'limit 1",
        [mission],
      )
    ).rows[0]?.id;
    const thread = (await db.query('insert into public.threads(mission_id,counterparty_id)values($1,$2)returning id', [mission, supplier]))
      .rows[0]?.id;
    const message = (
      await db.query(
        "insert into public.messages(mission_id,thread_id,channel,direction,original,provider_id)values($1,$2,'email','inbound','Synthetic source quote',$3)returning id",
        [mission, thread, randomUUID()],
      )
    ).rows[0]?.id;
    const reading = {
      currency: 'SAR',
      unitPriceMinor: 240,
      moq: 500,
      leadDays: 20,
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      incoterm: 'FOB',
      depositPercent: 30,
      tiers: [],
      terms: 'Synthetic written quotation',
      language: 'en',
      unit: 'unit',
      dimensionsMm: { neck: 20 },
    };
    const quote = await withRole(
      'specialist_role',
      scope,
      async d =>
        (
          await d.query('select public.record_sourcing_readings($1,$2,$3,$4,$5)result', [
            mission,
            message,
            'source-acceptance',
            { extractorId: 'first', reading, failure: null },
            { extractorId: 'second', reading, failure: null },
          ])
        ).rows[0]?.result,
    );
    const spec = (
      await db.query(
        "select v.id from public.artifact_versions v join public.artifacts a on a.id=v.artifact_id where v.mission_id=$1 and a.type='product_spec'limit 1",
        [mission],
      )
    ).rows[0]?.id;
    const invalid = await proposal(
      { acceptedQuote: { quoteId: quote.id, specVersionId: spec, unitPriceMinor: 1 } },
      'supply',
      'quote_acceptance',
      'selection',
      'accepted_quote',
    );
    await expect(invalid.approve()).rejects.toThrow(/stored source/);
    const p = await proposal(
      { acceptedQuote: { quoteId: quote.id, specVersionId: spec } },
      'supply',
      'quote_acceptance',
      'selection',
      'accepted_quote',
    );
    await p.approve();
    const fact = (await db.query("select payload from public.evidence where mission_id=$1 and kind='accepted_quote'", [mission])).rows[0]
      ?.payload;
    expect(fact.terms).toEqual(reading);
    expect(fact.supplierId).toBe(supplier);
    await expect(
      withRole('founder_role', { authUserId: randomUUID() }, d =>
        d.query('select public.accept_supplier_quote($1,$2,$3)', [mission, p.decision, p.version]),
      ),
    ).rejects.toThrow(/mission denied/);
    await expect(
      withRole('specialist_role', scope, d => d.query('select public.accept_supplier_quote($1,$2,$3)', [mission, p.decision, p.version])),
    ).rejects.toThrow(/permission denied/);
  });
});
