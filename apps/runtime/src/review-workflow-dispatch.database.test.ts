import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PostgresMissionRepository } from '@lo/state';
import { withRole, closeDatabasePools } from './database.js';
import { ProviderStorage, provisionProviderCredential, storeApprovalToken } from './provider-storage.js';
import { configureCommitmentChase, reconcileCommitmentChases } from './chase.js';
import { executeApprovedProviderEffect } from './provider-tools.js';
import { reconcileNotifications } from './notification-service.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_review_guide_chase_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  mission = randomUUID(),
  party = randomUUID(),
  account = randomUUID(),
  scope = { authUserId: user, missionId: mission },
  prior = { ...process.env };
let db: Client;
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
  for (const f of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(`${root}/supabase/migrations/${f}`, 'utf8'));
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,involvement)values($1,$2,'launch','Explicit synthetic Guide follow-up review','SAR',true,'guide')",
    [mission, founder],
  );
  await db.query(
    'insert into public.counterparties(id,founder_id,kind,name,channels,verification)values($1,$2,\'supplier\',\'Synthetic Guide supplier\',\'{"email":"supplier@test.example","businessHourStart":0,"businessHourEnd":24}\',\'{"emailVerified":true}\')',
    [party, founder],
  );
  await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'resend','connected','{send}')", [
    account,
    founder,
  ]);
  await db.query('update private.platform_controls set effects_enabled=true');
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
  process.env['PROVIDER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  await provisionProviderCredential(scope, {
    accountId: account,
    provider: 'resend',
    sandboxMode: true,
    credential: {
      apiKey: 'explicit-local-test-key',
      from: 'operator@test.example',
      testDomain: 'test.example',
      allowedSandboxRecipients: ['supplier@test.example'],
    },
  });
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name}with(force)`);
  await admin.end();
});
describe('independent Guide chase actual approved-message recovery', () => {
  it('files a real completed message after a write fault and source revision, without invoking the provider again', async () => {
    const fresh = randomUUID(),
      active = { authUserId: user, missionId: fresh },
      original = 'Explicit synthetic original approved message; no real external delivery.';
    await db.query(
      "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,involvement)values($1,$2,'launch','Synthetic receipt to message crash recovery','SAR',true,'guide')",
      [fresh, founder],
    );
    await provisionProviderCredential(active, {
      accountId: account,
      provider: 'resend',
      sandboxMode: true,
      credential: {
        apiKey: 'explicit-local-fault-test-key',
        from: 'operator@test.example',
        testDomain: 'test.example',
        allowedSandboxRecipients: ['supplier@test.example'],
      },
    });
    const source = {
        effectIntent: {
          action: 'send_message',
          effectClass: 'communicate',
          counterpartyId: party,
          instrumentId: account,
          channel: 'email',
          purpose: 'follow_up',
        },
        payload: {
          channel: 'email',
          text: original,
          translation: original,
          language: 'en',
          purpose: 'follow_up',
          subject: 'Synthetic recovery probe',
          hasDocument: false,
        },
      },
      created = await withRole('specialist_role', active, async c => {
        const artifact = String(
            (await c.query("select public.create_artifact($1,'outbound_message','supply','Synthetic original outbound source')id", [fresh]))
              .rows[0]?.id,
          ),
          version = String((await c.query('select public.append_artifact_version($1,$2,$3)id', [fresh, artifact, source])).rows[0]?.id);
        await c.query("select public.set_artifact_status($1,$2,'proposed')", [fresh, version]);
        return { artifact, version };
      }),
      packet = {
        question: 'Approve the original synthetic send',
        options: [
          {
            id: 'a',
            label: 'Send exact original',
            artifactVersionIds: [created.version],
            evidenceIds: [],
            cost: null,
            timeDays: 0,
            consequences: 'One recorded synthetic send only',
          },
        ],
        approvedVersionIds: [created.version],
        recommendation: { optionId: 'a', reasons: ['Native crash-recovery probe'] },
        staleImpact: [],
        defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
      },
      decision = await withRole('lead_role', active, async c =>
        String((await c.query("select public.propose_decision($1,'engagement',$2,'supply','follow_up')id", [fresh, packet])).rows[0]?.id),
      ),
      token = randomBytes(32).toString('hex');
    const approval = await withRole('founder_role', active, async c => {
      await c.query("select public.resolve_decision($1,$2,'approve','a')", [fresh, decision]);
      await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [fresh, created.version, decision]);
      const issued = await new PostgresMissionRepository(c).issueApproval(
        fresh,
        decision,
        { action: 'send_message', counterpartyId: party, amountMinor: null, currency: null, artifactVersionId: created.version },
        token,
        new Date(Date.now() + 3600000).toISOString(),
      );
      if (!issued.ok) throw new Error('Expected synthetic send approval');
      return issued.value;
    });
    await storeApprovalToken(active, approval, token);
    let calls = 0;
    const transport = async () => {
        calls++;
        return { status: 200, headers: {}, body: { id: 'EXPLICIT_SYNTHETIC_COMPLETED_BEFORE_CRASH' } };
      },
      fault = vi.spyOn(ProviderStorage.prototype, 'recordOutbound').mockImplementationOnce(async () => {
        await withRole('specialist_role', active, c =>
          c.query('select public.append_artifact_version($1,$2,$3)', [
            fresh,
            created.artifact,
            { ...source, payload: { ...source.payload, text: 'Later revised unsent source', translation: 'Later revised unsent source' } },
          ]),
        );
        throw new Error('Explicit native fault after completed receipt before outbound filing');
      });
    try {
      await executeApprovedProviderEffect(active, created.version, randomUUID(), transport);
    } finally {
      fault.mockRestore();
    }
    expect(
      (
        await db.query(
          "select count(*)::int n from public.provider_receipts where mission_id=$1 and provider_reference='EXPLICIT_SYNTHETIC_COMPLETED_BEFORE_CRASH'",
          [fresh],
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(calls).toBe(1);
    await executeApprovedProviderEffect(active, created.version, randomUUID(), transport);
    expect(calls).toBe(1);
    const recorded = (
      await db.query(
        "select original,translation,artifact_version_refs from public.messages where mission_id=$1 and direction='outbound'and provider_id='EXPLICIT_SYNTHETIC_COMPLETED_BEFORE_CRASH'",
        [fresh],
      )
    ).rows;
    expect(recorded).toEqual([{ original, translation: original, artifact_version_refs: [created.version] }]);
  });
  it('counts caller-omitted first contacts identically for authority, scoped usage and the reached warning', async () => {
    const fresh = randomUUID(),
      secondParty = randomUUID(),
      active = { authUserId: user, missionId: fresh };
    await db.query(
      "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,involvement)values($1,$2,'launch','Explicit synthetic contact-count review','SAR',true,'do')",
      [fresh, founder],
    );
    await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'supplier','Synthetic second contact')", [
      secondParty,
      founder,
    ]);
    const expires = new Date(Date.now() + 3600000).toISOString(),
      coverage = {
        actions: ['send_message'],
        effectClasses: ['communicate'],
        counterpartyIds: [party, secondParty],
        channels: ['email'],
        purposes: ['follow_up'],
        instrumentIds: [],
        maxNewContacts: 1,
      };
    const version = await withRole('specialist_role', active, async c => {
        const artifact = String(
            (await c.query("select public.create_artifact($1,'mandate','supply','Synthetic one-contact scope')id", [fresh])).rows[0]?.id,
          ),
          v = String(
            (
              await c.query('select public.append_artifact_version($1,$2,$3)id', [
                fresh,
                artifact,
                { mandate: { type: 'outreach', scope: coverage, ceilingPer: 0, ceilingTotal: 0, currency: 'SAR', expiresAt: expires } },
              ])
            ).rows[0]?.id,
          );
        await c.query("select public.set_artifact_status($1,$2,'proposed')", [fresh, v]);
        return v;
      }),
      packet = {
        question: 'Approve one new contact for this native fixture',
        options: [
          {
            id: 'a',
            label: 'One contact only',
            artifactVersionIds: [version],
            evidenceIds: [],
            cost: null,
            timeDays: 0,
            consequences: 'No provider call in this count probe',
          },
        ],
        approvedVersionIds: [version],
        recommendation: { optionId: 'a', reasons: ['Native authority/count regression'] },
        staleImpact: [],
        defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
      },
      decision = await withRole('lead_role', active, async c =>
        String((await c.query("select public.propose_decision($1,'mandate',$2,'supply','outreach')id", [fresh, packet])).rows[0]?.id),
      ),
      mandate = await withRole('founder_role', active, async c => {
        await c.query("select public.resolve_decision($1,$2,'approve','a')", [fresh, decision]);
        await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [fresh, version, decision]);
        return String(
          (await c.query("select public.grant_mandate($1,$2,'outreach',$3,0,0,$4)id", [fresh, decision, coverage, expires])).rows[0]?.id,
        );
      });
    const reserve = (recipient: string) =>
      withRole('policy_role', active, c =>
        c.query('select public.reserve_effect($1,$2,null)', [
          fresh,
          {
            missionId: fresh,
            taskId: randomUUID(),
            action: 'send_message',
            effectClass: 'communicate',
            counterpartyId: recipient,
            mandateId: mandate,
            channel: 'email',
            purpose: 'follow_up',
            mode: 'do',
            sandboxMode: true,
            idempotencyKey: randomUUID(),
            newContact: false,
          },
        ]),
      );
    await reserve(party);
    await expect(reserve(secondParty)).rejects.toThrow(/contact ceiling/);
    const usage = await withRole(
      'lead_role',
      active,
      async c => (await c.query('select public.mandate_usage($1,$2)result', [fresh, mandate])).rows[0]?.result,
    );
    expect(String(usage.contacts)).toBe('1');
    await reconcileNotifications(active);
    const notices = (await db.query("select title,why from public.notification_events where mission_id=$1 and kind='mandate'", [fresh]))
      .rows;
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe('Mandate ceiling reached');
    expect(String(notices[0]?.why)).toContain('New contacts: 1/1');
  });
  it('advances the chase from the exact already performed approved draft receipt instead of leaving it as another draft', async () => {
    const thread = String(
        (await db.query('insert into public.threads(mission_id,counterparty_id)values($1,$2)returning id', [mission, party])).rows[0]?.id,
      ),
      origin = String(
        (
          await db.query(
            "insert into public.messages(mission_id,thread_id,channel,direction,original,provider_id,created_at)values($1,$2,'email','inbound','Synthetic promised written update','explicit-synthetic-inbound',clock_timestamp()-interval'2 days')returning id",
            [mission, thread],
          )
        ).rows[0]?.id,
      ),
      commitment = await withRole('lead_role', scope, async c =>
        String(
          (
            await c.query(
              "select public.open_commitment($1,$2,'inbound','Supplier owes synthetic written update',clock_timestamp()-interval'1 day')id",
              [mission, party],
            )
          ).rows[0]?.id,
        ),
      ),
      chase = await configureCommitmentChase(scope, { commitmentId: commitment, originMessageId: origin, intervalHours: 1 });
    expect(await reconcileCommitmentChases(scope)).toMatchObject({ sent: 0, held: 1 });
    const version = (
      await db.query(
        "select v.id from public.artifact_versions v join public.commitment_chase_attempts a on a.task_id::text=v.content->>'originatingTaskId'where a.chase_id=$1",
        [chase],
      )
    ).rows[0]?.id;
    if (typeof version !== 'string') throw new Error('Expected actual persisted Guide draft');
    const packet = {
        question: 'Approve exact synthetic Guide follow-up',
        options: [
          {
            id: 'a',
            label: 'Send exact follow-up',
            artifactVersionIds: [version],
            evidenceIds: [],
            cost: null,
            timeDays: 0,
            consequences: 'One synthetic recorded message',
          },
        ],
        approvedVersionIds: [version],
        recommendation: { optionId: 'a', reasons: ['Native recovery probe'] },
        staleImpact: [],
        defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
      },
      decision = await withRole('lead_role', scope, async c =>
        String((await c.query("select public.propose_decision($1,'engagement',$2,'supply','follow_up')id", [mission, packet])).rows[0]?.id),
      ),
      token = randomBytes(32).toString('hex');
    const approval = await withRole('founder_role', scope, async c => {
      await c.query("select public.resolve_decision($1,$2,'approve','a')", [mission, decision]);
      await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [mission, version, decision]);
      const issued = await new PostgresMissionRepository(c).issueApproval(
        mission,
        decision,
        { action: 'send_message', counterpartyId: party, amountMinor: null, currency: null, artifactVersionId: version },
        token,
        new Date(Date.now() + 3600000).toISOString(),
      );
      if (!issued.ok) throw new Error('Expected explicit native approval');
      return issued.value;
    });
    await storeApprovalToken(scope, approval, token);
    let calls = 0;
    const sent = await executeApprovedProviderEffect(scope, version, randomUUID(), async () => {
      calls++;
      return { status: 200, headers: {}, body: { id: 'EXPLICIT_SYNTHETIC_GUIDE_CHASE' } };
    });
    expect(sent.ok).toBe(true);
    expect(calls).toBe(1);
    await reconcileCommitmentChases(scope);
    const results = (
      await db.query(
        "select result.status from public.commitment_chase_results result join public.commitment_chase_attempts attempt on attempt.id=result.attempt_id where attempt.chase_id=$1 and result.status='sent'",
        [chase],
      )
    ).rows;
    expect(results).toEqual([{ status: 'sent' }]);
    expect(calls).toBe(1);
  });
});
