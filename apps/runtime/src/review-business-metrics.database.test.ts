import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';
import { executeFounderCommand, ledgerVersion } from './commands.js';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const admin = new Client({ connectionString: adminUrl }),
  name = `lo_review_metrics_${Date.now()}`;
let db: Client;
const prior = { ...process.env };
const user = '00000000-0000-4000-8000-000000000001',
  mission = '20000000-0000-4000-8000-000000000001',
  scope = { authUserId: user, missionId: mission };
const identity = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../web/src/lib/auth', () => ({
  currentActor: async () => (identity.enabled ? { authUserId: '00000000-0000-4000-8000-000000000001' } : null),
}));
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

async function line(key: string = randomUUID(), amount = 200) {
  return withRole(
    'specialist_role',
    scope,
    async d =>
      (
        await d.query('select public.record_cost_estimate($1,$2,$3,$4,$5)id', [
          mission,
          key,
          'Independent synthetic estimate',
          amount,
          'SAR',
        ])
      ).rows[0]?.id as string,
  );
}
async function acceptedSource(payload: object, missionId = mission) {
  return withRole(
    'founder_role',
    { authUserId: user, missionId },
    async d =>
      (
        await d.query("select public.append_evidence($1,'supply','accepted_quote','founder_confirmed',$2,'document',$3)id", [
          missionId,
          payload,
          randomUUID(),
        ])
      ).rows[0]?.id as string,
  );
}
async function report() {
  return withRole('founder_role', scope, async d => (await d.query('select public.mission_business_metrics($1)r', [mission])).rows[0]?.r);
}
async function accept(costAcceptance: object) {
  const p = await proposal({ costAcceptance }, 'commerce', 'accepted_cost', 'selection', 'cost_acceptance');
  await p.approve();
  return p;
}

