import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { READINESS_RULES } from '../src/readiness.js';
import { PostgresMissionRepository } from '../src/repository.js';
import type { EffectIntent, Result } from '../src/schemas.js';

const adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const databaseName = `lo_state_test_${Date.now()}`;
const admin = new Client({ connectionString: adminUrl });
let db: Client;
const uidA = randomUUID(),
  uidB = randomUUID(),
  founderA = randomUUID(),
  founderB = randomUUID(),
  missionA = randomUUID(),
  missionB = randomUUID(),
  partyA = randomUUID(),
  partyB = randomUUID(),
  accountA = randomUUID();
const root = fileURLToPath(new URL('../../..', import.meta.url));
const roles = ['founder_role', 'lead_role', 'specialist_role', 'policy_role', 'ingress_role', 'voice_role'] as const;
type Role = (typeof roles)[number];
const packet = {
  question: 'Choose the recommended option',
  options: [{ id: 'a', label: 'Approve', evidenceIds: [], cost: null, timeDays: 0, consequences: 'Continue' }],
  recommendation: { optionId: 'a', reasons: ['Evidence supports this option'] },
  staleImpact: [],
  defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
  impact: { decisionIds: [], artifactIds: [], commitmentIds: [], outcomes: [], cost: null, delayDays: 0 },
};
async function scoped(role: Role, sql: string, values: unknown[] = [], mission: string = missionA, uid: string = uidA, connection = db) {
  await connection.query('begin');
  try {
    await connection.query(`set local role ${role}`);
    await connection.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: uid, mission_id: mission })]);
    const r = await connection.query(sql, values);
    await connection.query('commit');
    return r;
  } catch (error: unknown) {
    await connection.query('rollback');
    throw error;
  }
}
async function decision(gate = 'specification', outcome = 'brand', supersedes: string | null = null) {
  const r = await scoped('lead_role', "select public.propose_decision($1,'selection',$2,$3,$4,$5)id", [
    missionA,
    packet,
    outcome,
    gate,
    supersedes,
  ]);
  return String(r.rows[0]?.['id']);
}
async function approve(id: string) {
  await scoped('founder_role', "select public.resolve_decision($1,$2,'approve',null)", [missionA, id]);
}
async function artifact(approved = true) {
  const a = await scoped('specialist_role', "select public.create_artifact($1,'spec','brand','Source spec')id", [missionA]);
  const artifactId = String(a.rows[0]?.['id']);
  const v = await scoped('specialist_role', 'select public.append_artifact_version($1,$2,$3)id', [
    missionA,
    artifactId,
    { dimensions: [1, 2, 3] },
  ]);
  const versionId = String(v.rows[0]?.['id']);
  if (approved) {
    await scoped('specialist_role', "select public.set_artifact_status($1,$2,'proposed')", [missionA, versionId]);
    const d = await decision();
    await approve(d);
    await scoped('founder_role', "select public.set_artifact_status($1,$2,'approved',$3)", [missionA, versionId, d]);
  }
  return { artifactId, versionId };
}
async function scopedMandate(scope: Record<string, unknown>, per: number, total: number, mission: string = missionA) {
  const expires = new Date(Date.now() + 3600000).toISOString();
  const artifactId = String(
    (await scoped('specialist_role', "select public.create_artifact($1,'mandate','supply','Explicit mandate scope')id", [mission], mission))
      .rows[0]?.id,
  );
  const versionId = String(
    (
      await scoped(
        'specialist_role',
        'select public.append_artifact_version($1,$2,$3)id',
        [
          mission,
          artifactId,
          { mandate: { type: 'outreach', scope, ceilingPer: per, ceilingTotal: total, currency: 'SAR', expiresAt: expires } },
        ],
        mission,
      )
    ).rows[0]?.id,
  );
  await scoped('specialist_role', "select public.set_artifact_status($1,$2,'proposed')", [mission, versionId], mission);
  const bound = {
    ...packet,
    approvedVersionIds: [versionId],
    options: packet.options.map(o => ({ ...o, artifactVersionIds: [versionId] })),
  };
  const d = String(
    (await scoped('lead_role', "select public.propose_decision($1,'mandate',$2,'supply','outreach')id", [mission, bound], mission)).rows[0]
      ?.id,
  );
  await scoped('founder_role', "select public.resolve_decision($1,$2,'approve','a')", [mission, d], mission);
  await scoped('founder_role', "select public.set_artifact_status($1,$2,'approved',$3)", [mission, versionId, d], mission);
  return String(
    (
      await scoped(
        'founder_role',
        "select public.grant_mandate($1,$2,'outreach',$3,$4,$5,$6)id",
        [mission, d, scope, per, total, expires],
        mission,
      )
    ).rows[0]?.id,
  );
}
async function mandate(action = 'email', effectClass = 'communicate', per = 10000, total = 100000) {
  return scopedMandate(
    {
      actions: [action],
      effectClasses: [effectClass],
      counterpartyIds: [partyA],
      channels: ['email'],
      purposes: ['samples'],
      instrumentIds: [accountA],
      maxNewContacts: 5,
    },
    per,
    total,
  );
}

