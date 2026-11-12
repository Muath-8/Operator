import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { JsonValue } from '@lo/state';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { configureCommitmentChase, reconcileCommitmentChases } from './chase.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_chase_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  priorEnv = { ...process.env };
let db: Client;
async function artifact(scope: ActorScope, type: string, content: Record<string, JsonValue>, approve = false) {
  const version = await withRole('specialist_role', scope, async c => {
    const id = String(
      (
        await c.query("select public.create_artifact($1,$2,$3,'Synthetic chase source')id", [
          scope.missionId,
          type,
          type === 'product_spec' ? 'product' : 'supply',
        ])
      ).rows[0]?.id,
    );
    return String((await c.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, id, content])).rows[0]?.id);
  });
  if (approve) {
    const packet = {
        question: 'Synthetic approval fixture only',
        options: [
          {
            id: 'a',
            label: 'Approve synthetic source',
            artifactVersionIds: [version],
            evidenceIds: [],
            cost: null,
            timeDays: 0,
            consequences: 'No real supplier acceptance',
          },
        ],
        recommendation: { optionId: 'a', reasons: ['Native fixture'] },
        staleImpact: [],
        approvedVersionIds: [version],
        defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
      },
      decision = await withRole('lead_role', scope, async c =>
        String(
          (await c.query("select public.propose_decision($1,'selection',$2,'supply','supplier_terms')id", [scope.missionId, packet]))
            .rows[0]?.id,
        ),
      );
    await withRole('founder_role', scope, async c => {
      await c.query("select public.resolve_decision($1,$2,'approve','a')", [scope.missionId, decision]);
      await c.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, version]);
      await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, version, decision]);
    });
  }
  return version;
}
async function quoteFixture(scope: ActorScope, supplier: string) {
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, mission_id: scope.missionId })]);
  const thread = randomUUID(),
    message = randomUUID(),
    quote = randomUUID(),
    evidence = await withRole('specialist_role', scope, async c =>
      String(
        (
          await c.query(
            "select public.append_evidence($1,'supply','supplier_quote','claimed','{\"synthetic\":true}','document','Synthetic source fixture; no external verification')id",
            [scope.missionId],
          )
        ).rows[0]?.id,
      ),
    );
  await db.query('insert into public.threads(id,mission_id,counterparty_id)values($1,$2,$3)', [thread, scope.missionId, supplier]);
  await db.query(
    "insert into public.messages(id,mission_id,thread_id,channel,direction,original,provider_id,created_at)values($1,$2,$3,'email','inbound','Synthetic source quotation','synthetic-quote',clock_timestamp()-interval'3 days')",
    [message, scope.missionId, thread],
  );
  await db.query(
    "insert into public.sourcing_quote_ingestions(id,mission_id,message_id,supplier_id,attempt_key,source_evidence_id,status,quote,unconfirmed_fields,missing_fields)values($1,$2,$3,$4,'synthetic-fixture',$5,'confirmed_reading',$6,'{}','{}')",
    [quote, scope.missionId, message, supplier, evidence, { validUntil: new Date(Date.now() + 86400000).toISOString() }],
  );
  return { quote, evidence };
}
async function comparisonFixture(scope: ActorScope, _silentSupplier: string) {
  const supplier = randomUUID(),
    assessment = randomUUID();
  await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'supplier','Synthetic runner-up')", [
    supplier,
    founder,
  ]);
  const spec = await artifact(scope, 'product_spec', { synthetic: true }, true),
    source = await quoteFixture(scope, supplier);
  // Owner fixture represents an already validated eligible route. The separate
  // sourcing suite exercises creation; chase tests its scope/freshness binding.
  await db.query(
    'insert into public.sourcing_assessments(id,mission_id,ingestion_id,spec_version_id,assessment)values($1,$2,$3,$4,\'{"eligible":true,"verificationEvidenceIds":[]}\')',
    [assessment, scope.missionId, source.quote, spec],
  );
  const version = await artifact(scope, 'supplier_comparison', {
    specVersionId: spec,
    ranking: [{ supplierId: supplier, assessmentId: assessment, rank: 1 }],
  });
  return { version, supplier, assessment, spec, ...source };
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected explicit native fixture record');
  return value;
}
async function fixture(alternate: 'email' | 'whatsapp' | null = 'whatsapp', verified = true, ranking = false) {
  const missionId = randomUUID(),
    party = randomUUID(),
    thread = randomUUID(),
    origin = randomUUID();
  await db.query(
    'insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,metadata)values($1,$2,\'launch\',\'Synthetic chase workflow fixture\',\'SAR\',true,\'{"locale":"en","timeZone":"UTC"}\')',
    [missionId, founder],
  );
  await db.query(
    'insert into public.counterparties(id,founder_id,kind,name,channels,verification)values($1,$2,\'supplier\',\'Synthetic supplier\',\'{"email":"supplier@example.test","phone":"+15555550199"}\',$3)',
    [party, founder, { emailVerified: verified, phoneVerified: verified }],
  );
  await db.query('insert into public.threads(id,mission_id,counterparty_id)values($1,$2,$3)', [thread, missionId, party]);
  await db.query(
    "insert into public.messages(id,mission_id,thread_id,channel,direction,original,provider_id,created_at)values($1,$2,$3,'email','inbound','Synthetic revised quote promised tomorrow','synthetic-inbound',clock_timestamp()-interval'2 days')",
    [origin, missionId, thread],
  );
  const scope = { authUserId: user, missionId },
    commitment = await withRole('lead_role', scope, async c =>
      z
        .uuid()
        .parse(
          (
            await c.query(
              "select public.open_commitment($1,$2,'inbound','Revised written quotation',clock_timestamp()-interval'1 day')id",
              [missionId, party],
            )
          ).rows[0]?.id,
        ),
    );
  const ranked = ranking ? await comparisonFixture(scope, party) : null,
    chase = await configureCommitmentChase(scope, {
      commitmentId: commitment,
      originMessageId: origin,
      ...(alternate ? { alternateChannel: alternate } : {}),
      ...(ranked ? { comparisonVersionId: ranked.version } : {}),
      intervalHours: 1,
    });
  return { scope, party, thread, origin, commitment, chase, ranked };
}
async function next(scope: ActorScope, chase: string) {
  return withRole(
    'lead_role',
    scope,
    async c =>
      (await c.query('select public.next_commitment_chase($1,$2)result', [scope.missionId, chase])).rows[0]?.result as {
        escalate: boolean;
        attemptId: string;
        taskId: string;
        channel: string;
        body: string;
      } | null,
  );
}
/** Explicit owner-created synthetic receipt fixtures test correlation only.
 * They are not provider calls, delivery evidence or release evaluation scores. */
