import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';
import { ProviderStorage } from './provider-storage.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = 'lo_dispatch_' + Date.now(),
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  prior = { ...process.env };
let db: Client;
beforeAll(async () => {
  await admin.connect();
  await admin.query('create database ' + name);
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  db = new Client({ connectionString: url.href });
  await db.connect();
  await db.query(
    (await readFile(root + '/supabase/tests/bootstrap.sql', 'utf8')).replace(
      'create role authenticated nologin noinherit nobypassrls;',
      () =>
        "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
    ),
  );
  for (const file of (await readdir(root + '/supabase/migrations')).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(root + '/supabase/migrations/' + file, 'utf8'));
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
  await db.query('update private.platform_controls set effects_enabled=true');
  process.env.DATABASE_URL = url.href;
  process.env.LO_EXECUTION_MODE = 'local';
  process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
  process.env.PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query('drop database if exists ' + name + ' with(force)');
  await admin.end();
});
async function fixture() {
  const missionId = randomUUID(),
    party = randomUUID(),
    second = randomUUID(),
    thread = randomUUID(),
    origin = randomUUID(),
    decision = randomUUID(),
    mandate = randomUUID();
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, mission_id: missionId })]);
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode)values($1,$2,'launch','Synthetic dispatch guard test','SAR',true)",
    [missionId, founder],
  );
  await db.query(
    "insert into public.counterparties(id,founder_id,kind,name,channels,verification)values($1,$3,'supplier','Synthetic first','{\"email\":\"first@example.test\"}','{\"emailVerified\":true}'),($2,$3,'supplier','Synthetic second','{\"email\":\"second@example.test\"}','{\"emailVerified\":true}')",
    [party, second, founder],
  );
  await db.query('insert into public.threads(id,mission_id,counterparty_id)values($1,$2,$3)', [thread, missionId, party]);
  await db.query(
    "insert into public.messages(id,mission_id,thread_id,channel,direction,original,provider_id,created_at)values($1,$2,$3,'email','inbound','Synthetic promised reply','synthetic-origin',clock_timestamp()-interval'2 days')",
    [origin, missionId, thread],
  );
  const scope = { authUserId: user, missionId };
  const commitment = String(
    (
      await withRole('lead_role', scope, c =>
        c.query("select public.open_commitment($1,$2,'inbound','Synthetic due reply',clock_timestamp()-interval'1 day')id", [
          missionId,
          party,
        ]),
      )
    ).rows[0]?.id,
  );
  await db.query("insert into public.decisions(id,mission_id,kind,outcome,packet,actor_id)values($1,$2,'mandate','supply','{}',$3)", [
    decision,
    missionId,
    user,
  ]);
  await db.query(
    "insert into public.mandates(id,mission_id,type,decision_id,scope,ceiling_per,ceiling_total,currency,expires_at)values($1,$2,'outreach',$3,$4,0,0,'SAR',clock_timestamp()+interval'1 day')",
    [
      mandate,
      missionId,
      decision,
      {
        actions: ['send_message'],
        effectClasses: ['communicate'],
        counterpartyIds: [party, second],
        channels: ['email'],
        purposes: ['follow_up'],
        maxNewContacts: 1,
        maxActions: 10,
      },
    ],
  );
  const chase = String(
    (
      await withRole('lead_role', scope, c =>
        c.query('select public.configure_commitment_chase($1,$2,$3,null,$4,null,1)id', [missionId, commitment, origin, mandate]),
      )
    ).rows[0]?.id,
  );
  const attempt = (await withRole('lead_role', scope, c => c.query('select public.next_commitment_chase($1,$2)r', [missionId, chase])))
    .rows[0]?.r as { taskId: string; attemptId: string };
  const intent = {
    missionId,
    taskId: attempt.taskId,
    action: 'send_message',
    effectClass: 'communicate',
    counterpartyId: party,
    idempotencyKey: randomUUID() as string,
    mode: 'do',
    sandboxMode: true,
    newContact: true,
    mandateId: mandate,
    channel: 'email',
    purpose: 'follow_up',
  };
  return { scope, party, second, thread, commitment, chase, attempt, mandate, intent };
}
const reserve = async (f: Awaited<ReturnType<typeof fixture>>, intent = f.intent) =>
  withRole(
    'policy_role',
    f.scope,
    async c =>
      (await c.query('select public.reserve_effect($1,$2)r', [f.scope.missionId, intent])).rows[0]?.r as {
        authorizationId: string;
        id?: string;
      },
  );