function intent(mandateId: string, changes: Record<string, unknown> = {}) {
  return {
    missionId: missionA,
    taskId: 'task',
    action: 'email',
    effectClass: 'communicate',
    counterpartyId: partyA,
    idempotencyKey: randomUUID(),
    mode: 'do',
    sandboxMode: true,
    mandateId,
    channel: 'email',
    purpose: 'samples',
    newContact: false,
    ...changes,
  };
}
async function reserve(input: Record<string, unknown>, hash: string | null = null, connection = db) {
  const r = await scoped(
    'policy_role',
    'select public.reserve_effect($1,$2,$3)result',
    [missionA, input, hash],
    missionA,
    uidA,
    connection,
  );
  return r.rows[0]?.['result'] as { authorizationId: string; status: string; replay: boolean; receiptId?: string };
}

beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${databaseName}`);
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${databaseName}`;
  db = new Client({ connectionString: parsed.toString() });
  await db.connect();
  const bootstrap = (await readFile(`${root}/supabase/tests/bootstrap.sql`, 'utf8')).replace(
    'create role authenticated nologin noinherit nobypassrls;',
    () =>
      "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
  );
  await db.query(bootstrap);
  const migrationFiles = (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql') && f < '202611120005').sort();
  for (const f of migrationFiles) await db.query(await readFile(`${root}/supabase/migrations/${f}`, 'utf8'));
  await db.query(await readFile(`${root}/supabase/rollback/202611120001_004_empty_only.sql`, 'utf8'));
  expect((await db.query("select to_regclass('public.missions')m")).rows[0]?.['m']).toBe(null);
  for (const f of migrationFiles) await db.query(await readFile(`${root}/supabase/migrations/${f}`, 'utf8'));
  await db.query(await readFile(`${root}/supabase/migrations/202611120014_readiness_gates.sql`, 'utf8'));
  await db.query(
    'grant usage on schema realtime,storage to founder_role;grant select on realtime.messages,storage.objects to founder_role;grant insert on storage.objects to founder_role,specialist_role,policy_role',
  );
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2),($3,$4)', [founderA, uidA, founderB, uidB]);
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency)values($1,$2,'launch','Test mission A','SAR'),($3,$4,'launch','Test mission B','SAR')",
    [missionA, founderA, missionB, founderB],
  );
  await db.query(
    "insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'supplier','Party A'),($3,$4,'supplier','Party B')",
    [partyA, founderA, partyB, founderB],
  );
  await db.query(
    "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'test-provider','connected','{pay}')",
    [accountA, founderA],
  );
  await db.query('update private.platform_controls set effects_enabled=true');
}, 30000);
afterAll(async () => {
  if (db) await db.end();
  await admin.query(`drop database if exists ${databaseName} with(force)`);
  await admin.end();
});

