import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DecisionPacketSchema, JsonValueSchema, OutcomeSchema, TrustLevelSchema, type JsonValue, type Outcome } from '../src/schemas.js';
import { deriveReadiness, READINESS_RULES, type ReadinessContext, type ReadinessDecision, type ReadinessFact } from '../src/readiness.js';

// Real isolated PostgreSQL; all evidence and recipients are explicitly synthetic.
const adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_readiness_${Date.now()}`,
  root = fileURLToPath(new URL('../../..', import.meta.url));
const admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID();
let db: Client;
type Role = 'founder_role' | 'lead_role' | 'specialist_role' | 'ingress_role';
async function scoped<T>(role: Role, mission: string, work: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, mission_id: mission })]);
    const value = await work();
    await db.query('commit');
    return value;
  } catch (error: unknown) {
    await db.query('rollback');
    throw error;
  }
}
async function mission() {
  const id = randomUUID();
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode)values($1,$2,'launch','Synthetic readiness regression only','SAR',true)",
    [id, founder],
  );
  return id;
}
const packet = (refs: string[] = [], options = [{ id: 'a', refs }]) => ({
  question: 'Approve this synthetic source',
  options: options.map(o => ({
    id: o.id,
    label: `Approve ${o.id}`,
    artifactVersionIds: o.refs,
    evidenceIds: [],
    cost: null,
    timeDays: 0,
    consequences: 'Synthetic regression only',
  })),
  recommendation: { optionId: options[0]?.id ?? 'a', reasons: ['Test fixture'] },
  staleImpact: [],
  approvedVersionIds: refs,
  defaultIfNoAnswer: { optionId: options[0]?.id ?? 'a', at: null, binding: true },
});
async function decision(
  id: string,
  outcome: Outcome,
  gate: string,
  refs: string[] = [],
  kind = 'selection',
  options?: { id: string; refs: string[] }[],
) {
  const did = await scoped('lead_role', id, async () =>
    z
      .uuid()
      .parse(
        (await db.query('select public.propose_decision($1,$2,$3,$4,$5)null_id', [id, kind, packet(refs, options), outcome, gate])).rows[0]
          ?.null_id,
      ),
  );
  await scoped('founder_role', id, () => db.query("select public.resolve_decision($1,$2,'approve','a')", [id, did]));
  return did;
}
async function fact(
  id: string,
  outcome: Outcome,
  kind: string,
  trust: 'claimed' | 'verified' | 'founder_confirmed' = 'founder_confirmed',
  payload: Record<string, JsonValue> = {},
  supersedes: string | null = null,
) {
  let event: string | null = null;
  if (trust === 'verified')
    event = await scoped('ingress_role', id, async () =>
      z
        .uuid()
        .parse(
          (
            await db.query(
              "insert into public.events(mission_id,type,payload,provider,provider_event_id,signature_verified)values($1,'evidence.verified',$2,'synthetic-readiness',$3,true)returning id",
              [id, { kind, outcome }, randomUUID()],
            )
          ).rows[0]?.id,
        ),
    );
  return scoped(trust === 'founder_confirmed' ? 'founder_role' : 'specialist_role', id, async () =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.append_evidence($1,$2,$3,$4,$5,$6,$7,null,$8)id', [
            id,
            outcome,
            kind,
            trust,
            payload,
            event ? 'event' : trust === 'founder_confirmed' ? 'founder' : 'document',
            event ?? 'Synthetic readiness fixture',
            supersedes,
          ])
        ).rows[0]?.id,
      ),
  );
}
async function baseline(id: string, outcome: Outcome, omit: readonly string[] = []) {
  const done = new Set<string>(),
    gates = new Set<string>();
  for (const rule of READINESS_RULES.filter(r => r.outcome === outcome)) {
    for (const gate of rule.decisionGates)
      if (!gates.has(gate)) {
        gates.add(gate);
        await decision(id, outcome, gate);
      }
    for (const kind of rule.evidenceKinds)
      if (!done.has(kind) && !omit.includes(kind)) {
        done.add(kind);
        await fact(id, outcome, kind, rule.founderKinds?.includes(kind) ? 'founder_confirmed' : rule.highTrust ? 'verified' : 'claimed');
      }
  }
}
async function artifact(id: string, outcome: Outcome, type: string, content: Record<string, JsonValue>, approve = true) {
  const result = await scoped('specialist_role', id, async () => {
    const parent = z
      .uuid()
      .parse(
        (await db.query('select public.create_artifact($1,$2,$3,$4)id', [id, type, outcome, 'Synthetic readiness source'])).rows[0]?.id,
      );
    const version = z
      .uuid()
      .parse((await db.query('select public.append_artifact_version($1,$2,$3)id', [id, parent, content])).rows[0]?.id);
    await db.query("select public.set_artifact_status($1,$2,'proposed')", [id, version]);
    return { parent, version };
  });
  if (approve) await approveArtifact(id, outcome, result.version);
  return result;
}
async function approveArtifact(id: string, outcome: Outcome, version: string) {
  const did = await decision(id, outcome, 'source_review', [version]);
  await scoped('founder_role', id, () => db.query("select public.set_artifact_status($1,$2,'approved',$3)", [id, version, did]));
  return did;
}
async function commitment(id: string, proforma?: string) {
  return scoped('lead_role', id, async () =>
    z
      .uuid()
      .parse(
        (proforma
          ? await db.query('select public.open_inspection_commitment($1,null,$2,$3,$4)id', [
              id,
              proforma,
              ['Check assembled fit against the approved specification'],
              new Date(Date.now() + 86400000).toISOString(),
            ])
          : await db.query("select public.open_commitment($1,null,'inbound','Unrelated domain registration task',$2)id", [
              id,
              new Date(Date.now() + 86400000).toISOString(),
            ])
        ).rows[0]?.id,
      ),
  );
}

const factRows = z.array(
  z.object({
    id: z.uuid(),
    outcome: OutcomeSchema,
    kind: z.string(),
    trust: TrustLevelSchema,
    payload: z.record(z.string(), JsonValueSchema),
    stale: z.boolean(),
    superseded: z.boolean(),
  }),
);
const decisionRows = z.array(
  z.object({
    id: z.uuid(),
    outcome: OutcomeSchema,
    kind: z.string(),
    gate: z.string(),
    packet: DecisionPacketSchema,
    option_id: z.string().nullable(),
    approved: z.boolean(),
    stale: z.boolean(),
    superseded: z.boolean(),
  }),
);
const artifactRows = z.array(
  z.object({
    id: z.uuid(),
    type: z.string(),
    outcome: OutcomeSchema,
    content: z.record(z.string(), JsonValueSchema),
    current: z.boolean(),
    approved: z.boolean(),
    stale: z.boolean(),
  }),
);
const commitmentRows = z.array(
  z.object({
    id: z.uuid(),
    dueAt: z.string(),
    status: z.enum(['open', 'overdue', 'closed', 'cancelled']),
    stale: z.boolean(),
    closedEvidenceCurrent: z.boolean(),
  }),
);
async function parity(id: string, outcome: Outcome) {
  return scoped('founder_role', id, async () => {
    const facts: ReadinessFact[] = factRows.parse(
      (
        await db.query(
          'select e.*,exists(select from public.stale_marks s where s.mission_id=e.mission_id and s.node_id=e.id)stale,exists(select from public.evidence n where n.mission_id=e.mission_id and n.supersedes_id=e.id)superseded from public.evidence e where e.mission_id=$1',
          [id],
        )
      ).rows,
    );
    const decisions: ReadinessDecision[] = decisionRows
      .parse(
        (
          await db.query(
            "select d.*,r.option_id,coalesce(r.response in('approve','choose'),false)approved,exists(select from public.stale_marks s where s.mission_id=d.mission_id and s.node_id=d.id)stale,exists(select from public.decision_supersessions s where s.mission_id=d.mission_id and s.previous_id=d.id)superseded from public.decisions d left join public.decision_resolutions r on r.decision_id=d.id where d.mission_id=$1",
            [id],
          )
        ).rows,
      )
      .map(d => ({
        ...d,
        selectedVersionIds:
          d.packet.options.find(o => o.id === d.option_id)?.artifactVersionIds ??
          (d.packet.options.length === 1 ? (d.packet.approvedVersionIds ?? []) : []),
      }));
    const context: ReadinessContext = {
      artifacts: artifactRows.parse(
        (
          await db.query(
            "select v.id,a.type,a.outcome,v.content,not exists(select from public.artifact_versions n where n.artifact_id=v.artifact_id and n.version_no>v.version_no)current,coalesce((select status='approved'and exists(select from public.active_decisions d where d.mission_id=s.mission_id and d.id=s.decision_id)from public.artifact_statuses s where s.mission_id=v.mission_id and s.artifact_version_id=v.id order by s.created_at desc,s.id desc limit 1),false)approved,exists(select from public.stale_marks s where s.mission_id=v.mission_id and s.node_id=v.id)stale from public.artifact_versions v join public.artifacts a on a.mission_id=v.mission_id and a.id=v.artifact_id where v.mission_id=$1",
            [id],
          )
        ).rows,
      ),
      commitments: commitmentRows.parse(
        (
          await db.query(
            "select c.id,to_char(c.due_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')\"dueAt\",state.status,exists(select from public.stale_marks s where s.mission_id=c.mission_id and s.node_id=c.id)stale,exists(select from public.evidence e where e.mission_id=c.mission_id and e.id=state.closed_by_evidence_id and e.trust in('verified','founder_confirmed')and e.kind='inspection_completed'and e.outcome='supply'and exists(select from public.inspection_commitments i where i.mission_id=e.mission_id and i.commitment_id=c.id and e.payload->>'commitmentId'=i.commitment_id::text and e.payload->>'proformaVersionId'=i.proforma_version_id::text and e.payload->>'specVersionId'=i.spec_version_id::text)and not exists(select from public.stale_marks s where s.mission_id=e.mission_id and s.node_id=e.id)and not exists(select from public.evidence n where n.mission_id=e.mission_id and n.supersedes_id=e.id))\"closedEvidenceCurrent\"from public.commitments c join lateral(select cs.*from public.commitment_states cs where cs.mission_id=c.mission_id and cs.commitment_id=c.id order by cs.created_at desc,cs.id desc limit 1)state on true where c.mission_id=$1",
            [id],
          )
        ).rows,
      ),
      now: new Date().toISOString(),
    };
    context.inspections = z
      .array(z.object({ commitmentId: z.uuid(), proformaVersionId: z.uuid(), specVersionId: z.uuid(), checks: z.array(z.string()) }))
      .parse(
        (
          await db.query(
            'select commitment_id as "commitmentId",proforma_version_id as "proformaVersionId",spec_version_id as "specVersionId",checks from public.inspection_commitments where mission_id=$1',
            [id],
          )
        ).rows,
      );
    const actual = (await db.query('select *from public.readiness($1)', [id])).rows;
    const derived = deriveReadiness(facts, decisions, READINESS_RULES, context);
    for (const expected of derived) {
      const sql = actual.find(r => r.outcome === expected.outcome);
      expect(sql?.level).toBe(expected.level);
      expect([...(sql?.missing ?? [])].sort()).toEqual([...expected.missing].sort());
      expect([...new Set(sql?.evidence_ids ?? [])].sort()).toEqual([...expected.evidenceIds].sort());
      expect([...new Set(sql?.decision_ids ?? [])].sort()).toEqual([...expected.decisionIds].sort());
    }
    const selected = derived.find(r => r.outcome === outcome);
    if (!selected) throw new Error('Expected derived outcome in explicit parity fixture');
    return selected;
  });
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
  for (const file of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(`${root}/supabase/migrations/${file}`, 'utf8'));
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
}, 30000);
afterAll(async () => {
  await db?.end();
  await admin.query(`drop database if exists ${name}with(force)`);
  await admin.end();
});

describe('BRD4B/17.1 FR-PLY-04 readiness with actual scoped immutable ledgers', () => {
  it('Brand requires secured handles and trademark screen plus actual founder approvals; verified approval assertions do not count', async () => {
    const id = await mission(),
      approvals = ['name_approved', 'identity_approved', 'guidelines_approved'];
    await baseline(id, 'brand', [...approvals, 'founder_owned_handles', 'trademark_screen']);
    expect((await parity(id, 'brand')).level).toBe(4);
    for (const kind of approvals) await fact(id, 'brand', kind, 'verified');
    await fact(id, 'brand', 'founder_owned_handles', 'verified');
    await fact(id, 'brand', 'trademark_screen', 'verified');
    expect((await parity(id, 'brand')).missing).toEqual(approvals);
    const ids = [];
    for (const kind of approvals) ids.push(await fact(id, 'brand', kind));
    expect((await parity(id, 'brand')).level).toBe(5);
    await fact(id, 'brand', 'name_approved', 'claimed', {}, ids[0]);
    expect((await parity(id, 'brand')).level).toBe(4);
  });
  it('Demand needs founder-approved launch-week plan and content in addition to measured validation and a live channel', async () => {
    const id = await mission(),
      approvals = ['launch_week_plan', 'launch_content_approved'];
    await baseline(id, 'demand', approvals);
    expect((await parity(id, 'demand')).level).toBe(4);
    for (const kind of approvals) await fact(id, 'demand', kind, 'verified');
    expect((await parity(id, 'demand')).missing).toEqual(approvals);
    for (const kind of approvals) await fact(id, 'demand', kind);
    expect((await parity(id, 'demand')).level).toBe(5);
  });
  it('Supply checks approved proforma fields and its approved current product spec plus a real inspection commitment', async () => {
    const id = await mission();
    await baseline(id, 'supply');
    expect((await parity(id, 'supply')).missing).toEqual(['artifact:proforma_invoice', 'commitment:inspection']);
    await fact(id, 'supply', 'proforma_invoice');
    await fact(id, 'supply', 'inspection_plan', 'founder_confirmed', { commitmentId: randomUUID() });
    expect((await parity(id, 'supply')).level).toBe(4);
    const spec = await artifact(id, 'product', 'specification', { dimensions: [10, 20, 30] }, false),
      invoice = await artifact(id, 'supply', 'proforma_invoice', {
        proformaInvoice: { specVersionId: spec.version, amountMinor: 10000, currency: 'SAR', incoterm: 'FOB' },
      });
    const unrelated = await commitment(id);
    await fact(id, 'supply', 'inspection_plan', 'founder_confirmed', { commitmentId: unrelated });
    expect((await parity(id, 'supply')).level).toBe(4);
    await expect(commitment(id, invoice.version)).rejects.toThrow(/approved|specification/);
    await approveArtifact(id, 'product', spec.version);
    expect((await parity(id, 'supply')).missing).toEqual(['commitment:inspection']);
    const inspection = await commitment(id, invoice.version);
    await fact(id, 'supply', 'inspection_plan', 'claimed', { commitmentId: inspection });
    expect((await parity(id, 'supply')).level).toBe(4);
    await fact(id, 'supply', 'inspection_plan', 'founder_confirmed', { commitmentId: inspection });
    expect((await parity(id, 'supply')).level).toBe(5);
    await scoped('specialist_role', id, () =>
      db.query('select public.append_artifact_version($1,$2,$3)', [id, spec.parent, { dimensions: [20, 20, 30] }]),
    );
    expect((await parity(id, 'supply')).missing).toEqual(['artifact:proforma_invoice', 'commitment:inspection']);
  });
  it('Cross-mission specification and inspection payload refs, malformed proforma and cancelled commitments cannot satisfy Supply', async () => {
    const id = await mission(),
      other = await mission();
    await baseline(id, 'supply');
    const foreignSpec = await artifact(other, 'product', 'specification', { dimensions: [1, 2, 3] });
    await artifact(id, 'supply', 'proforma_invoice', {
      proformaInvoice: { specVersionId: foreignSpec.version, amountMinor: 100, currency: 'SAR', incoterm: 'FOB' },
    });
    const foreignInspection = await commitment(other);
    await fact(id, 'supply', 'inspection_plan', 'founder_confirmed', { commitmentId: foreignInspection });
    expect((await parity(id, 'supply')).missing).toHaveLength(2);
    const spec = await artifact(id, 'product', 'specification', { dimensions: [1, 2, 3] });
    for (const invoice of [
      { amountMinor: 1.5, currency: 'SAR', incoterm: 'FOB' },
      { amountMinor: 1, currency: 'SAR', incoterm: '' },
      { amountMinor: 1, currency: 'sar', incoterm: 'FOB' },
    ])
      await artifact(id, 'supply', 'proforma_invoice', { proformaInvoice: { specVersionId: spec.version, ...invoice } });
    expect((await parity(id, 'supply')).missing).toContain('artifact:proforma_invoice');
    const invoice = await artifact(id, 'supply', 'proforma_invoice', {
      proformaInvoice: { specVersionId: spec.version, amountMinor: 100, currency: 'SAR', incoterm: 'FOB' },
    });
    const inspection = await commitment(id, invoice.version);
    await fact(id, 'supply', 'inspection_plan', 'founder_confirmed', { commitmentId: inspection });
    expect((await parity(id, 'supply')).level).toBe(5);
    await db.query("insert into public.commitment_states(mission_id,commitment_id,status)values($1,$2,'cancelled')", [id, inspection]);
    expect((await parity(id, 'supply')).missing).toEqual(['commitment:inspection']);
  });
  it('Supply exception requires a dated explicit founder risk bound to the current selected confirmation source', async () => {
    const id = await mission();
    await baseline(id, 'supply');
    const statement = 'I accept proceeding without proforma and inspection, including quality and payment risk.';
    await fact(id, 'supply', 'sourcing_risk_accepted', 'founder_confirmed', {
      riskAccepted: true,
      statement,
      confirmedAt: new Date().toISOString(),
    });
    expect((await parity(id, 'supply')).level).toBe(4);
    const source = await artifact(
        id,
        'supply',
        'confirmation',
        { founderConfirmation: { outcome: 'supply', kind: 'sourcing_risk_accepted', statement, payload: { riskAccepted: true } } },
        false,
      ),
      did = await decision(id, 'supply', 'sourcing_risk_accepted', [source.version], 'engagement');
    await scoped('founder_role', id, () => db.query("select public.set_artifact_status($1,$2,'approved',$3)", [id, source.version, did]));
    for (const confirmedAt of [
      'not-a-date',
      '2026-02-31T00:00:00Z',
      '2026-11-11T24:00:00Z',
      '2026-11-11T23:59:60Z',
      '2999-01-01T00:00:00Z',
    ])
      await fact(id, 'supply', 'sourcing_risk_accepted', 'founder_confirmed', {
        riskAccepted: true,
        statement,
        confirmedAt,
        decisionId: did,
        artifactVersionId: source.version,
      });
    expect((await parity(id, 'supply')).level).toBe(4);
    await scoped('founder_role', id, () => db.query('select public.confirm_founder_artifact($1,$2,$3)', [id, did, source.version]));
    expect((await parity(id, 'supply')).level).toBe(5);
    await scoped('specialist_role', id, () =>
      db.query('select public.append_artifact_version($1,$2,$3)', [
        id,
        source.parent,
        {
          founderConfirmation: {
            outcome: 'supply',
            kind: 'sourcing_risk_accepted',
            statement: 'Changed risk requires another approval',
            payload: { riskAccepted: true },
          },
        },
      ]),
    );
    expect((await parity(id, 'supply')).level).toBe(4);
  });
  it('A superseded approving decision invalidates the proforma/spec approval even if its latest artifact status still says approved', async () => {
    const id = await mission();
    await baseline(id, 'supply');
    const spec = await artifact(id, 'product', 'specification', { dimensions: [1, 2, 3] }),
      invoice = await artifact(id, 'supply', 'proforma_invoice', {
        proformaInvoice: { specVersionId: spec.version, amountMinor: 100, currency: 'SAR', incoterm: 'FOB' },
      }),
      inspection = await commitment(id, invoice.version);
    await fact(id, 'supply', 'inspection_plan', 'founder_confirmed', { commitmentId: inspection });
    expect((await parity(id, 'supply')).level).toBe(5);
    const prior = z
      .uuid()
      .parse(
        (
          await db.query("select decision_id from public.artifact_statuses where artifact_version_id=$1 and status='approved'", [
            invoice.version,
          ])
        ).rows[0]?.decision_id,
      );
    const replacement = await scoped('lead_role', id, async () =>
      z
        .uuid()
        .parse(
          (await db.query("select public.propose_decision($1,'selection',$2,'supply','source_review',$3)id", [id, packet(), prior])).rows[0]
            ?.id,
        ),
    );
    await scoped('founder_role', id, () => db.query("select public.resolve_decision($1,$2,'approve','a')", [id, replacement]));
    expect((await parity(id, 'supply')).missing).toEqual(['artifact:proforma_invoice', 'commitment:inspection']);
  });
  it('A closed inspection commitment loses support when its closing proof is corrected', async () => {
    const id = await mission();
    await baseline(id, 'supply');
    const spec = await artifact(id, 'product', 'specification', { dimensions: [1, 2, 3] }),
      invoice = await artifact(id, 'supply', 'proforma_invoice', {
        proformaInvoice: { specVersionId: spec.version, amountMinor: 100, currency: 'SAR', incoterm: 'FOB' },
      });
    const inspection = await commitment(id, invoice.version);
    await fact(id, 'supply', 'inspection_plan', 'founder_confirmed', { commitmentId: inspection });
    const proof = await fact(id, 'supply', 'inspection_completed', 'founder_confirmed', {
      commitmentId: inspection,
      proformaVersionId: invoice.version,
      specVersionId: spec.version,
    });
    await scoped('lead_role', id, () => db.query('select public.close_commitment($1,$2,$3)', [id, inspection, proof]));
    expect((await parity(id, 'supply')).level).toBe(5);
    await fact(id, 'supply', 'inspection_completed', 'claimed', {}, proof);
    expect((await parity(id, 'supply')).missing).toEqual(['commitment:inspection']);
    const unrelatedProof = await fact(id, 'supply', 'email_sent'),
      otherInspection = await commitment(id, invoice.version);
    await fact(id, 'supply', 'inspection_plan', 'founder_confirmed', { commitmentId: otherInspection });
    await scoped('lead_role', id, () => db.query('select public.close_commitment($1,$2,$3)', [id, otherInspection, unrelatedProof]));
    expect((await parity(id, 'supply')).missing).toEqual(['commitment:inspection']);
  });
  it('An unselected risk variant cannot borrow the chosen decision, and private helper functions do not expose cross-mission records', async () => {
    const id = await mission();
    await baseline(id, 'supply');
    const make = (statement: string) => ({
      founderConfirmation: { outcome: 'supply', kind: 'sourcing_risk_accepted', statement, payload: { riskAccepted: true } },
    });
    const selected = await artifact(id, 'supply', 'confirmation', make('I accept this specific sourcing risk.')),
      other = await artifact(id, 'supply', 'confirmation', make('This different risk was not chosen.'));
    const did = await decision(id, 'supply', 'sourcing_risk_accepted', [selected.version, other.version], 'engagement', [
      { id: 'a', refs: [selected.version] },
      { id: 'b', refs: [other.version] },
    ]);
    await fact(id, 'supply', 'sourcing_risk_accepted', 'founder_confirmed', {
      riskAccepted: true,
      statement: 'This different risk was not chosen.',
      confirmedAt: new Date(Date.now() - 1000).toISOString(),
      decisionId: did,
      artifactVersionId: other.version,
    });
    expect((await parity(id, 'supply')).level).toBe(4);
    await expect(scoped('founder_role', id, () => db.query('select *from private.readiness_sourcing($1)', [id]))).rejects.toThrow(
      /permission denied/,
    );
    await scoped('founder_role', id, () => db.query('select public.confirm_founder_artifact($1,$2,$3)', [id, did, selected.version]));
    expect((await parity(id, 'supply')).level).toBe(5);
  });
});
