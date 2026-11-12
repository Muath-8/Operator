import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { MarketplaceProfileSchema, hashPayload } from '@lo/adapters';
import { PostgresMissionRepository } from '@lo/state';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { connectProviderAccount } from './accounts.js';
import { ProviderStorage, provisionProviderCredential } from './provider-storage.js';
import { reconcileMarketplaceInbox } from './provider-tools.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_marketplace_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
  party = randomUUID(),
  prior = { ...process.env };
let db: Client, scope: ActorScope, accountId: string;
const profile = MarketplaceProfileSchema.parse({
  platform: 'alibaba',
  contextId: randomUUID(),
  founderAccountLabel: 'Explicit test founder',
  counterpartyId: party,
  threadId: 'EXPLICIT_TEST',
  url: 'https://message.alibaba.com/thread/EXPLICIT_TEST',
  allowedHosts: ['message.alibaba.com'],
  timeoutSeconds: 30,
  accountSelector: '#account',
  accountText: 'Explicit test founder',
  identitySelector: '#identity',
  identityText: 'Synthetic supplier',
  composerSelector: '#composer',
  sendSelector: '#send',
  messageSelector: '.message',
  bodySelector: '.body',
  messageIdAttribute: 'data-id',
  directionAttribute: 'data-direction',
  outboundValue: 'out',
  inboundValue: 'in',
  sendUrl: 'https://message.alibaba.com/send',
  sendFormat: 'json',
  textField: 'text',
  threadField: 'thread',
  readPostUrls: [],
  reviewedAt: new Date().toISOString(),
  sandboxThread: true,
});
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
  const mission = randomUUID();
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode)values($1,$2,'launch','Explicit test marketplace mission','SAR',true)",
    [mission, founder],
  );
  scope = { authUserId: user, missionId: mission };
  await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'supplier','Synthetic marketplace contact')", [
    party,
    founder,
  ]);
  await db.query('update private.platform_controls set effects_enabled=true');
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
  process.env['PROVIDER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  const connected = await connectProviderAccount(
    scope,
    {
      provider: 'browserbase',
      credential: { apiKey: 'explicit-test', projectId: 'fixture-project', allowedHosts: profile.allowedHosts, maxSessionSeconds: 60 },
      settings: { marketplaceProfiles: [profile] },
      founderAttestsOwnership: true,
      mode: 'local',
      serviceBudgetUnits: 300,
    },
    async () => ({ status: 200, headers: {}, body: { id: 'fixture-project' } }),
  );
  if (!connected.ok) throw new Error(JSON.stringify(connected.error));
  accountId = connected.value.accountId;
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name}with(force)`);
  await admin.end();
});
describe('FR-COM-03 real account registration and native marketplace thread import contracts', () => {
  it('encrypted operator configuration registers exact founder-owned recipient/thread/profile; another profile or role cannot import', async () => {
    const resolved = await new ProviderStorage(scope).marketplaceProfile(party, profile.threadId);
    expect(resolved.profile).toEqual(profile);
    await expect(new ProviderStorage(scope).marketplaceProfile(randomUUID(), profile.threadId)).rejects.toThrow();
    await expect(
      withRole('voice_role', scope, c =>
        c.query('select public.record_marketplace_inbound($1,$2,$3,$4,$5,$6,$7)', [
          scope.missionId,
          accountId,
          party,
          profile.threadId,
          hashPayload(profile),
          randomUUID(),
          [],
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('policy_role', { ...scope, authUserId: randomUUID() }, c =>
        c.query('select public.check_marketplace_thread($1,$2,$3,$4,$5)', [
          scope.missionId,
          accountId,
          party,
          profile.threadId,
          hashPayload(profile),
        ]),
      ),
    ).rejects.toThrow();
  });
  it('outbound ledger requires its actual immutable receipt and rejects changed message text', async () => {
    const message = {
        channel: 'marketplace',
        threadId: profile.threadId,
        text: 'Confirm sample lead time in writing.',
        translation: 'Confirm sample lead time in writing.',
        language: 'en',
        purpose: 'follow_up',
      },
      version = await withRole('specialist_role', scope, async c => {
        const a = (
          await c.query("select public.create_artifact($1,'outbound_message','supply','Synthetic marketplace draft')id", [scope.missionId])
        ).rows[0]?.id;
        const v = String(
          (
            await c.query('select public.append_artifact_version($1,$2,$3)id', [
              scope.missionId,
              a,
              {
                effectIntent: {
                  action: 'marketplace_message',
                  effectClass: 'communicate',
                  counterpartyId: party,
                  instrumentId: accountId,
                  channel: 'marketplace',
                  purpose: 'follow_up',
                },
                payload: message,
              },
            ])
          ).rows[0]?.id,
        );
        await c.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, v]);
        return v;
      });
    const packet = {
        question: 'Approve exact synthetic marketplace draft?',
        options: [
          {
            id: 'a',
            label: 'Approve exact draft',
            artifactVersionIds: [version],
            evidenceIds: [],
            cost: null,
            timeDays: 0,
            consequences: 'Synthetic test only',
          },
        ],
        recommendation: { optionId: 'a', reasons: ['Exact reviewed draft'] },
        staleImpact: [],
        approvedVersionIds: [version],
        defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
      },
      decision = await withRole('lead_role', scope, async c =>
        String(
          (await c.query("select public.propose_decision($1,'engagement',$2,'supply','outreach')id", [scope.missionId, packet])).rows[0]
            ?.id,
        ),
      ),
      token = randomBytes(32).toString('hex'),
      tokenHash = createHash('sha256').update(token).digest('hex');
    await withRole('founder_role', scope, async c => {
      const repo = new PostgresMissionRepository(c);
      await repo.resolveDecision(String(scope.missionId), decision, 'approve', 'a');
      await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, version, decision]);
      await c.query('select public.issue_approval($1,$2,$3,$4,$5)', [
        scope.missionId,
        decision,
        { action: 'marketplace_message', counterpartyId: party, artifactVersionId: version, amountMinor: null, currency: null },
        tokenHash,
        new Date(Date.now() + 60000),
      ]);
    });
    await withRole('policy_role', scope, async c => {
      const intent = {
        missionId: scope.missionId,
        taskId: randomUUID(),
        action: 'marketplace_message',
        effectClass: 'communicate',
        counterpartyId: party,
        instrumentId: accountId,
        artifactVersionId: version,
        channel: 'marketplace',
        purpose: 'follow_up',
        mode: 'do',
        sandboxMode: true,
        idempotencyKey: randomUUID(),
      };
      const authorization = (await c.query('select public.reserve_effect($1,$2,$3)result', [scope.missionId, intent, tokenHash])).rows[0]
        ?.result.authorizationId;
      await c.query('select public.begin_effect($1,$2)', [scope.missionId, authorization]);
      await c.query('select public.complete_effect($1,$2,$3)', [
        scope.missionId,
        authorization,
        {
          provider: 'browserbase',
          providerReference: 'alibaba:EXPLICIT_TEST:OUT_1',
          operation: 'marketplace_message',
          sandboxMode: true,
          data: { idempotencyKey: intent.idempotencyKey },
        },
      ]);
    });
    await expect(
      withRole('policy_role', scope, c =>
        c.query('select public.record_marketplace_outbound($1,$2,$3,$4,$5)', [
          scope.missionId,
          party,
          'alibaba:EXPLICIT_TEST:OUT_1',
          'Unreviewed binding price',
          message.translation,
        ]),
      ),
    ).rejects.toThrow(/immutable/);
    const record = () =>
      withRole('policy_role', scope, async c =>
        String(
          (
            await c.query('select public.record_marketplace_outbound($1,$2,$3,$4,$5)id', [
              scope.missionId,
              party,
              'alibaba:EXPLICIT_TEST:OUT_1',
              message.text,
              message.translation,
            ])
          ).rows[0]?.id,
        ),
      );
    expect(await record()).toBe(await record());
  });
  it('identical concurrent sends share one held session budget while effect authority remains separately single-use', async () => {
    const storage = new ProviderStorage(scope),
      key = `marketplace:${randomUUID()}`;
    expect(
      await Promise.all([
        storage.ensureMarketplaceBudget(String(scope.missionId), key, 30),
        storage.ensureMarketplaceBudget(String(scope.missionId), key, 30),
      ]),
    ).toEqual([true, true]);
    expect(
      (
        await db.query('select count(*)::int n from public.service_reservations where mission_id=$1 and task_key=$2', [
          scope.missionId,
          key,
        ])
      ).rows[0]?.n,
    ).toBe(1);
    expect(await storage.ensureMarketplaceBudget(String(scope.missionId), key, 31)).toBe(false);
  });
  it('inbox polling is default-off; explicit15minute polling deduplicates concurrent ticks and retains its real preparation lease/budget', async () => {
    let sessions = 0,
      reads = 0;
    const test = {
      transport: async (request: { url: string }) => {
        if (request.url.endsWith('/v1/sessions')) {
          sessions++;
          return { status: 201, headers: {}, body: { id: randomUUID(), connectUrl: 'wss://connect.browserbase.com/explicit-test' } };
        }
        return { status: 200, headers: {}, body: {} };
      },
      driver: {
        visit: async () => {
          reads++;
          return {
            url: profile.url,
            messages: [{ messageId: 'POLL_1', text: 'Explicit test poll claim.', direction: 'inbound' as const }],
            screenshotBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6U1sAAAAASUVORK5CYII=',
          };
        },
      },
    };
    expect(await reconcileMarketplaceInbox(scope, test)).toMatchObject({ examined: 0, polled: 0 });
    expect(sessions).toBe(0);
    await provisionProviderCredential(scope, {
      accountId,
      provider: 'browserbase',
      sandboxMode: true,
      credential: { apiKey: 'explicit-test', projectId: 'fixture-project', allowedHosts: profile.allowedHosts, maxSessionSeconds: 60 },
      settings: { marketplaceProfiles: [profile], marketplacePollMinutes: 15 },
    });
    const results = await Promise.all([reconcileMarketplaceInbox(scope, test), reconcileMarketplaceInbox(scope, test)]);
    expect(results.reduce((n, r) => n + r.polled, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.imported, 0)).toBe(1);
    expect(reads).toBe(1);
    expect(sessions).toBe(1);
    expect(await reconcileMarketplaceInbox(scope, test)).toMatchObject({ polled: 0 });
    expect(
      (await db.query('select count(*)::int n from public.marketplace_poll_attempts where mission_id=$1', [scope.missionId])).rows[0]?.n,
    ).toBe(1);
  });
  it('imports actual poll messages once as claimed source evidence and propagates STOP without inventing signed webhook verification', async () => {
    const payload = [
      { messageId: 'IN_1', text: 'Sample costs are supplier claims.', direction: 'inbound' },
      { messageId: 'IN_STOP', text: 'STOP', direction: 'inbound' },
      { messageId: 'OUT_1', text: 'Our outbound text', direction: 'outbound' },
    ];
    const poll = () =>
      withRole('policy_role', scope, async c =>
        Number(
          (
            await c.query('select public.record_marketplace_inbound($1,$2,$3,$4,$5,$6,$7)count', [
              scope.missionId,
              accountId,
              party,
              profile.threadId,
              hashPayload(profile),
              randomUUID(),
              JSON.stringify(payload),
            ])
          ).rows[0]?.count,
        ),
      );
    expect(await poll()).toBe(2);
    expect(await poll()).toBe(0);
    expect(
      (await db.query("select trust from public.evidence where mission_id=$1 and kind='marketplace_reply'", [scope.missionId])).rows,
    ).toEqual([{ trust: 'claimed' }, { trust: 'claimed' }, { trust: 'claimed' }]);
    expect((await db.query('select count(*)::int n from public.counterparty_optouts where counterparty_id=$1', [party])).rows[0]?.n).toBe(
      1,
    );
    expect(
      (await db.query('select count(*)::int n from public.events where mission_id=$1 and signature_verified', [scope.missionId])).rows[0]
        ?.n,
    ).toBe(0);
  });
});