describe('real PostgreSQL invariant and tenant suite', () => {
  it('I-8 all roles × all tables have no update/delete; only ingress inserts events', async () => {
    const tables = (await db.query("select tablename from pg_tables where schemaname='public'")).rows as { tablename: string }[];
    let checks = 0;
    for (const role of roles)
      for (const { tablename } of tables) {
        const p = await db.query("select has_table_privilege($1,$2,'UPDATE')u,has_table_privilege($1,$2,'DELETE')d", [
          role,
          `public.${tablename}`,
        ]);
        expect(p.rows[0]).toMatchObject({ u: false, d: false });
        checks++;
      }
    expect(checks).toBeGreaterThan(250);
    for (const role of roles) {
      const p = await db.query("select has_table_privilege($1,'public.events','INSERT')v", [role]);
      expect(p.rows[0]?.['v']).toBe(role === 'ingress_role');
    }
    await expect(
      scoped('specialist_role', "insert into public.decisions(mission_id,kind,packet,actor_id)values($1,'selection',$2,$3)", [
        missionA,
        packet,
        uidA,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
  it('I-12 every tenant table is RLS filtered; global data is read-only', async () => {
    const tables = (
      await db.query(
        "select c.table_name,c.column_name from information_schema.columns c join pg_tables t on t.schemaname=c.table_schema and t.tablename=c.table_name where c.table_schema='public'and c.column_name in('mission_id','founder_id','auth_user_id')",
      )
    ).rows as { table_name: string; column_name: string }[];
    for (const role of roles)
      for (const t of tables) {
        const other = t.column_name === 'mission_id' ? missionB : t.column_name === 'founder_id' ? founderB : uidB;
        const r = await scoped(role, `select count(*)::int n from public.${t.table_name} where ${t.column_name}=$1`, [other]);
        expect(r.rows[0]?.['n'], `${role} ${t.table_name}`).toBe(0);
      }
    for (const role of roles) {
      const p = await db.query("select has_table_privilege($1,'public.readiness_rules','INSERT')v", [role]);
      expect(p.rows[0]?.['v']).toBe(false);
    }
  });
  it('I-12 private Broadcast and storage reject tenant B; triggers emit id-only private changes', async () => {
    const d = await decision();
    await db.query("insert into realtime.messages(topic,extension)values($1,'broadcast'),($2,'broadcast')", [
      `mission:${missionA}`,
      `mission:${missionB}`,
    ]);
    const channels = await scoped('founder_role', 'select topic from realtime.messages');
    expect(channels.rows).toEqual([{ topic: `mission:${missionA}` }]);
    await db.query("insert into storage.objects(bucket_id,name)values('mission-files',$1),('mission-files',$2)", [
      `${missionA}/spec.pdf`,
      `${missionB}/spec.pdf`,
    ]);
    const objects = await scoped('founder_role', 'select name from storage.objects');
    expect(objects.rows).toEqual([{ name: `${missionA}/spec.pdf` }]);
    await expect(
      scoped('founder_role', "insert into storage.objects(bucket_id,name)values('mission-files',$1)", [`${missionB}/stolen.pdf`]),
    ).rejects.toThrow(/row-level security/);
    const broadcasts = await db.query("select * from realtime.test_broadcasts where payload->>'id'=$1", [d]);
    expect(broadcasts.rows[0]?.['private']).toBe(true);
    expect(Object.keys(broadcasts.rows[0]?.['payload'] as object).sort()).toEqual(['id', 'missionId', 'table']);
  });
  it('break attempt 1: cross-tenant references fail even through SECURITY DEFINER', async () => {
    const other = await scoped('specialist_role', "select public.create_artifact($1,'spec','brand','Other')id", [missionB], missionB, uidB);
    const otherId = String(other.rows[0]?.['id']);
    const a = await artifact();
    await expect(scoped('specialist_role', 'select public.append_artifact_version($1,$2,$3)', [missionA, otherId, {}])).rejects.toThrow(
      /artifact not found/,
    );
    await expect(
      scoped('specialist_role', "select public.add_dependency($1,$2,$3,'cross-tenant')", [missionA, otherId, a.versionId]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      scoped('specialist_role', 'insert into public.threads(mission_id,counterparty_id)values($1,$2)', [missionA, partyB]),
    ).rejects.toThrow(/cross tenant/);
  });
  it('I-7 concurrent supersessions have exactly one winner and invalidate second-order dependents atomically', async () => {
    const old = await decision();
    await approve(old);
    const a = await artifact();
    const b = await artifact();
    await scoped('specialist_role', "select public.add_dependency($1,$2,$3,'decision source')", [missionA, old, a.versionId]);
    await scoped('specialist_role', "select public.add_dependency($1,$2,$3,'second order')", [missionA, a.versionId, b.versionId]);
    const replacements = await Promise.all([decision('specification', 'brand', old), decision('specification', 'brand', old)]);
    const c1 = new Client({ connectionString: new URL(`/${databaseName}`, adminUrl).toString() });
    const c2 = new Client({ connectionString: new URL(`/${databaseName}`, adminUrl).toString() });
    await c1.connect();
    await c2.connect();
    try {
      const results = await Promise.allSettled(
        replacements.map((id, index) =>
          scoped(
            'founder_role',
            "select public.resolve_decision($1,$2,'approve',null)",
            [missionA, id],
            missionA,
            uidA,
            index === 0 ? c1 : c2,
          ),
        ),
      );
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    } finally {
      await c1.end();
      await c2.end();
    }
    const stale = await scoped('founder_role', 'select node_id from public.stale_marks where node_id=any($1::uuid[])', [
      [old, a.versionId, b.versionId],
    ]);
    expect(stale.rows).toHaveLength(3);
    expect((await scoped('founder_role', 'select * from public.active_decisions where id=$1', [old])).rows).toHaveLength(0);
  });
  it('I-3 immutable versions, evidence and audit reject UPDATE/DELETE and false performed labels', async () => {
    const a = await artifact();
    for (const sql of ["update public.artifact_versions set content='{}'where id=$1", 'delete from public.artifact_versions where id=$1'])
      await expect(scoped('specialist_role', sql, [a.versionId])).rejects.toThrow(/permission denied/);
    await expect(
      scoped('specialist_role', "select public.append_evidence($1,'brand','test','performed','{}','receipt','missing',null,null)", [
        missionA,
      ]),
    ).rejects.toThrow(/requires receipt/);
    await expect(
      scoped('lead_role', "insert into public.activity(mission_id,label,summary,actor_id)values($1,'performed','Fake send',$2)", [
        missionA,
        uidA,
      ]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      scoped('specialist_role', 'select public.append_artifact_version($1,$2,$3)', [
        missionA,
        a.artifactId,
        { access_token: 'fixture-secret' },
      ]),
    ).rejects.toThrow(/secret content/);
  });
  it('readiness SQL rules exactly match the shared rule source', async () => {
    const rows = (await db.query('select * from public.readiness_rules where version=2 order by outcome,level')).rows;
    for (const rule of READINESS_RULES) {
      const row = rows.find(r => r['outcome'] === rule.outcome && r['level'] === rule.level);
      expect(row?.['evidence_kinds']).toEqual(rule.evidenceKinds);
      expect(row?.['decision_gates']).toEqual(rule.decisionGates);
      expect(row?.['high_trust']).toBe(rule.highTrust);
      expect(row?.['performed_kinds']).toEqual(rule.performedKinds ?? []);
      expect(row?.['founder_kinds']).toEqual(rule.founderKinds ?? []);
      expect(row?.['ledger_gate']).toEqual(rule.ledgerGate ?? null);
    }
  });
  it('I-5/6 claimed facts cap every outcome at R3; adding verified evidence derives R4', async () => {
    for (const outcome of ['brand', 'product', 'supply', 'commerce', 'compliance', 'demand']) {
      for (const gate of ['direction', 'specification']) {
        const d = await decision(gate, outcome);
        await approve(d);
      }
      for (const kind of ['research', 'specification', 'external_verification'])
        await scoped('specialist_role', "select public.append_evidence($1,$2,$3,'claimed','{}','url','https://example.test',null,null)", [
          missionA,
          outcome,
          kind,
        ]);
    }
    const claimed = await scoped('founder_role', 'select * from public.readiness($1)', [missionA]);
    expect(claimed.rows.every(r => r['level'] === 3)).toBe(true);
    for (const outcome of ['brand', 'product', 'supply', 'commerce', 'compliance', 'demand']) {
      const event = await scoped(
        'ingress_role',
        "insert into public.events(mission_id,type,payload,provider,provider_event_id,signature_verified)values($1,'evidence.verified',$2,'test-verification',$3,true)returning id",
        [missionA, { kind: 'external_verification', outcome }, randomUUID()],
      );
      await scoped('specialist_role', "select public.append_evidence($1,$2,'external_verification','verified','{}','event',$3,null,null)", [
        missionA,
        outcome,
        event.rows[0]?.['id'],
      ]);
    }
    const verified = await scoped('founder_role', 'select * from public.readiness($1)', [missionA]);
    expect(verified.rows.every(r => r['level'] === 4)).toBe(true);
  });
  it('break attempt 2: simultaneous approval token replay authorizes one intent only', async () => {
    const a = await artifact(),
      d = await decision();
    await approve(d);
    const token = createHash('sha256').update(randomUUID()).digest('hex');
    const binding = { action: 'publish', counterpartyId: partyA, amountMinor: null, currency: null, artifactVersionId: a.versionId };
    await scoped('founder_role', "select public.issue_approval($1,$2,$3,$4,now()+interval '1 hour')", [missionA, d, binding, token]);
    const first: Record<string, unknown> = intent('', { action: 'publish', effectClass: 'publish', artifactVersionId: a.versionId });
    delete first['mandateId'];
    const c1 = new Client({ connectionString: new URL(`/${databaseName}`, adminUrl).toString() }),
      c2 = new Client({ connectionString: new URL(`/${databaseName}`, adminUrl).toString() });
    await c1.connect();
    await c2.connect();
    try {
      const results = await Promise.allSettled([reserve(first, token, c1), reserve({ ...first, idempotencyKey: randomUUID() }, token, c2)]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    } finally {
      await c1.end();
      await c2.end();
    }
    expect(
      (
        await scoped(
          'founder_role',
          'select * from public.approval_consumptions where approval_id in(select id from public.approvals where token_hash=$1)',
          [token],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('I-4 same-key retry reuses authorization and rejects changed intent', async () => {
    const m = await mandate(),
      i = intent(m),
      first = await reserve(i),
      second = await reserve(i);
    expect(second.authorizationId).toBe(first.authorizationId);
    expect(second.replay).toBe(true);
    await expect(reserve({ ...i, purpose: 'changed' })).rejects.toThrow(/idempotency intent mismatch/);
  });
  it('I-13 pause and revocation block the next reserved dispatch', async () => {
    const m = await mandate(),
      a = await reserve(intent(m));
    await scoped('founder_role', "select public.transition_mission($1,'paused',null,null)", [missionA]);
    await expect(scoped('policy_role', 'select public.begin_effect($1,$2)', [missionA, a.authorizationId])).rejects.toThrow(
      /paused or ended/,
    );
    await scoped('founder_role', "select public.transition_mission($1,'active',null,null)", [missionA]);
    await scoped('founder_role', 'select public.revoke_mandate($1,$2)', [missionA, m]);
    await expect(scoped('policy_role', 'select public.begin_effect($1,$2)', [missionA, a.authorizationId])).rejects.toThrow(
      /mandate revoked/,
    );
  });
  it('new artifact version invalidates an unconsumed approval token', async () => {
    const a = await artifact(),
      d = await decision();
    await approve(d);
    const token = createHash('sha256').update(randomUUID()).digest('hex');
    await scoped('founder_role', "select public.issue_approval($1,$2,$3,$4,now()+interval '1 hour')", [
      missionA,
      d,
      { action: 'publish', counterpartyId: partyA, amountMinor: null, currency: null, artifactVersionId: a.versionId },
      token,
    ]);
    await scoped('specialist_role', 'select public.append_artifact_version($1,$2,$3)', [missionA, a.artifactId, { revision: 2 }]);
    await expect(reserve(intent('', { action: 'publish', effectClass: 'publish', artifactVersionId: a.versionId }), token)).rejects.toThrow(
      /artifact version stale/,
    );
  });
  it('break attempt 3: specialist cannot escalate through SECURITY DEFINER or public helpers', async () => {
    const m = await mandate();
    await expect(scoped('specialist_role', 'select public.reserve_effect($1,$2,null)', [missionA, intent(m)])).rejects.toThrow(
      /permission denied/,
    );
    await expect(scoped('specialist_role', "select private.audit($1,'performed','Fake',array[]::uuid[],null)", [missionA])).rejects.toThrow(
      /permission denied/,
    );
    const login = `lo_specialist_${Date.now()}`;
    await db.query(`create role ${login} login noinherit;grant specialist_role to ${login}`);
    const url = new URL(`/${databaseName}`, adminUrl);
    url.username = login;
    const restricted = new Client({ connectionString: url.toString() });
    await restricted.connect();
    try {
      await expect(scoped('specialist_role', 'set local role policy_role', [], missionA, uidA, restricted)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await restricted.end();
      await db.query(`drop role ${login}`);
    }
  });
  it('review regression: a specialist cannot promote an arbitrary URL to verified evidence', async () => {
    await expect(
      scoped(
        'specialist_role',
        "select public.append_evidence($1,'supply','external_verification','verified','{}','url','https://arbitrary.example.test',null,null)",
        [missionA],
      ),
    ).rejects.toThrow(/matching provider proof/);
  });
  it('review regression: cited evidence is tenant-checked and its correction stales decisions transitively', async () => {
    const evidence = await scoped(
      'specialist_role',
      "select public.append_evidence($1,'supply','quotation','claimed','{}','document','test:quote',null,null)id",
      [missionA],
    );
    const evidenceId = String(evidence.rows[0]?.['id']);
    const cited = { ...packet, options: packet.options.map(o => ({ ...o, evidenceIds: [evidenceId] })) };
    const proposed = await scoped('lead_role', "select public.propose_decision($1,'selection',$2,'supply','specification',null)id", [
      missionA,
      cited,
    ]);
    const d = String(proposed.rows[0]?.['id']);
    await approve(d);
    await scoped(
      'specialist_role',
      "select public.append_evidence($1,'supply','quotation','claimed','{}','document','test:corrected',null,$2)",
      [missionA, evidenceId],
    );
    expect((await scoped('founder_role', 'select *from public.active_decisions where id=$1', [d])).rows).toHaveLength(0);
    await expect(
      scoped('lead_role', "select public.propose_decision($1,'selection',$2,'supply','specification',null)", [missionA, cited]),
    ).rejects.toThrow(/stale/);
    await expect(
      scoped('lead_role', "select public.propose_decision($1,'selection',$2,'supply','specification',null)", [
        missionA,
        { ...cited, options: cited.options.map(o => ({ ...o, evidenceIds: [randomUUID()] })) },
      ]),
    ).rejects.toThrow(/cited evidence missing or cross tenant/);
  });
  it('review regression: payment_refund always requires a specific approval even with a matching mandate', async () => {
    const a = await artifact(),
      m = await mandate('payment_refund', 'spend', 50000, 100000);
    await expect(
      reserve(
        intent(m, {
          action: 'payment_refund',
          effectClass: 'spend',
          amountMinor: 100,
          currency: 'SAR',
          artifactVersionId: a.versionId,
          instrumentId: accountA,
        }),
      ),
    ).rejects.toThrow(/always requires approval/);
  });
  it('FR-PAY-02 draft/proposed artifacts cannot authorize spend; marking approved artifacts stale invalidates existing tokens and dependents', async () => {
    const a = await artifact(false),
      m = await mandate('sample_payment', 'spend', 1000, 2000);
    const paymentIntent = intent(m, {
      action: 'sample_payment',
      effectClass: 'spend',
      amountMinor: 100,
      currency: 'SAR',
      artifactVersionId: a.versionId,
      instrumentId: accountA,
    });
    await expect(reserve(paymentIntent)).rejects.toThrow(/not approved/);
    await scoped('specialist_role', "select public.set_artifact_status($1,$2,'proposed')", [missionA, a.versionId]);
    await expect(reserve(paymentIntent)).rejects.toThrow(/not approved/);
    const d = await decision();
    await approve(d);
    await scoped('founder_role', "select public.set_artifact_status($1,$2,'approved',$3)", [missionA, a.versionId, d]);
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    await scoped('founder_role', "select public.issue_approval($1,$2,$3,$4,now()+interval '1 hour')", [
      missionA,
      d,
      { action: 'publish', counterpartyId: partyA, amountMinor: null, currency: null, artifactVersionId: a.versionId },
      hash,
    ]);
    const dependent = await artifact();
    await scoped('specialist_role', "select public.add_dependency($1,$2,$3,'approved source')", [
      missionA,
      a.versionId,
      dependent.versionId,
    ]);
    await scoped('specialist_role', "select public.set_artifact_status($1,$2,'stale')", [missionA, a.versionId]);
    await expect(reserve(intent('', { action: 'publish', effectClass: 'publish', artifactVersionId: a.versionId }), hash)).rejects.toThrow(
      /stale/,
    );
    expect(
      (await scoped('founder_role', 'select *from public.stale_marks where mission_id=$1 and node_id=$2', [missionA, dependent.versionId]))
        .rows,
    ).toHaveLength(1);
    expect(
      (
        await scoped(
          'founder_role',
          'select i.*from public.approval_invalidations i join public.approvals a on a.id=i.approval_id where a.token_hash=$1',
          [hash],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('I-3/16 payment spend requires matching receipt and verified confirmation, with sandbox totals separated', async () => {
    const a = await artifact(),
      m = await mandate('sample_payment', 'spend', 50000, 100000);
    const i = intent(m, {
      action: 'sample_payment',
      effectClass: 'spend',
      amountMinor: 22500,
      currency: 'SAR',
      artifactVersionId: a.versionId,
      instrumentId: accountA,
    });
    const authorization = await reserve(i);
    const payment = await scoped('policy_role', "select public.prepare_payment($1,$2,'test-provider')id", [
      missionA,
      authorization.authorizationId,
    ]);
    const paymentId = String(payment.rows[0]?.['id']);
    await scoped('policy_role', 'select public.begin_effect($1,$2)', [missionA, authorization.authorizationId]);
    const providerReference = randomUUID(),
      orderId = randomUUID();
    const completed = await scoped('policy_role', 'select public.complete_effect($1,$2,$3)result', [
      missionA,
      authorization.authorizationId,
      { provider: 'test-provider', providerReference, operation: 'sample_payment', sandboxMode: true, data: { testMode: true, orderId } },
    ]);
    const receiptId = String(completed.rows[0]?.['result']?.['receiptId']);
    const wrong = await scoped(
      'ingress_role',
      "insert into public.events(mission_id,type,payload,provider,provider_event_id,signature_verified)values($1,'payment.captured',$2,'test-provider',$3,true)returning id",
      [missionA, { paymentId, amountMinor: 1, currency: 'SAR', sandboxMode: true }, randomUUID()],
    );
    await expect(
      scoped('policy_role', 'select public.confirm_payment($1,$2,$3,$4)', [missionA, paymentId, receiptId, wrong.rows[0]?.['id']]),
    ).rejects.toThrow(/verified payment confirmation required/);
    const correct = await scoped(
      'ingress_role',
      "insert into public.events(mission_id,type,payload,provider,provider_event_id,signature_verified)values($1,'payment.captured',$2,'test-provider',$3,true)returning id",
      [
        missionA,
        { paymentId, payeeId: partyA, providerReference, orderId, amountMinor: 22500, currency: 'SAR', sandboxMode: true },
        randomUUID(),
      ],
    );
    for (const mismatch of [{ payeeId: partyB }, { providerReference: randomUUID() }, { orderId: randomUUID() }]) {
      const bad = await scoped(
        'ingress_role',
        "insert into public.events(mission_id,type,payload,provider,provider_event_id,signature_verified)values($1,'payment.captured',$2,'test-provider',$3,true)returning id",
        [
          missionA,
          { paymentId, payeeId: partyA, providerReference, orderId, amountMinor: 22500, currency: 'SAR', sandboxMode: true, ...mismatch },
          randomUUID(),
        ],
      );
      await expect(
        scoped('policy_role', 'select public.confirm_payment($1,$2,$3,$4)', [missionA, paymentId, receiptId, bad.rows[0]?.['id']]),
      ).rejects.toThrow(/verified payment confirmation required/);
    }
    await scoped('policy_role', 'select public.confirm_payment($1,$2,$3,$4)', [missionA, paymentId, receiptId, correct.rows[0]?.['id']]);
    await scoped('policy_role', 'select public.confirm_payment($1,$2,$3,$4)', [missionA, paymentId, receiptId, correct.rows[0]?.['id']]);
    const totals = await scoped('founder_role', 'select *from public.money_totals where mission_id=$1', [missionA]);
    expect(totals.rows).toHaveLength(1);
    expect(totals.rows[0]?.['sandbox_mode']).toBe(true);
    expect(Number(totals.rows[0]?.['spent_minor'])).toBe(22500);
    expect(Number(totals.rows[0]?.['committed_minor'])).toBe(0);
    await expect(
      scoped(
        'policy_role',
        "insert into public.money_ledger(mission_id,kind,amount_minor,currency,basis,envelope,sandbox_mode)values($1,'spent',1,'SAR','accepted','test',true)",
        [missionA],
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it('I-13 committed pause linearizes after an existing locked dispatch and before the next one', async () => {
    const m = await mandate(),
      a = await reserve(intent(m));
    const c1 = new Client({ connectionString: new URL(`/${databaseName}`, adminUrl).toString() }),
      c2 = new Client({ connectionString: new URL(`/${databaseName}`, adminUrl).toString() });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('begin');
      await c1.query('set local role policy_role');
      await c1.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: uidA, mission_id: missionA })]);
      await c1.query('select public.begin_effect($1,$2)', [missionA, a.authorizationId]);
      let pauseCommitted = false;
      const pause = scoped('founder_role', "select public.transition_mission($1,'paused',null,null)", [missionA], missionA, uidA, c2).then(
        () => {
          pauseCommitted = true;
        },
      );
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(pauseCommitted).toBe(false);
      await c1.query('select public.complete_effect($1,$2,$3)', [
        missionA,
        a.authorizationId,
        { provider: 'test-email', providerReference: randomUUID(), operation: 'email', sandboxMode: true, data: { testMode: true } },
      ]);
      await c1.query('commit');
      await pause;
      expect(pauseCommitted).toBe(true);
      await expect(reserve(intent(m))).rejects.toThrow(/paused or ended/);
      await scoped('founder_role', "select public.transition_mission($1,'active',null,null)", [missionA]);
    } finally {
      await c1.end();
      await c2.end();
    }
  });
  it('I-4 process loss after non-idempotent dispatch preserves started claim and blocks a second provider call', async () => {
    const m = await mandate(),
      a = await reserve(intent(m));
    const connections: Client[] = [];
    let providerCalls = 0;
    const repository = new PostgresMissionRepository(db, async () => {
      const client = new Client({ connectionString: new URL(`/${databaseName}`, adminUrl).toString() });
      await client.connect();
      connections.push(client);
      await client.query('set role policy_role');
      await client.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: uidA, mission_id: missionA })]);
      return { query: (sql, parameters) => client.query(sql, parameters), release: () => {} };
    });
    try {
      const crashed = await repository.withDispatchLock(missionA, a.authorizationId, async () => {
        providerCalls++;
        throw new Error('Test-only process loss after remote acceptance');
      });
      expect(crashed.ok).toBe(false);
      const state = await reserve(
        intent(m, {
          idempotencyKey: (await db.query('select idempotency_key from public.effect_authorizations where id=$1', [a.authorizationId]))
            .rows[0]?.['idempotency_key'],
        }),
      );
      expect(state.status).toBe('started');
      const retry = await repository.withDispatchLock(missionA, a.authorizationId, async () => {
        providerCalls++;
        return 'unsafe';
      });
      expect(retry.ok).toBe(false);
      expect(providerCalls).toBe(1);
    } finally {
      for (const c of connections) await c.end();
    }
  });
  it('seed is repeat-safe, sandbox-labelled and creates domain artifacts without fabricated receipts', async () => {
    await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
    const first = await db.query("select count(*)::int n from public.artifacts where mission_id::text like '20000000-%'");
    await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
    const second = await db.query("select count(*)::int n from public.artifacts where mission_id::text like '20000000-%'");
    expect(second.rows).toEqual(first.rows);
    expect(Number(first.rows[0]?.['n'])).toBeGreaterThanOrEqual(5);
    expect(
      (await db.query("select count(*)::int n from public.provider_receipts where mission_id::text like '20000000-%'")).rows[0]?.['n'],
    ).toBe(0);
    const other = await scoped(
      'founder_role',
      "select *from public.readiness('20000000-0000-4000-8000-000000000002')",
      [],
      '20000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    );
    expect(other.rows.find(r => r['outcome'] === 'brand')?.['level']).toBe(2);
    await expect(db.query(await readFile(`${root}/supabase/rollback/202611120001_004_empty_only.sql`, 'utf8'))).rejects.toThrow(
      /Data-preserving rollback blocked/,
    );
    await db.query('rollback');
  });
  it('repository API carries one reviewed payment from proposal to verified sandbox spend and returns typed failures', async () => {
    const unpack = <T>(result: Result<T>): T => {
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    let mission: string = missionA;
    const repo = (role: Role) => new PostgresMissionRepository({ query: (sql, parameters) => scoped(role, sql, parameters, mission) });
    const founder = repo('founder_role');
    mission = unpack(await founder.createMission(founderA, 'launch', 'Repository API fixture', 'SAR', true, { fixture: true }));
    const thread = await scoped('founder_role', 'insert into public.threads(mission_id)values($1)returning id', [mission], mission);
    const threadId = String(thread.rows[0]?.['id']);
    unpack(await founder.appendFounderMessage(mission, threadId, 'Use the reviewed specification.'));
    unpack(await repo('lead_role').appendLeadMessage(mission, threadId, 'I will wait for your specific approval.'));
    const proposed = unpack(await repo('lead_role').proposeDecision(mission, 'selection', packet, 'supply', 'specification'));
    unpack(await founder.resolveDecision(mission, proposed, 'approve', 'a'));
    const artifact = await scoped(
      'specialist_role',
      "select public.create_artifact($1,'payment_proposal','supply','Test payment')id",
      [mission],
      mission,
    );
    const version = await scoped(
      'specialist_role',
      'select public.append_artifact_version($1,$2,$3)id',
      [mission, artifact.rows[0]?.['id'], { testMode: true }],
      mission,
    );
    const versionId = String(version.rows[0]?.['id']);
    await scoped('specialist_role', "select public.set_artifact_status($1,$2,'proposed')", [mission, versionId], mission);
    await scoped('founder_role', "select public.set_artifact_status($1,$2,'approved',$3)", [mission, versionId, proposed], mission);
    const token = randomUUID() + randomUUID();
    unpack(
      await founder.issueApproval(
        mission,
        proposed,
        { action: 'sample_payment', counterpartyId: partyA, amountMinor: 100, currency: 'SAR', artifactVersionId: versionId },
        token,
        new Date(Date.now() + 3600000).toISOString(),
      ),
    );
    const intent: EffectIntent = {
      missionId: mission,
      taskId: 'api-test',
      action: 'sample_payment',
      effectClass: 'spend',
      counterpartyId: partyA,
      amountMinor: 100,
      currency: 'SAR',
      artifactVersionId: versionId,
      idempotencyKey: randomUUID(),
      mode: 'do',
      sandboxMode: true,
      instrumentId: accountA,
      approvalToken: token,
      newContact: false,
    };
    const policy = repo('policy_role');
    const invalid = await policy.reserveEffect({ ...intent, amountMinor: 0.1 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('validation');
    const authorization = unpack(await policy.reserveEffect(intent));
    expect(authorization.status).toBe('reserved');
    unpack(await policy.beginEffect(mission, authorization.authorizationId));
    const providerReference = randomUUID(),
      orderId = randomUUID();
    const receipt = {
      provider: 'test-api-provider',
      providerReference,
      operation: 'sample_payment',
      sandboxMode: true,
      data: { testMode: true, orderId },
    };
    const completed = unpack(await policy.completeEffect(mission, authorization.authorizationId, receipt));
    expect(completed.status).toBe('performed');
    expect(unpack(await policy.getEffectReceipt(mission, authorization.authorizationId))).toEqual(receipt);
    const payment = await scoped(
      'policy_role',
      "select public.prepare_payment($1,$2,'test-api-provider')id",
      [mission, authorization.authorizationId],
      mission,
    );
    const paymentId = String(payment.rows[0]?.['id']);
    const event = await scoped(
      'ingress_role',
      "insert into public.events(mission_id,type,payload,provider,provider_event_id,signature_verified)values($1,'payment.captured',$2,'test-api-provider',$3,true)returning id",
      [
        mission,
        { paymentId, payeeId: partyA, providerReference, orderId, amountMinor: 100, currency: 'SAR', sandboxMode: true },
        randomUUID(),
      ],
      mission,
    );
    unpack(await policy.confirmPayment(mission, paymentId, String(completed.receiptId), String(event.rows[0]?.['id'])));
    expect(unpack(await founder.readiness(mission))).toHaveLength(6);
    expect(unpack(await founder.snapshot(mission))['payments']).toHaveLength(1);
    const scope = {
      actions: ['email'],
      effectClasses: ['communicate'],
      counterpartyIds: [partyA],
      channels: ['email'],
      purposes: ['samples'],
      instrumentIds: [],
      maxNewContacts: 2,
    };
    const mandateId = await scopedMandate(scope, 0, 0, mission);
    const failedAuthorization = unpack(
      await policy.reserveEffect({
        missionId: mission,
        taskId: 'failed-api',
        action: 'email',
        effectClass: 'communicate',
        counterpartyId: partyA,
        idempotencyKey: randomUUID(),
        mode: 'do',
        sandboxMode: true,
        mandateId,
        channel: 'email',
        purpose: 'samples',
        newContact: false,
      }),
    );
    unpack(await policy.beginEffect(mission, failedAuthorization.authorizationId));
    expect(unpack(await policy.failEffect(mission, failedAuthorization.authorizationId, true, 'Test-only timeout')).status).toBe(
      'ambiguous',
    );
    unpack(await founder.revokeMandate(mission, mandateId));
    unpack(await founder.transitionMission(mission, 'paused'));
    const paused = await policy.beginEffect(mission, failedAuthorization.authorizationId);
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.error.code).toBe('invariant_violation');
  });
});