async function receipt(f: Awaited<ReturnType<typeof fixture>>, attempt: NonNullable<Awaited<ReturnType<typeof next>>>, wrongTask = false) {
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, mission_id: f.scope.missionId })]);
  const mandate = randomUUID(),
    decision = randomUUID(),
    authorization = randomUUID(),
    r = randomUUID(),
    intent = {
      missionId: f.scope.missionId,
      taskId: wrongTask ? randomUUID() : attempt.taskId,
      action: 'send_message',
      effectClass: 'communicate',
      counterpartyId: f.party,
      channel: attempt.channel,
      purpose: 'follow_up',
      mode: 'do',
      sandboxMode: true,
      idempotencyKey: randomUUID(),
    };
  await db.query("insert into public.decisions(id,mission_id,kind,outcome,packet,actor_id)values($1,$2,'mandate','supply','{}',$3)", [
    decision,
    f.scope.missionId,
    user,
  ]);
  await db.query(
    "insert into public.mandates(id,mission_id,type,decision_id,scope,ceiling_per,ceiling_total,currency,expires_at)values($1,$2,'outreach',$3,'{}',0,0,'SAR',clock_timestamp()+interval'1 day')",
    [mandate, f.scope.missionId, decision],
  );
  await db.query(
    'insert into public.effect_authorizations(id,mission_id,intent,intent_hash,idempotency_key,mandate_id,sandbox_mode)values($1,$2,$3,$4,$5,$6,true)',
    [authorization, f.scope.missionId, intent, 'synthetic-hash', intent.idempotencyKey, mandate],
  );
  await db.query(
    "insert into public.provider_receipts(id,mission_id,authorization_id,provider,provider_reference,operation,sandbox_mode,data)values($1,$2,$3,'synthetic-test-only',$4,'send_message',true,'{}')",
    [r, f.scope.missionId, authorization, randomUUID()],
  );
  await db.query(
    "insert into public.messages(mission_id,thread_id,channel,direction,original,provider_id,receipt_id)values($1,$2,$3,'outbound',$4,$5,$6)",
    [f.scope.missionId, f.thread, attempt.channel, attempt.body, randomUUID(), r],
  );
  return r;
}
async function result(
  f: Awaited<ReturnType<typeof fixture>>,
  a: NonNullable<Awaited<ReturnType<typeof next>>>,
  status: string,
  r: string | null = null,
) {
  return withRole('policy_role', f.scope, c =>
    c.query('select public.record_commitment_chase_result($1,$2,$3,$4,$5)', [
      f.scope.missionId,
      a.attemptId,
      status,
      'Synthetic native correlation test',
      r,
    ]),
  );
}
// TEST ONLY: immutable historical rows inserted by the isolated database owner.
// This exercises elapsed response windows without a production clock override.
async function historicalSent(f: Awaited<ReturnType<typeof fixture>>, a: NonNullable<Awaited<ReturnType<typeof next>>>) {
  const r = await receipt(f, a);
  await db.query(
    "insert into public.commitment_chase_results(mission_id,attempt_id,status,receipt_id,reason,created_at)values($1,$2,'sent',$3,'Synthetic historical receipt fixture',clock_timestamp()-interval'2 hours')",
    [f.scope.missionId, a.attemptId, r],
  );
}
beforeAll(async () => {
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
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = priorEnv;
  await db?.end();
  await admin.query(`drop database if exists ${name}with(force)`);
  await admin.end();
});
describe('FR-COM-08 FR-LEAD-11 durable receipt-backed chase sequence', () => {
  it('promotes only the current eligible comparison candidate as non-binding research work', async () => {
    const f = await fixture('whatsapp', true, true),
      a = required(await next(f.scope, f.chase));
    await historicalSent(f, a);
    await historicalSent(f, required(await next(f.scope, f.chase)));
    const result = await withRole('lead_role', f.scope, c =>
      c.query('select public.escalate_commitment_chase($1,$2)result', [f.scope.missionId, f.chase]),
    );
    expect(result.rows[0]?.result).toMatchObject({ disposition: 'candidate_promoted', promotedSupplierId: required(f.ranked).supplier });
    expect(
      (await db.query('select count(*)::int n from public.decision_resolutions where mission_id=$1', [f.scope.missionId])).rows[0]?.n,
    ).toBe(1);
  });
  it('a stale past accepted supplier still requires a founder replacement decision and is never auto-switched', async () => {
    const f = await fixture(null),
      quote = await quoteFixture(f.scope, f.party);
    const accepted = await artifact(f.scope, 'accepted_terms', { acceptedQuote: { quoteId: quote.quote } }, true);
    await withRole('specialist_role', f.scope, async c => {
      const row = (await c.query('select artifact_id from public.artifact_versions where id=$1', [accepted])).rows[0];
      await c.query('select public.append_artifact_version($1,$2,$3)', [
        f.scope.missionId,
        row?.artifact_id,
        { syntheticCorrection: true },
      ]);
    });
    const a = required(await next(f.scope, f.chase));
    await historicalSent(f, a);
    const result = await withRole('lead_role', f.scope, c =>
      c.query('select public.escalate_commitment_chase($1,$2)result', [f.scope.missionId, f.chase]),
    );
    expect(result.rows[0]?.result).toMatchObject({ disposition: 'replacement_decision', promotedSupplierId: null });
  });
  it('a corrected quote source makes a formerly eligible ranked candidate unavailable', async () => {
    const f = await fixture(null, true, true),
      a = required(await next(f.scope, f.chase));
    await historicalSent(f, a);
    await withRole('specialist_role', f.scope, c =>
      c.query(
        "select public.append_evidence($1,'supply','supplier_quote','claimed','{\"corrected\":true}','document','Synthetic corrected quote',null,$2)",
        [f.scope.missionId, required(f.ranked).evidence],
      ),
    );
    const result = await withRole('lead_role', f.scope, c =>
      c.query('select public.escalate_commitment_chase($1,$2)result', [f.scope.missionId, f.chase]),
    );
    expect(result.rows[0]?.result).toMatchObject({ disposition: 'no_eligible_candidate', promotedSupplierId: null });
  });
  it('concurrent retries share a task and failed/unavailable/draft sends cannot advance', async () => {
    const f = await fixture(),
      attempts = await Promise.all([next(f.scope, f.chase), next(f.scope, f.chase)]),
      a = required(attempts[0]);
    expect(attempts[1]).toEqual(a);
    for (const status of ['blocked', 'failed', 'ambiguous', 'draft']) {
      await result(f, a, status);
      expect(await next(f.scope, f.chase)).toEqual(a);
    }
    await expect(
      withRole('lead_role', f.scope, c => c.query('select public.escalate_commitment_chase($1,$2)', [f.scope.missionId, f.chase])),
    ).rejects.toThrow(/receipt-backed/);
  });
  it('rejects an unrelated task receipt and enforces the response window after a real correlated ledger receipt', async () => {
    const f = await fixture(),
      a = required(await next(f.scope, f.chase));
    await expect(result(f, a, 'sent', await receipt(f, a, true))).rejects.toThrow(/matching task/);
    await result(f, a, 'sent', await receipt(f, a));
    await result(f, a, 'sent', await receipt(f, a));
    expect(await next(f.scope, f.chase)).toBeNull();
    expect(
      (await db.query("select count(*)::int n from public.commitment_chase_results where attempt_id=$1 and status='sent'", [a.attemptId]))
        .rows[0]?.n,
    ).toBe(1);
  });
  it('same channel then verified alternate then one routine unresponsive escalation, never fake promotion', async () => {
    const f = await fixture(),
      a = required(await next(f.scope, f.chase));
    expect(a.channel).toBe('email');
    await historicalSent(f, a);
    const b = required(await next(f.scope, f.chase));
    expect(b.channel).toBe('whatsapp');
    expect(b.taskId).not.toBe(a.taskId);
    await historicalSent(f, b);
    expect(await next(f.scope, f.chase)).toMatchObject({ escalate: true });
    const attempts = await Promise.all([
      withRole('lead_role', f.scope, c => c.query('select public.escalate_commitment_chase($1,$2)result', [f.scope.missionId, f.chase])),
      withRole('lead_role', f.scope, c => c.query('select public.escalate_commitment_chase($1,$2)result', [f.scope.missionId, f.chase])),
    ]);
    expect(attempts.filter(r => r.rows[0]?.result !== null)).toHaveLength(1);
    expect(
      (await db.query('select disposition,promoted_supplier_id from public.commitment_chase_escalations where chase_id=$1', [f.chase]))
        .rows,
    ).toEqual([{ disposition: 'no_eligible_candidate', promoted_supplier_id: null }]);
    expect(
      (
        await db.query(
          "select ns.class from public.notification_sources ns join public.activity a on a.id=ns.source_id where ns.mission_id=$1 and a.summary like'Supplier unresponsive%'",
          [f.scope.missionId],
        )
      ).rows,
    ).toEqual([{ class: 'routine' }]);
  });
  it('without a verified alternate skips no failed send and escalates only after the first successful channel and wait', async () => {
    const f = await fixture(null),
      a = required(await next(f.scope, f.chase));
    await historicalSent(f, a);
    expect(await next(f.scope, f.chase)).toMatchObject({ escalate: true });
  });
  it('a new inbound reply, a closed commitment and a committed pause each prevent further attempts', async () => {
    for (const change of ['reply', 'closed', 'paused']) {
      const f = await fixture();
      if (change === 'reply')
        await db.query(
          "insert into public.messages(mission_id,thread_id,channel,direction,original,provider_id)values($1,$2,'email','inbound','Synthetic late reply','synthetic-late')",
          [f.scope.missionId, f.thread],
        );
      if (change === 'closed')
        await db.query("insert into public.commitment_states(mission_id,commitment_id,status)values($1,$2,'cancelled')", [
          f.scope.missionId,
          f.commitment,
        ]);
      if (change === 'paused')
        await withRole('founder_role', f.scope, c => c.query("select public.transition_mission($1,'paused')", [f.scope.missionId]));
      expect(await next(f.scope, f.chase)).toBeNull();
    }
  });
  it('cross-tenant references, unverified alternate, mutation and privileged helper calls are rejected', async () => {
    const f = await fixture(),
      g = await fixture(null, false);
    await expect(configureCommitmentChase(g.scope, { commitmentId: f.commitment, originMessageId: g.origin })).rejects.toThrow();
    await expect(
      configureCommitmentChase(g.scope, {
        commitmentId: g.commitment,
        originMessageId: g.origin,
        alternateChannel: 'whatsapp',
        intervalHours: 1,
      }),
    ).rejects.toThrow(/verified/);
    await expect(
      withRole('lead_role', f.scope, c => c.query('select private.chase_open($1,$2)', [f.scope.missionId, f.chase])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('founder_role', f.scope, c => c.query('select public.next_commitment_chase($1,$2)', [f.scope.missionId, f.chase])),
    ).rejects.toThrow(/permission denied/);
    await expect(db.query('update public.commitment_chases set interval_hours=2 where id=$1', [f.chase])).rejects.toThrow(
      /append.only|immutable/,
    );
  });
  it('production reconciliation holds missing provider configuration and records no sent state or external call', async () => {
    const f = await fixture();
    expect(await reconcileCommitmentChases(f.scope)).toMatchObject({ examined: 1, sent: 0, held: 1, escalated: 0 });
    expect(
      (
        await db.query(
          'select status from public.commitment_chase_results r join public.commitment_chase_attempts a on a.id=r.attempt_id where a.chase_id=$1',
          [f.chase],
        )
      ).rows,
    ).toEqual([{ status: 'blocked' }]);
  });
});