async function authorization(f: Awaited<ReturnType<typeof fixture>>) {
  await reserve(f);
  return String(
    (
      await db.query('select id from public.effect_authorizations where mission_id=$1 and idempotency_key=$2', [
        f.scope.missionId,
        f.intent.idempotencyKey,
      ])
    ).rows[0]?.id,
  );
}
const begin = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  withRole('policy_role', f.scope, c => c.query('select public.begin_effect($1,$2)', [f.scope.missionId, id]));
describe('FR-REC-02 FR-MAN-03 dispatch workflow races', () => {
  it.each(['reserved', 'started'])('blocks a reply committed after selecting a %s chase', async phase => {
    const f = await fixture(),
      id = await authorization(f);
    if (phase === 'started') await begin(f, id);
    await db.query(
      "insert into public.messages(mission_id,thread_id,channel,direction,original)values($1,$2,'email','inbound','Synthetic late reply')",
      [f.scope.missionId, f.thread],
    );
    await expect(begin(f, id)).rejects.toThrow(/chase closed, replied/);
    expect((await db.query('select from public.provider_receipts where mission_id=$1', [f.scope.missionId])).rowCount).toBe(0);
  });
  it('blocks commitment closure after selection while allowing an unchanged chase', async () => {
    const f = await fixture(),
      id = await authorization(f);
    await expect(begin(f, id)).resolves.toBeDefined();
    const proof = String(
      (
        await withRole('founder_role', f.scope, c =>
          c.query(
            "select public.append_evidence($1,'supply','returned_document','founder_confirmed','{}','document','Synthetic closure source')id",
            [f.scope.missionId],
          ),
        )
      ).rows[0]?.id,
    );
    await db.query("insert into public.commitment_states(mission_id,commitment_id,status,closed_by_evidence_id)values($1,$2,'closed',$3)", [
      f.scope.missionId,
      f.commitment,
      proof,
    ]);
    await expect(begin(f, id)).rejects.toThrow(/chase closed/);
  });
  it('enforces the actual new-recipient ceiling even if a caller omits the flag', async () => {
    const f = await fixture();
    await reserve(f, { ...f.intent, newContact: false });
    await expect(
      reserve(f, { ...f.intent, taskId: randomUUID(), counterpartyId: f.second, newContact: false, idempotencyKey: randomUUID() }),
    ).rejects.toThrow(/contact ceiling/);
    expect((await db.query('select from public.effect_authorizations where mission_id=$1', [f.scope.missionId])).rowCount).toBe(1);
  });
  it('derives first-contact status and preserves authorization identity after a receipt-backed outbound row', async () => {
    const f = await fixture(),
      storage = new ProviderStorage(f.scope),
      fields = { counterpartyId: f.party, mandateId: f.mandate, channel: 'email', purpose: 'follow_up', newContact: false };
    const first = await storage.buildIntent(f.intent.taskId, 'send_message', 'communicate', fields, [f.mandate]);
    expect(first.newContact).toBe(true);
    await reserve(f, { ...f.intent, idempotencyKey: first.idempotencyKey, newContact: first.newContact });
    const auth = String(
        (await db.query('select id from public.effect_authorizations where mission_id=$1', [f.scope.missionId])).rows[0]?.id,
      ),
      receipt = randomUUID();
    // Owner-created synthetic receipt checks local replay correlation, not actual delivery.
    await db.query(
      "insert into public.provider_receipts(id,mission_id,authorization_id,provider,provider_reference,operation,sandbox_mode,data)values($1,$2,$3,'synthetic-test-only',$4,'send_message',true,'{}')",
      [receipt, f.scope.missionId, auth, randomUUID()],
    );
    await db.query(
      "insert into public.messages(mission_id,thread_id,channel,direction,original,receipt_id)values($1,$2,'email','outbound','Synthetic delivered row',$3)",
      [f.scope.missionId, f.thread, receipt],
    );
    const replay = await storage.buildIntent(f.intent.taskId, 'send_message', 'communicate', fields, [f.mandate]);
    expect(replay.newContact).toBe(true);
    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
    expect((await storage.buildIntent(randomUUID(), 'send_message', 'communicate', fields, [f.mandate])).newContact).toBe(false);
  });
});