describe('independent metrics authority and content boundaries', () => {
  it('rejects a foreign source, stale source, zero or oversized quantity without resolving approval', async () => {
    const costLineId = await line(),
      current = await acceptedSource({ unitPriceMinor: 120, currency: 'SAR' }),
      foreign = await acceptedSource({ unitPriceMinor: 120, currency: 'SAR' }, '20000000-0000-4000-8000-000000000002');
    const stale = await acceptedSource({ unitPriceMinor: 120, currency: 'SAR' });
    await withRole('founder_role', scope, d =>
      d.query("select public.append_evidence($1,'supply','accepted_quote','founder_confirmed',$2,'document',$3,null,$4)", [
        mission,
        { unitPriceMinor: 121, currency: 'SAR' },
        randomUUID(),
        stale,
      ]),
    );
    for (const costAcceptance of [
      { costLineId, evidenceId: foreign },
      { costLineId, evidenceId: stale },
      { costLineId, evidenceId: current, quantity: 0 },
      { costLineId, evidenceId: current, quantity: 1000000000 },
      { costLineId, evidenceId: current, amountMinor: 1 },
    ]) {
      const p = await proposal({ costAcceptance }, 'commerce', 'accepted_cost', 'selection', 'cost_acceptance');
      await expect(p.approve()).rejects.toThrow();
      expect((await db.query('select from public.decision_resolutions where decision_id=$1', [p.decision])).rowCount).toBe(0);
    }
  });
  it('uses explicit quantity and current sourced FX with conservative rounding', async () => {
    const costLineId = await line(),
      source = await acceptedSource({ unitPriceMinor: 3, currency: 'USD' });
    const fx = (
      await db.query(
        "insert into public.fx_quotes(mission_id,from_currency,to_currency,numerator,denominator,source,observed_at,expires_at,payload_hash,rate_payload)values($1,'USD','SAR',15,4,'https://www.sama.gov.sa/en-US/Currency/FinExc/pages/currency.aspx',clock_timestamp(),clock_timestamp()+interval '1 hour',$2,'{}')returning id",
        [mission, 'a'.repeat(64)],
      )
    ).rows[0]?.id;
    await accept({ costLineId, evidenceId: source, quantity: 3, fxQuoteId: fx });
    expect((await report()).estimateAccuracy.find((r: { lineId: string }) => r.lineId === costLineId)).toMatchObject({ acceptedMinor: 34 });
    const missing = await proposal(
      { costAcceptance: { costLineId: await line(), evidenceId: source } },
      'commerce',
      'accepted_cost',
      'selection',
      'cost_acceptance',
    );
    await expect(missing.approve()).rejects.toThrow();
  });
  it('rejects expired or foreign FX and keeps a zero estimate denominator unknown', async () => {
    const source = await acceptedSource({ unitPriceMinor: 1, currency: 'USD' });
    for (const [fxMission, expiry] of [
      [mission, '-1 second'],
      ['20000000-0000-4000-8000-000000000002', '1 hour'],
    ]) {
      const fx = (
        await db.query(
          "insert into public.fx_quotes(mission_id,from_currency,to_currency,numerator,denominator,source,observed_at,expires_at,payload_hash,rate_payload)values($1,'USD','SAR',15,4,'https://www.sama.gov.sa/en-US/Currency/FinExc/pages/currency.aspx',clock_timestamp(),clock_timestamp()+$2::interval,$3,'{}')returning id",
          [fxMission, expiry, randomUUID().replaceAll('-', '').repeat(2)],
        )
      ).rows[0]?.id;
      await expect(accept({ costLineId: await line(), evidenceId: source, fxQuoteId: fx })).rejects.toThrow();
    }
    const costLineId = await line(randomUUID(), 0);
    await accept({ costLineId, evidenceId: await acceptedSource({ unitPriceMinor: 0, currency: 'SAR' }) });
    expect((await report()).estimateAccuracy.find((r: { lineId: string }) => r.lineId === costLineId)).toMatchObject({
      firstEstimateMinor: 0,
      acceptedMinor: 0,
      relativeError: null,
    });
  });
  it('keeps accepted historical amounts explicit when their source is later corrected', async () => {
    const costLineId = await line(),
      source = await acceptedSource({ unitPriceMinor: 120, currency: 'SAR' });
    await accept({ costLineId, evidenceId: source });
    await withRole('founder_role', scope, d =>
      d.query("select public.append_evidence($1,'supply','accepted_quote','founder_confirmed',$2,'document',$3,null,$4)", [
        mission,
        { unitPriceMinor: 999, currency: 'SAR' },
        randomUUID(),
        source,
      ]),
    );
    const cost = (await report()).estimateAccuracy.find((r: { lineId: string }) => r.lineId === costLineId);
    expect(cost.acceptedMinor === null || cost.sourceCurrent === false || cost.status === 'historical').toBe(true);
  });
  it('does not leak mission-authored free text into content-free operator metrics', async () => {
    const marker = 'CONFIDENTIAL CUSTOMER STRATEGY synthetic privacy probe';
    await line(marker);
    await db.query('begin');
    try {
      await db.query('set local role operator_role');
      const value = (await db.query('select public.operator_business_metrics()r')).rows[0]?.r;
      expect(JSON.stringify(value)).not.toContain(marker);
    } finally {
      await db.query('rollback');
    }
  });
  it('keeps unobserved denominators unknown and provenance tied to committed ledger rows', async () => {
    const r = await report();
    expect(r.verifiedSupplierResponseRate).toBeNull();
    expect(r.modeCEffortMinutes).toBeNull();
    const observations = (await db.query('select * from public.readiness_observations where mission_id=$1', [mission])).rows;
    expect(observations.length).toBeGreaterThan(0);
    for (const o of observations) {
      expect(Number(o.source_revision)).toBeGreaterThan(0);
      expect(
        (await db.query('select from public.ledger_events where mission_id=$1 and revision=$2', [mission, o.source_revision])).rowCount,
      ).toBe(1);
      expect((await db.query(`select from public.${o.cause_table} where id=$1 and mission_id=$2`, [o.cause_id, mission])).rowCount).toBe(1);
    }
  });
  it('does not count an expired quote as a currently usable verified supplier response', async () => {
    const supplier = '30000000-0000-4000-8000-000000000001';
    const thread = (await db.query('insert into public.threads(mission_id,counterparty_id)values($1,$2)returning id', [mission, supplier]))
      .rows[0]?.id;
    const message = (
      await db.query(
        "insert into public.messages(mission_id,thread_id,channel,direction,original,provider_id)values($1,$2,'email','inbound','Synthetic expired written quotation',$3)returning id",
        [mission, thread, randomUUID()],
      )
    ).rows[0]?.id;
    const quote = {
      currency: 'SAR',
      unitPriceMinor: 240,
      moq: 500,
      leadDays: 20,
      validUntil: new Date(Date.now() - 60_000).toISOString(),
      incoterm: 'FOB',
      depositPercent: 30,
      tiers: [],
      terms: 'Expired synthetic terms',
      language: 'en',
      unit: 'unit',
      dimensionsMm: { neck: 20 },
    };
    await withRole('specialist_role', scope, d =>
      d.query('select public.record_sourcing_readings($1,$2,$3,$4,$5)', [
        mission,
        message,
        randomUUID(),
        { extractorId: 'independent-a', reading: quote, failure: null },
        { extractorId: 'independent-b', reading: quote, failure: null },
      ]),
    );
    for (const [signalKind, independentSource] of [
      ['registry', 'synthetic-registry'],
      ['address', 'synthetic-address'],
    ])
      await withRole('founder_role', scope, d =>
        d.query("select public.append_evidence($1,'supply','supplier_signal','founder_confirmed',$2,'document',$3)", [
          mission,
          { supplierId: supplier, signalKind, independentSource },
          randomUUID(),
        ]),
      );
    // Explicit synthetic receipt fixture, not an actual message send or provider proof.
    const decision = (await db.query('select id from public.decisions where mission_id=$1 limit 1', [mission])).rows[0]?.id;
    const approval = (
      await db.query(
        "insert into public.approvals(mission_id,decision_id,binding,token_hash,expires_at)values($1,$2,'{}',$3,clock_timestamp()+interval '1 hour')returning id",
        [mission, decision, 'b'.repeat(64)],
      )
    ).rows[0]?.id;
    const auth = (
      await db.query(
        'insert into public.effect_authorizations(mission_id,intent,intent_hash,idempotency_key,approval_id,sandbox_mode)values($1,$2,$3,$4,$5,true)returning id',
        [mission, { counterpartyId: supplier }, 'c'.repeat(64), randomUUID(), approval],
      )
    ).rows[0]?.id;
    await db.query(
      "insert into public.provider_receipts(mission_id,authorization_id,provider,provider_reference,operation,sandbox_mode,data)values($1,$2,'synthetic-test',$3,'send_message',true,'{}')",
      [mission, auth, randomUUID()],
    );
    const r = await report();
    expect(r.supplierContacted).toBe(1);
    expect(r.verifiedUsableSupplierResponses).toBe(0);
    expect(r.verifiedSupplierResponseRate).toBe(0);
  });
  it('serves scoped actual metrics and ZIP handlers with private attachment headers', async () => {
    const metrics = await import('../../web/src/app/api/missions/[missionId]/metrics/route');
    const exportRoute = await import('../../web/src/app/api/missions/[missionId]/export/route');
    const params = { params: Promise.resolve({ missionId: mission }) };
    const measured = await metrics.GET(new Request(`http://127.0.0.1:3000/api/missions/${mission}/metrics`), params);
    expect(measured.status).toBe(200);
    expect(measured.headers.get('cache-control')).toBe('private, no-store');
    expect(measured.headers.get('content-disposition')).toContain('attachment;');
    expect((await measured.json()).missionId).toBe(mission);
    const archive = await exportRoute.GET(new Request(`http://127.0.0.1:3000/api/missions/${mission}/export?format=zip`), params);
    expect(archive.status).toBe(200);
    expect(archive.headers.get('content-type')).toBe('application/zip');
    expect(archive.headers.get('cache-control')).toBe('private, no-store');
    expect(archive.headers.get('content-disposition')).toContain(`${mission}.zip`);
    expect((await archive.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(
      (await metrics.GET(new Request('http://127.0.0.1:3000/'), { params: Promise.resolve({ missionId: randomUUID() }) })).status,
    ).toBe(404);
    identity.enabled = false;
    try {
      expect((await metrics.GET(new Request('http://127.0.0.1:3000/'), params)).status).toBe(401);
      expect((await exportRoute.GET(new Request('http://127.0.0.1:3000/'), params)).status).toBe(401);
    } finally {
      identity.enabled = true;
    }
  });
  it('exports a distinct successful founder intervention count with an explicit basis', async () => {
    const r = await report();
    expect(r.founderInterventions).toBeTypeOf('number');
    expect(r.founderInterventions).toBeGreaterThan(0);
    expect(r.founderInterventionBasis).toBeTypeOf('string');
    for (const status of ['failed', 'blocked']) {
      const command = (
        await db.query(
          "insert into public.command_requests(mission_id,idempotency_key,kind,payload,actor_id)values($1,$2,'sendMessage','{}',$3)returning id",
          [mission, randomUUID(), user],
        )
      ).rows[0]?.id;
      await db.query("insert into public.command_results(mission_id,command_id,status,result)values($1,$2,$3,'{}')", [
        mission,
        command,
        status,
      ]);
    }
    expect((await report()).founderInterventions).toBe(r.founderInterventions);
  });
  it('keeps the outbox lock RPC scoped, lead-only and bounded including null input', async () => {
    for (const limit of [null, 0, 101])
      await expect(
        withRole('lead_role', scope, d => d.query('select *from public.lock_pending_outbox($1,$2)', [mission, limit])),
      ).rejects.toThrow(/bounded/);
    await expect(
      withRole('founder_role', scope, d => d.query('select *from public.lock_pending_outbox($1,100)', [mission])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('lead_role', { authUserId: randomUUID(), missionId: mission }, d =>
        d.query('select *from public.lock_pending_outbox($1,100)', [mission]),
      ),
    ).rejects.toThrow(/mission denied/);
    expect((await withRole('lead_role', scope, d => d.query('select *from public.lock_pending_outbox($1,1)', [mission]))).rowCount).toBe(1);
  });
  it('does not hand the same pending outbox row to concurrent lead dispatchers', async () => {
    let release!: () => void, ready!: (ids: string[]) => void;
    const held = new Promise<void>(r => {
        release = r;
      }),
      seen = new Promise<string[]>(r => {
        ready = r;
      });
    const first = withRole('lead_role', scope, async d => {
      const ids = (await d.query('select id from public.lock_pending_outbox($1,1)', [mission])).rows.map(r => String(r.id));
      ready(ids);
      await held;
      return ids;
    });
    const ids = await seen;
    try {
      const second = await withRole('lead_role', scope, async d =>
        (await d.query('select id from public.lock_pending_outbox($1,1)', [mission])).rows.map(r => String(r.id)),
      );
      expect(ids).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0]).not.toBe(ids[0]);
    } finally {
      release();
      await first;
    }
  });
});
