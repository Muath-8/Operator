import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  connectProviderAccount,
  listProviderAccounts,
  revokeProviderAccount,
  startShopifyAccountOAuth,
  completeShopifyAccountOAuth,
} from './accounts.js';
import { ProviderStorage } from './provider-storage.js';
import { closeDatabasePools, withRole } from './database.js';
import type { Transport } from '@lo/adapters';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  url = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_accounts_${Date.now()}`,
  admin = new Client({ connectionString: url });
let db: Client;
const prior = { ...process.env };
const scope = { authUserId: '00000000-0000-4000-8000-000000000001', missionId: '20000000-0000-4000-8000-000000000001' };
const transport: Transport = async () => ({
  status: 200,
  headers: {},
  body: { access_token: 'test-only-oauth-response', app_id: 'TEST_APP', scope: 'pay' },
});
const input = {
  provider: 'paypal',
  credential: {
    clientId: 'test-client',
    clientSecret: 'test-secret-never-in-public',
    merchantId: 'TEST_MERCHANT',
    webhookId: 'TEST_WEBHOOK',
    verifiedPayees: {},
  },
  founderAttestsOwnership: true,
  mode: 'local',
};
let accountId: string;
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${name}`);
  const local = new URL(url);
  local.pathname = `/${name}`;
  db = new Client({ connectionString: local.href });
  await db.connect();
  const bootstrap = (await readFile(`${root}/supabase/tests/bootstrap.sql`, 'utf8')).replace(
    'create role authenticated nologin noinherit nobypassrls;',
    () =>
      "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
  );
  await db.query(bootstrap);
  for (const f of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(`${root}/supabase/migrations/${f}`, 'utf8'));
  await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
  process.env['DATABASE_URL'] = local.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
  process.env['PROVIDER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
});
describe('FR-ACC-01/02/03 genuine scoped account provisioning', () => {
  it('commits founder account plus encrypted credential, returns only safe metadata', async () => {
    const r = await connectProviderAccount(scope, input, transport);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('Test account connection failed');
    accountId = r.value.accountId;
    expect(r.value).toMatchObject({
      provider: 'paypal',
      status: 'connected',
      sandboxMode: true,
      verification: { status: 'authenticated', ownership: 'founder_attested' },
    });
    expect(JSON.stringify(r)).not.toContain('test-secret');
    const raw = (await db.query('select encrypted from private.provider_credentials where account_id=$1', [accountId])).rows[0]?.encrypted;
    expect(JSON.stringify(raw)).not.toContain('test-secret');
    const list = await listProviderAccounts(scope);
    expect(list).toMatchObject({ ok: true, value: { accounts: [{ accountId }] } });
    expect(JSON.stringify(list)).not.toMatch(/ciphertext|credentialRef|test-secret/);
  });
  it('enforces explicit mode, founder attestation and server-owned identity with zero network calls', async () => {
    let calls = 0;
    const t: Transport = async r => {
      calls++;
      return transport(r);
    };
    for (const patch of [
      { mode: 'live' },
      { founderAttestsOwnership: false },
      { credential: { ...input.credential, missionId: randomUUID() } },
    ])
      expect((await connectProviderAccount(scope, { ...input, ...patch }, t)).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it('failed provider authentication creates no account, explicit restricted-key override remains unverified', async () => {
    const before = (await db.query('select count(*)::int n from public.founder_accounts')).rows[0]?.n;
    expect(
      (await connectProviderAccount(scope, input, async () => ({ status: 401, headers: {}, body: { error: 'test-secret' } }))).ok,
    ).toBe(false);
    expect((await db.query('select count(*)::int n from public.founder_accounts')).rows[0]?.n).toBe(before);
    const restricted = {
      provider: 'resend',
      credential: { apiKey: 'secret', from: 'test@example.test', allowedSandboxRecipients: [], testDomain: 'example.test' },
      mode: 'local',
      founderAttestsOwnership: true,
    };
    const t: Transport = async () => ({ status: 403, headers: {}, body: null });
    expect((await connectProviderAccount(scope, restricted, t)).ok).toBe(false);
    expect(await connectProviderAccount(scope, { ...restricted, allowUnverified: true }, t)).toMatchObject({
      ok: true,
      value: { verification: { status: 'unverified' } },
    });
  });
  it('cannot list, decrypt or revoke another mission account', async () => {
    const other = { ...scope, missionId: '20000000-0000-4000-8000-000000000002' };
    const list = await listProviderAccounts(other);
    expect(!list.ok || list.value.accounts.every(a => a.accountId !== accountId)).toBe(true);
    expect((await revokeProviderAccount(other, accountId)).ok).toBe(false);
    await expect(withRole('specialist_role', scope, d => d.query('select *from private.provider_credentials'))).rejects.toThrow();
  });
  it('account-bound selection rejects a different instrument, revocation is idempotent and stops step-time lookup', async () => {
    const storage = new ProviderStorage(scope),
      connection = await storage.connection('paypal', accountId);
    await expect(
      storage.resolve({
        missionId: scope.missionId,
        provider: 'paypal',
        sandboxMode: true,
        ref: connection.ref,
        instrumentId: randomUUID(),
      }),
    ).rejects.toThrow();
    const first = await revokeProviderAccount(scope, accountId);
    expect(first).toMatchObject({ ok: true, value: { accountId, status: 'revoked', externalAssetsRetained: true } });
    expect(await revokeProviderAccount(scope, accountId)).toEqual(first);
    await expect(
      storage.resolve({ missionId: scope.missionId, provider: 'paypal', sandboxMode: true, ref: connection.ref, instrumentId: accountId }),
    ).rejects.toThrow();
    const listed = await listProviderAccounts(scope);
    expect(listed.ok && listed.value.accounts.some(a => a.accountId === accountId && a.status === 'revoked')).toBe(true);
  });
  it('I-7 approving-decision expiry and typed proforma spec references fail closed without dependency edges', async () => {
    const packet = {
      question: 'Approve current artifact?',
      options: [{ id: 'a', label: 'Approve', evidenceIds: [], cost: null, timeDays: 0, consequences: 'Continue' }],
      recommendation: { optionId: 'a', reasons: ['Reviewed current content'] },
      staleImpact: [],
      defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
    };
    async function approved(outcome: 'product' | 'supply', content: Record<string, unknown>) {
      const created = await withRole('specialist_role', scope, async d => {
        const a = (await d.query("select public.create_artifact($1,'spec',$2,'Test current artifact')id", [scope.missionId, outcome]))
          .rows[0]?.id;
        const v = (await d.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, a, content])).rows[0]?.id;
        await d.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, v]);
        return { artifactId: String(a), versionId: String(v) };
      });
      const decisionId = await withRole('lead_role', scope, async d =>
        String(
          (
            await d.query("select public.propose_decision($1,'selection',$2,$3,'specification')id", [
              scope.missionId,
              { ...packet, approvedVersionIds: [created.versionId] },
              outcome,
            ])
          ).rows[0]?.id,
        ),
      );
      await withRole('founder_role', scope, async d => {
        await d.query("select public.resolve_decision($1,$2,'approve','a')", [scope.missionId, decisionId]);
        await d.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, created.versionId, decisionId]);
      });
      return { ...created, decisionId };
    }
    const spec = await approved('product', { dimensions: [1, 2, 3] }),
      proforma = await approved('supply', {
        proformaInvoice: { specVersionId: spec.versionId, amountMinor: 6000, currency: 'USD', incoterm: 'EXW' },
      }),
      storage = new ProviderStorage(scope);
    expect((await storage.artifact(proforma.versionId)).status).toBe('approved');
    await db.query('select private.check_version($1,$2)', [scope.missionId, proforma.versionId]);
    expect(
      (
        await db.query('select count(*)::int n from public.dependencies where upstream_id=$1 and dependent_id=$2', [
          spec.versionId,
          proforma.versionId,
        ])
      ).rows[0]?.n,
    ).toBe(0);
    await withRole('specialist_role', scope, async d => {
      await d.query('select public.append_artifact_version($1,$2,$3)', [scope.missionId, spec.artifactId, { dimensions: [9, 9, 9] }]);
    });
    expect((await storage.artifact(proforma.versionId)).status).toBe('superseded');
    await expect(db.query('select private.check_version($1,$2)', [scope.missionId, proforma.versionId])).rejects.toThrow(
      /artifact version stale/,
    );
    const active = await approved('product', { dimensions: [4, 5, 6] });
    await db.query('insert into public.stale_marks(mission_id,node_id,cause_id)values($1,$2,$3)', [
      scope.missionId,
      active.decisionId,
      active.versionId,
    ]);
    expect((await storage.artifact(active.versionId)).status).not.toBe('approved');
    await expect(db.query('select private.check_version($1,$2)', [scope.missionId, active.versionId])).rejects.toThrow(
      /stale or not approved/,
    );
  });
  it('Shopify OAuth binds authenticated founder/mission/shop and one-use state before encrypted token provisioning', async () => {
    const saved = { ...process.env };
    try {
      process.env['LO_EXECUTION_MODE'] = 'sandbox';
      process.env['APP_ORIGIN'] = 'https://operator.example';
      process.env['SUPABASE_URL'] = 'https://auth.example';
      process.env['SUPABASE_ANON_KEY'] = 'test-only';
      process.env['INNGEST_EVENT_KEY'] = 'test-only';
      process.env['INNGEST_SIGNING_KEY'] = 'test-only';
      delete process.env['LO_DEV_FOUNDER_ID'];
      delete process.env['LO_DEV_AUTH_TOKEN'];
      for (const key of [
        'DATABASE_FOUNDER_URL',
        'DATABASE_LEAD_URL',
        'DATABASE_SPECIALIST_URL',
        'DATABASE_POLICY_URL',
        'DATABASE_INGRESS_URL',
      ])
        process.env[key] = process.env['DATABASE_URL'];
      process.env['SHOPIFY_CLIENT_ID'] = 'test-client';
      process.env['SHOPIFY_CLIENT_SECRET'] = 'test-oauth-secret';
      process.env['SHOPIFY_OAUTH_SCOPES'] = 'read_products,write_products';
      process.env['SHOPIFY_API_VERSION'] = '2026-10';
      const started = await startShopifyAccountOAuth(scope, { shopDomain: 'founder.myshopify.com', founderAttestsOwnership: true });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error('OAuth start failed');
      const auth = new URL(started.value.authorizationUrl),
        callback = new URL(`/api/missions/${scope.missionId}/accounts/shopify/callback`, process.env['APP_ORIGIN']);
      callback.search = new URLSearchParams({
        shop: 'founder.myshopify.com',
        state: auth.searchParams.get('state') ?? '',
        code: 'one-use-code',
        timestamp: String(Math.floor(Date.now() / 1000)),
      }).toString();
      const signature = createHmac('sha256', 'test-oauth-secret')
        .update(
          [...callback.searchParams.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('&'),
        )
        .digest('hex');
      callback.searchParams.set('hmac', signature);
      let exchanges = 0;
      const t: Transport = async request => {
        if (request.url.endsWith('/oauth/access_token')) {
          exchanges++;
          return { status: 200, headers: {}, body: { access_token: 'SHOPIFY_TEST_TOKEN_SECRET', scope: 'read_products,write_products' } };
        }
        return {
          status: 200,
          headers: {},
          body: {
            data: {
              shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: 'founder.myshopify.com', plan: { partnerDevelopment: true } },
              currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'write_products' }] },
            },
          },
        };
      };
      const forged = new URL(callback);
      forged.searchParams.set('hmac', '0'.repeat(64));
      expect((await completeShopifyAccountOAuth(scope, forged, t)).ok).toBe(false);
      expect(exchanges).toBe(0);
      const connected = await completeShopifyAccountOAuth(scope, callback, t);
      expect(connected).toMatchObject({ ok: true, value: { provider: 'shopify', verification: { status: 'authenticated' } } });
      expect(JSON.stringify(connected)).not.toContain('SHOPIFY_TEST_TOKEN_SECRET');
      expect(connected.ok && connected.value.counterpartyId !== null).toBe(true);
      expect((await completeShopifyAccountOAuth(scope, callback, t)).ok).toBe(false);
      expect(exchanges).toBe(1);
    } finally {
      process.env = saved;
    }
  });
});
