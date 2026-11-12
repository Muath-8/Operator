import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { reconcileNotifications } from './notification-service.js';

// Explicit sandbox fixtures against native PostgreSQL. No provider is contacted;
// synthetic receipt/event rows exist only in this disposable test database.
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_notify_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  party = randomUUID(),
  instrument = randomUUID(),
  priorEnv = { ...process.env };
let db: Client;
async function mission(locale = 'en') {
  const id = randomUUID();
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,metadata)values($1,$2,'launch','Synthetic notification mission','SAR',true,$3)",
    [id, founder, { locale, timeZone: 'UTC' }],
  );
  return { authUserId: user, missionId: id };
}
const packet = (refs: string[] = [], amount: number | null = null) => ({
  question: 'Review the actual synthetic proposal',
  options: [
    {
      id: 'a',
      label: 'Approve this scoped proposal',
      artifactVersionIds: refs,
      evidenceIds: [],
      cost: amount === null ? null : { amountMinor: amount, currency: 'SAR' },
      timeDays: 0,
      consequences: 'Synthetic database regression only',
    },
  ],
  recommendation: { optionId: 'a', reasons: ['Synthetic fixture'] },
  staleImpact: [],
  approvedVersionIds: refs,
  defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
});
async function propose(scope: ActorScope, kind = 'selection', refs: string[] = [], amount: number | null = null, gate = 'direction') {
  return withRole('lead_role', scope, async client => {
    const id = z
      .uuid()
      .parse(
        (
          await client.query("select public.propose_decision($1,$2,$3,'brand',$4)null_id", [
            scope.missionId,
            kind,
            packet(refs, amount),
            gate,
          ])
        ).rows[0]?.null_id,
      );
    await client.query(
      "insert into public.blockers(mission_id,outcome,blocking_outcome,required_level,description,node_id)values($1,'demand','brand',5,'Synthetic urgent decision blocker',$2)",
      [scope.missionId, id],
    );
    return id;
  });
}
async function sourceArtifact(scope: ActorScope, content: Record<string, unknown>) {
  return withRole('specialist_role', scope, async client => {
    const parent = z
        .uuid()
        .parse(
          (await client.query("select public.create_artifact($1,'notification_fixture','brand','Synthetic source')id", [scope.missionId]))
            .rows[0]?.id,
        ),
      ref = z
        .uuid()
        .parse((await client.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, parent, content])).rows[0]?.id);
    await client.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, ref]);
    return ref;
  });
}
async function approve(scope: ActorScope, did: string, ref: string) {
  await withRole('founder_role', scope, async client => {
    await client.query("select public.resolve_decision($1,$2,'approve','a')", [scope.missionId, did]);
    await client.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, ref, did]);
  });
}
async function preferences(scope: ActorScope, quietHours: { from: string; to: string } | null, cadence = 'daily') {
  await withRole('founder_role', scope, client =>
    client.query("insert into public.founder_preferences(mission_id,kind,value,actor_id)values($1,'notifications',$2,$3)", [
      scope.missionId,
      { digestCadence: cadence, quietHours },
      user,
    ]),
  );
}
function quietNow() {
  const hour = new Date().getUTCHours();
  return { from: `${String((hour + 23) % 24).padStart(2, '0')}:00`, to: `${String((hour + 2) % 24).padStart(2, '0')}:00` };
}
async function activity(scope: ActorScope, count: number, past = false, label = 'planned') {
  await withRole('lead_role', scope, async client => {
    for (let index = 0; index < count; index++)
      await client.query('insert into public.activity(mission_id,label,summary,actor_id,created_at)values($1,$2,$3,$4,$5)', [
        scope.missionId,
        label,
        `Synthetic research activity ${index + 1}`,
        user,
        past ? new Date(Date.now() - 2 * 86400000) : new Date(),
      ]);
  });
}
async function notifications(scope: ActorScope) {
  return withRole('founder_role', scope, client =>
    client.query('select *from public.notification_events where mission_id=$1 order by created_at,id', [scope.missionId]),
  );
}
async function payment(scope: ActorScope) {
  const ref = await sourceArtifact(scope, { amountMinor: 12345, currency: 'SAR' }),
    did = await propose(scope, 'engagement', [ref], 12345, 'payment');
  await approve(scope, did, ref);
  const token = randomUUID() + randomUUID(),
    binding = { action: 'payment_capture', counterpartyId: party, amountMinor: 12345, currency: 'SAR', artifactVersionId: ref };
  await withRole('founder_role', scope, client =>
    client.query('select public.issue_approval($1,$2,$3,$4,$5)', [
      scope.missionId,
      did,
      binding,
      createHash('sha256').update(token).digest('hex'),
      new Date(Date.now() + 3600000),
    ]),
  );
  return withRole('policy_role', scope, async client => {
    const intent = {
        missionId: scope.missionId,
        taskId: 'synthetic-notification',
        action: 'payment_capture',
        effectClass: 'spend',
        counterpartyId: party,
        amountMinor: 12345,
        currency: 'SAR',
        artifactVersionId: ref,
        instrumentId: instrument,
        idempotencyKey: randomUUID(),
        mode: 'do',
        sandboxMode: true,
        purpose: 'Synthetic sample invoice',
      },
      result = (
        await client.query('select public.reserve_effect($1,$2,$3)result', [
          scope.missionId,
          intent,
          createHash('sha256').update(token).digest('hex'),
        ])
      ).rows[0]?.result,
      authorization = z.uuid().parse(result.authorizationId);
    await client.query('select public.begin_effect($1,$2)', [scope.missionId, authorization]);
    const pid = z
      .uuid()
      .parse(
        (await client.query('select public.prepare_payment($1,$2,$3)id', [scope.missionId, authorization, 'synthetic-notifications']))
          .rows[0]?.id,
      );
    return { authorization, pid };
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
  await db.query(
    "insert into public.counterparties(id,founder_id,kind,name,channels)values($1,$2,'supplier','Synthetic Notification Supplier',jsonb_build_object('email','synthetic@example.invalid'))",
    [party, founder],
  );
  await db.query(
    "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'synthetic-notifications','connected','{pay}')",
    [instrument, founder],
  );
  await db.query('update private.platform_controls set effects_enabled=true');
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

describe('FR-NOT-01/02/03/05 I-8 actual native notification queue and release', () => {
  it('a repeated-recipient tiny-spend mandate warns at its actual action cap despite ample money and no new contacts', async () => {
    const scope = await mission();
    await preferences(scope, quietNow());
    const expires = new Date(Date.now() + 3600000).toISOString(),
      mandateScope = {
        actions: ['sample_order'],
        effectClasses: ['spend'],
        counterpartyIds: [party],
        channels: [],
        purposes: ['synthetic action count'],
        instrumentIds: [instrument],
        maxNewContacts: 0,
        maxActions: 2,
      },
      ref = await sourceArtifact(scope, {
        mandate: {
          type: 'sample_order',
          scope: mandateScope,
          ceilingPer: 100000,
          ceilingTotal: 100000,
          currency: 'SAR',
          expiresAt: expires,
        },
      }),
      did = await propose(scope, 'mandate', [ref]);
    await approve(scope, did, ref);
    const mandate = await withRole('founder_role', scope, async client =>
      z
        .uuid()
        .parse(
          (
            await client.query("select public.grant_mandate($1,$2,'sample_order',$3,100000,100000,$4)id", [
              scope.missionId,
              did,
              mandateScope,
              expires,
            ])
          ).rows[0]?.id,
        ),
    );
    const reserve = () =>
      withRole('policy_role', scope, client =>
        client.query('select public.reserve_effect($1,$2,null)', [
          scope.missionId,
          {
            missionId: scope.missionId,
            taskId: randomUUID(),
            action: 'sample_order',
            effectClass: 'spend',
            counterpartyId: party,
            amountMinor: 1,
            currency: 'SAR',
            artifactVersionId: ref,
            instrumentId: instrument,
            idempotencyKey: randomUUID(),
            mandateId: mandate,
            purpose: 'synthetic action count',
            newContact: false,
            mode: 'do',
            sandboxMode: true,
          },
        ]),
      );
    await reserve();
    expect((await reconcileNotifications(scope)).notificationIds).toHaveLength(0);
    await reserve();
    expect((await reconcileNotifications(scope)).notificationIds).toHaveLength(1);
    const rows = (await notifications(scope)).rows.filter(r => r.kind === 'mandate');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Mandate ceiling reached', delivery: 'immediate' });
    expect(String(rows[0]?.why)).toContain('Reserved actions: 2/2');
    expect(String(rows[0]?.why)).toContain('New contacts: 0/0');
    expect((await reconcileNotifications(scope)).notificationIds).toHaveLength(0);
    await expect(reserve()).rejects.toThrow(/action count/);
  });
  it('ten recorded research activities produce one due digest; retries and concurrent consumers do not duplicate it', async () => {
    const scope = await mission();
    await activity(scope, 10, true);
    const result = await Promise.all([reconcileNotifications(scope), reconcileNotifications(scope)]);
    expect(result.reduce((sum, r) => sum + r.notificationIds.length, 0)).toBe(1);
    const rows = await notifications(scope);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ kind: 'digest', delivery: 'digest', title: '10 mission updates', locale: 'en' });
    expect(
      (await db.query('select count(*)::integer count from public.notification_releases where mission_id=$1', [scope.missionId])).rows[0]
        ?.count,
    ).toBe(10);
    expect((await reconcileNotifications(scope)).notificationIds).toEqual([]);
  });
  it('quiet hours hold decisions and routine digests durably; changed preferences release the held Arabic decision and re-time a digest', async () => {
    const scope = await mission('ar');
    await preferences(scope, quietNow());
    const did = await propose(scope);
    await activity(scope, 1, true);
    const first = await reconcileNotifications(scope);
    expect(first.notificationIds).toHaveLength(0);
    expect(first.nextDueAt).not.toBeNull();
    expect((await notifications(scope)).rows).toHaveLength(0);
    await preferences(scope, null);
    const released = await reconcileNotifications(scope);
    expect(released.notificationIds).toHaveLength(2);
    const rows = (await notifications(scope)).rows;
    expect(rows.find(r => r.kind === 'decision')).toMatchObject({
      locale: 'ar',
      title: 'قرار يحتاج مراجعتك',
      target: { kind: 'decision', decisionId: did },
    });
    expect(rows.find(r => r.kind === 'digest')?.delivery).toBe('digest');
  });
  it('a resolved decision is suppressed rather than delivered after quiet hours', async () => {
    const scope = await mission();
    await preferences(scope, quietNow());
    const did = await propose(scope);
    await reconcileNotifications(scope);
    await withRole('founder_role', scope, client =>
      client.query("select public.resolve_decision($1,$2,'approve','a')", [scope.missionId, did]),
    );
    await preferences(scope, null);
    const result = await reconcileNotifications(scope);
    expect(result.suppressed).toBe(1);
    expect((await notifications(scope)).rows.filter(r => r.kind === 'decision')).toHaveLength(0);
  });
  it('an acknowledged Later suppresses its older held request without claiming the decision was approved', async () => {
    const scope = await mission();
    await preferences(scope, quietNow());
    const did = await propose(scope);
    await reconcileNotifications(scope);
    await withRole('founder_role', scope, client =>
      client.query("select public.resolve_decision($1,$2,'defer',null)", [scope.missionId, did]),
    );
    await preferences(scope, null);
    expect((await reconcileNotifications(scope)).suppressed).toBe(1);
    expect((await notifications(scope)).rows.filter(r => r.kind === 'decision')).toHaveLength(0);
    expect(
      (
        await db.query(
          "select count(*)::integer count from public.decision_resolutions where decision_id=$1 and response in('approve','choose')",
          [did],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
  it('only approaching/reached reserved mandate exposure creates deduplicated warnings, including inside quiet hours', async () => {
    const scope = await mission();
    await preferences(scope, quietNow());
    const contacts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = randomUUID();
      await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'supplier',$3)", [
        id,
        founder,
        `Synthetic distinct contact ${i}`,
      ]);
      contacts.push(id);
    }
    let nextContact = 0;
    const expires = new Date(Date.now() + 3600000).toISOString(),
      mandateScope = {
        actions: ['email'],
        effectClasses: ['communicate'],
        counterpartyIds: contacts,
        channels: ['email'],
        purposes: ['synthetic enquiry'],
        instrumentIds: [],
        maxNewContacts: 10,
      },
      ref = await sourceArtifact(scope, {
        mandate: { type: 'outreach', scope: mandateScope, ceilingPer: 0, ceilingTotal: 0, currency: 'SAR', expiresAt: expires },
      }),
      did = await propose(scope, 'mandate', [ref]);
    await approve(scope, did, ref);
    const mandate = await withRole('founder_role', scope, async client =>
      z
        .uuid()
        .parse(
          (await client.query("select public.grant_mandate($1,$2,'outreach',$3,0,0,$4)id", [scope.missionId, did, mandateScope, expires]))
            .rows[0]?.id,
        ),
    );
    const reserve = () => {
      const recipient = contacts[nextContact++];
      if (!recipient) throw new Error('Expected distinct native contact fixture');
      return withRole('policy_role', scope, client =>
        client.query('select public.reserve_effect($1,$2,null)', [
          scope.missionId,
          {
            missionId: scope.missionId,
            taskId: 'synthetic-notification',
            action: 'email',
            effectClass: 'communicate',
            counterpartyId: recipient,
            idempotencyKey: randomUUID(),
            mandateId: mandate,
            channel: 'email',
            purpose: 'synthetic enquiry',
            newContact: true,
            mode: 'do',
            sandboxMode: true,
          },
        ]),
      );
    };
    for (let i = 0; i < 8; i++) await reserve();
    expect((await reconcileNotifications(scope)).notificationIds).toHaveLength(1);
    await reserve();
    expect((await reconcileNotifications(scope)).notificationIds).toHaveLength(0);
    await reserve();
    expect((await reconcileNotifications(scope)).notificationIds).toHaveLength(1);
    const rows = (await notifications(scope)).rows;
    expect(rows.filter(r => r.kind === 'mandate')).toHaveLength(2);
    expect(rows.every(r => r.delivery === 'immediate')).toBe(true);
    expect(rows[1]?.title).toBe('Mandate ceiling reached');
  });
  it('verified sandbox payment capture is held in quiet hours and later shows exact payee/amount/purpose; no capture means no success notification', async () => {
    const scope = await mission();
    await preferences(scope, quietNow());
    const p = await payment(scope);
    expect((await reconcileNotifications(scope)).notificationIds).toHaveLength(0);
    const capture = `synthetic-capture-${randomUUID()}`,
      order = `synthetic-order-${randomUUID()}`;
    const receipt = await withRole('policy_role', scope, async client =>
      z
        .uuid()
        .parse(
          (
            await client.query('select public.complete_effect($1,$2,$3)result', [
              scope.missionId,
              p.authorization,
              {
                provider: 'synthetic-notifications',
                providerReference: capture,
                operation: 'payment_capture',
                sandboxMode: true,
                data: { orderId: order, captureId: capture },
              },
            ])
          ).rows[0]?.result.receiptId,
        ),
    );
    const event = await withRole('ingress_role', scope, async client =>
      z
        .uuid()
        .parse(
          (
            await client.query(
              "insert into public.events(mission_id,type,payload,provider,provider_event_id,signature_verified)values($1,'payment.captured',$2,'synthetic-notifications',$3,true)returning id",
              [
                scope.missionId,
                {
                  paymentId: p.pid,
                  payeeId: party,
                  providerReference: capture,
                  orderId: order,
                  amountMinor: 12345,
                  currency: 'SAR',
                  sandboxMode: true,
                },
                randomUUID(),
              ],
            )
          ).rows[0]?.id,
        ),
    );
    await withRole('policy_role', scope, client =>
      client.query('select public.confirm_payment($1,$2,$3,$4)', [scope.missionId, p.pid, receipt, event]),
    );
    expect((await reconcileNotifications(scope)).notificationIds).toHaveLength(0);
    await preferences(scope, null);
    await reconcileNotifications(scope);
    const rows = (await notifications(scope)).rows.filter(r => r.kind === 'payment');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.why).toContain('Synthetic Notification Supplier');
    expect(rows[0]?.why).toContain('SAR 123.45');
    expect(rows[0]?.why).toContain('Synthetic sample invoice');
    expect(rows[0]?.why).toContain('Sandbox');
    await db.query(
      "insert into public.money_ledger(mission_id,kind,amount_minor,currency,basis,envelope,sandbox_mode,created_at)values($1,'forecast',500,'SAR','estimate','synthetic-notification',true,$2)",
      [scope.missionId, new Date(Date.now() - 2 * 86400000)],
    );
    await reconcileNotifications(scope);
    const digest = (await notifications(scope)).rows.find(r => r.kind === 'digest');
    expect(digest?.why).toContain('Spent / refunded / committed / forecast');
    expect(digest?.why).toContain('SAR 123.45');
    expect(digest?.why).toContain('SAR 5.00');
  });
  it('a real failed/ambiguous spend authorization breaks quiet hours without claiming a successful payment or duplicating its audit row', async () => {
    const scope = await mission();
    await preferences(scope, quietNow());
    const p = await payment(scope);
    await withRole('policy_role', scope, client =>
      client.query("select public.fail_effect($1,$2,true,'Synthetic ambiguous transport outcome; no success inferred')", [
        scope.missionId,
        p.authorization,
      ]),
    );
    const result = await reconcileNotifications(scope);
    expect(result.notificationIds).toHaveLength(1);
    const rows = (await notifications(scope)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'failure', delivery: 'immediate', title: 'Payment needs reconciliation' });
    expect(rows[0]?.why).toContain('SAR 123.45');
  });
  it('outcome-blocking failures are immediate outside quiet hours; arbitrary Lead notification writes and cross-tenant/private RPCs are denied', async () => {
    const scope = await mission();
    await activity(scope, 1, false, 'blocked');
    expect((await reconcileNotifications(scope)).notificationIds).toHaveLength(1);
    expect((await notifications(scope)).rows[0]).toMatchObject({ kind: 'failure', delivery: 'immediate' });
    await expect(
      withRole('lead_role', scope, client =>
        client.query(
          "insert into public.notification_events(mission_id,kind,title,why,target,delivery,locale)values($1,'payment','Fake','No receipt','{}','immediate','en')",
          [scope.missionId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('founder_role', scope, client => client.query('select public.lock_notification_reconcile($1)', [scope.missionId])),
    ).rejects.toThrow(/permission denied/);
    const otherUser = randomUUID();
    await expect(reconcileNotifications({ authUserId: otherUser, missionId: scope.missionId })).rejects.toThrow(/tenant|denied/);
    await expect(
      withRole('lead_role', scope, client =>
        client.query("select public.release_notification($1,null,'payment','Fake','No sources','{}','immediate','en')", [scope.missionId]),
      ),
    ).rejects.toThrow(/source|content/);
  });
  it('a new decision backed by a real inbound message and changed recommendation produces an actionable reply notification', async () => {
    const scope = await mission(),
      previous = await propose(scope);
    await withRole('founder_role', scope, client =>
      client.query("select public.resolve_decision($1,$2,'approve','a')", [scope.missionId, previous]),
    );
    const event = await withRole('ingress_role', scope, async client =>
      z
        .uuid()
        .parse(
          (
            await client.query(
              "insert into public.events(mission_id,type,payload,provider,provider_event_id,signature_verified)values($1,'message.received','{}','synthetic-notifications',$2,true)returning id",
              [scope.missionId, randomUUID()],
            )
          ).rows[0]?.id,
        ),
    );
    const message = await withRole('ingress_role', scope, async client =>
        z
          .uuid()
          .parse(
            (
              await client.query(
                "select public.ingest_inbound_message($1,$2,'email',$3,'synthetic@example.invalid','Synthetic reply changes this proposal')id",
                [scope.missionId, event, randomUUID()],
              )
            ).rows[0]?.id,
          ),
      ),
      evidence = await withRole('specialist_role', scope, async client =>
        z
          .uuid()
          .parse(
            (
              await client.query("select public.append_evidence($1,'brand','reply','claimed','{}','message',$2)null_id", [
                scope.missionId,
                message,
              ])
            ).rows[0]?.null_id,
          ),
      );
    const body = {
      ...packet(),
      options: packet().options.map(o => ({ ...o, evidenceIds: [evidence] })),
      recommendation: { optionId: 'a', reasons: ['The recorded inbound reply changed the recommended terms'] },
      impact: { decisionIds: [previous], artifactIds: [], commitmentIds: [], outcomes: ['brand'], cost: null, delayDays: 0 },
    };
    const changed = await withRole('lead_role', scope, async client =>
      z
        .uuid()
        .parse(
          (await client.query("select public.propose_decision($1,'change',$2,'brand','direction',$3)id", [scope.missionId, body, previous]))
            .rows[0]?.id,
        ),
    );
    await reconcileNotifications(scope);
    expect((await notifications(scope)).rows).toContainEqual(
      expect.objectContaining({
        kind: 'reply',
        title: 'A reply changed a recommendation',
        target: { kind: 'decision', decisionId: changed },
      }),
    );
  });
  it('a routine backlog cannot starve an immediate outcome-blocking failure', async () => {
    const scope = await mission();
    await activity(scope, 501);
    await activity(scope, 1, false, 'blocked');
    const result = await reconcileNotifications(scope);
    expect(result.examined).toBe(500);
    expect((await notifications(scope)).rows).toContainEqual(expect.objectContaining({ kind: 'failure', delivery: 'immediate' }));
    expect(result.remaining).toBe(501);
  });
  it('a future schedule cannot be released early and queue/release rows stay immutable to application roles', async () => {
    const scope = await mission();
    await activity(scope, 1);
    await reconcileNotifications(scope);
    const source = z
      .uuid()
      .parse((await db.query('select id from public.notification_sources where mission_id=$1', [scope.missionId])).rows[0]?.id);
    await expect(
      withRole('lead_role', scope, client =>
        client.query("select public.release_notification($1,$2,'digest','Too early','This source is not due','{}','digest','en')", [
          scope.missionId,
          [source],
        ]),
      ),
    ).rejects.toThrow(/not yet due/);
    for (const table of ['notification_sources', 'notification_schedules', 'notification_releases', 'notification_suppressions']) {
      await expect(
        withRole('lead_role', scope, client => client.query(`delete from public.${table} where mission_id=$1`, [scope.missionId])),
      ).rejects.toThrow(/permission denied/);
    }
    expect((await notifications(scope)).rows).toHaveLength(0);
  });
});
