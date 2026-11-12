import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PostgresMissionRepository } from '@lo/state';
import type { Transport, HttpRequest } from '@lo/adapters';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { connectProviderAccount } from './accounts.js';
import { storeApprovalToken } from './provider-storage.js';
import {
  prepareDomainRegistration,
  executeApprovedDomainRegistration,
  reconcileDomainRegistrations,
  prepareFounderOwnershipKit,
  confirmFounderOwnership,
} from './registrar.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_registrar_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  user = randomUUID(),
  founder = randomUUID(),
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
  const migrations = (await readdir(`${root}/supabase/migrations`))
    .filter(f => f.endsWith('.sql') || f === '202611120043_registrar.sql.tmp')
    .sort();
  for (const f of migrations) await db.query(await readFile(`${root}/supabase/migrations/${f}`, 'utf8'));
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
  await db.query('update private.platform_controls set effects_enabled=true');
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
  process.env['PROVIDER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name}with(force)`);
  await admin.end();
});
async function fixture(options: { pending?: boolean; timeout?: boolean; budget?: number; quoteTtl?: number } = {}) {
  const scope: ActorScope = { authUserId: user, missionId: randomUUID() },
    principal = randomUUID(),
    registrationId = randomUUID(),
    operationId = randomUUID(),
    domain = `synthetic-${randomUUID()}.example`,
    requests: HttpRequest[] = [],
    fees = [{ type: 'ONE_TIME_PREMIUM_DOMAIN_PURCHASE', fee: { currencyCode: 'USD', value: 301 } }];
  let pending = options.pending ?? false,
    agreedAt = '';
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode,involvement,metadata)values($1,$2,'launch','Explicit synthetic registrar boundary test','USD',true,'do',$3)",
    [scope.missionId, founder, { budgetMinor: options.budget ?? 100000 }],
  );
  const transport: Transport = async request => {
    requests.push(request);
    expect(request.url.startsWith('https://api.ote-godaddy.com/v3/domains/')).toBe(true);
    if (request.url.includes('check-availability?domain=example.com'))
      return { status: 200, headers: {}, body: { domain: 'example.com', available: false } };
    if (request.url.includes('/check-availability')) return { status: 200, headers: {}, body: { domain, available: true } };
    if (request.url.endsWith('/registration-quotes'))
      return {
        status: 200,
        headers: {},
        body: {
          quoteToken: 'explicit-synthetic-private-quote-token',
          expiresAt: new Date(Date.now() + (options.quoteTtl ?? 600000)).toISOString(),
          items: [{ domain, period: 1, price: { currencyCode: 'USD', value: 1199 }, fees }],
          requiredAgreements: [
            {
              agreementType: 'API_DPA',
              title: 'Synthetic required registration agreement',
              url: 'https://www.godaddy.com/agreements/showdoc?pageid=reg_sa',
            },
          ],
        },
      };
    if (request.url.endsWith('/registrations')) {
      if (options.timeout) throw new Error('Synthetic provider timeout after POST');
      const input = z
        .object({ consent: z.object({ agreedAt: z.iso.datetime() }) })
        .passthrough()
        .parse(JSON.parse(String(request.body)));
      agreedAt = input.consent.agreedAt;
      return { status: 202, headers: {}, body: { registrationId, operationId, status: 'CONFIRMED' } };
    }
    return {
      status: 200,
      headers: {},
      body: {
        registrationId,
        operationId,
        domain,
        period: 1,
        price: { currencyCode: 'USD', value: 1199 },
        fees,
        status: pending ? 'EXECUTING' : 'COMPLETED',
        expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
        consent: { agreementTypes: ['API_DPA'], agreedAt, acknowledgedFees: fees, agreedBy: { principal } },
      },
    };
  };
  const connection = await connectProviderAccount(
    scope,
    {
      provider: 'godaddy',
      mode: 'local',
      founderAttestsOwnership: true,
      credential: {
        pat: 'explicit-synthetic-registrar-pat',
        accountPrincipalId: principal,
        registrantProfileConfirmed: true,
        billingProfileConfirmed: true,
      },
    },
    transport,
  );
  if (!connection.ok) throw new Error(`Synthetic registrar connection failed:${connection.error.code}`);
  const accountId = connection.value.accountId,
    counterpartyId = z.uuid().parse(connection.value.counterpartyId),
    taskId = randomUUID(),
    prepared = await prepareDomainRegistration(scope, { accountId, counterpartyId, domain, period: 1 }, taskId, transport);
  if (!prepared.ok)
    throw new Error(
      `Synthetic registrar quote failed:${prepared.error.code}:${prepared.error.message}:${requests.map(r => new URL(r.url).pathname).join(',')}`,
    );
  const proposal = z.object({ artifactVersionId: z.uuid(), decisionQuestion: z.string() }).passthrough().parse(prepared.value);
  return {
    scope,
    accountId,
    counterpartyId,
    domain,
    taskId,
    proposal,
    requests,
    transport,
    complete: () => {
      pending = false;
    },
    registrationPosts: () => requests.filter(r => r.method === 'POST' && r.url.endsWith('/registrations')).length,
  };
}
async function approve(f: Awaited<ReturnType<typeof fixture>>, wrongQuestion = false, issue = true) {
  const version = f.proposal.artifactVersionId,
    packet = {
      question: wrongQuestion ? 'Approve another unrelated brand choice' : f.proposal.decisionQuestion,
      options: [
        {
          id: 'a',
          label: 'Accept exact domain, term, all fees and linked legal agreements',
          artifactVersionIds: [version],
          evidenceIds: [],
          cost: { amountMinor: 1500, currency: 'USD' },
          timeDays: 0,
          consequences: 'Irreversible synthetic registration charge only; no live provider contacted',
        },
      ],
      approvedVersionIds: [version],
      recommendation: { optionId: 'a', reasons: ['Synthetic actual-boundary test'] },
      staleImpact: [],
      defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
    },
    decision = await withRole('lead_role', f.scope, async c =>
      z
        .uuid()
        .parse(
          (await c.query("select public.propose_decision($1,'engagement',$2,'brand','domain_registration')id", [f.scope.missionId, packet]))
            .rows[0]?.id,
        ),
    );
  await withRole('founder_role', f.scope, async c => {
    await c.query("select public.resolve_decision($1,$2,'approve','a')", [f.scope.missionId, decision]);
    await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [f.scope.missionId, version, decision]);
  });
  if (issue) {
    const token = randomBytes(32).toString('hex'),
      approval = await withRole('founder_role', f.scope, async c =>
        new PostgresMissionRepository(c).issueApproval(
          z.uuid().parse(f.scope.missionId),
          decision,
          { action: 'registration', counterpartyId: f.counterpartyId, amountMinor: 1500, currency: 'USD', artifactVersionId: version },
          token,
          new Date(Date.now() + 3600000).toISOString(),
        ),
      );
    if (!approval.ok) throw new Error('Synthetic domain approval failed');
    await storeApprovalToken(f.scope, approval.value, token);
  }
  return decision;
}
describe('FR-BRD05 FR-ACC01/02 registrar native scope, money and receipt recovery', () => {
  it('erases scoped registrar vault and acknowledgement rows while retaining the founder external account', async () => {
    const f = await fixture();
    await approve(f);
    expect((await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport)).ok).toBe(true);
    await withRole('founder_role', f.scope, async c => {
      const request = z.uuid().parse((await c.query('select public.request_mission_deletion($1)id', [f.scope.missionId])).rows[0]?.id);
      await c.query('select public.erase_mission($1,$2)', [f.scope.missionId, request]);
    });
    for (const table of ['registrar_quote_tokens', 'registrar_acknowledgements'])
      expect((await db.query(`select count(*)::int n from private.${table} where mission_id=$1`, [f.scope.missionId])).rows[0]?.n).toBe(0);
    expect((await db.query('select count(*)::int n from public.founder_accounts where id=$1', [f.accountId])).rows[0]?.n).toBe(1);
  });
  it('stores the quote token encrypted, uses actual founder resolution time, files one verified completed domain and spent row', async () => {
    const f = await fixture();
    await approve(f);
    const result = await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport);
    if (!result.ok) throw new Error(result.error.message + ' HTTP:' + f.requests.map(r => r.method + new URL(r.url).pathname).join(','));
    expect(result).toMatchObject({ ok: true, value: { status: 'registered_verified', domain: f.domain } });
    expect(f.registrationPosts()).toBe(1);
    expect((await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport)).ok).toBe(true);
    expect(f.registrationPosts()).toBe(1);
    const rows = (
      await db.query("select kind,amount_minor::text from public.money_ledger where mission_id=$1 and kind='spent'", [f.scope.missionId])
    ).rows;
    expect(rows).toEqual([{ kind: 'spent', amount_minor: '1500' }]);
    expect(
      (await db.query("select trust from public.evidence where mission_id=$1 and kind='founder_owned_domain'", [f.scope.missionId])).rows,
    ).toEqual([{ trust: 'verified' }]);
    expect(
      JSON.stringify((await db.query('select quote from public.registrar_quotes where mission_id=$1', [f.scope.missionId])).rows),
    ).not.toContain('explicit-synthetic-private-quote-token');
    const consent = z
      .object({ consent: z.object({ agreedAt: z.string() }) })
      .passthrough()
      .parse(JSON.parse(String(f.requests.find(r => r.url.endsWith('/registrations'))?.body)));
    const resolved = (await db.query('select created_at from public.decision_resolutions where mission_id=$1', [f.scope.missionId])).rows[0]
      ?.created_at;
    expect(Date.parse(consent.consent.agreedAt)).toBe(
      resolved instanceof Date ? resolved.getTime() : Date.parse(z.string().parse(resolved)),
    );
  });
  it('holds pending operations and reconciles the original acknowledgement with GET only', async () => {
    const f = await fixture({ pending: true });
    await approve(f);
    expect((await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport)).ok).toBe(false);
    expect(
      (await db.query('select count(*)::int n from public.domain_registrations where mission_id=$1', [f.scope.missionId])).rows[0]?.n,
    ).toBe(0);
    f.complete();
    expect(await reconcileDomainRegistrations(f.scope, f.transport)).toMatchObject({ filed: 1, unresolved: 0 });
    expect(f.registrationPosts()).toBe(1);
  });
  it('a missing POST acknowledgement stays unresolved and never blindly resubmits', async () => {
    const f = await fixture({ timeout: true });
    await approve(f);
    expect((await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport)).ok).toBe(false);
    expect((await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport)).ok).toBe(false);
    expect(await reconcileDomainRegistrations(f.scope, f.transport)).toMatchObject({ filed: 0, unresolved: 1 });
    expect(f.registrationPosts()).toBe(1);
  });
  it('committed pause, revoked account and insufficient budget each block before registration POST', async () => {
    for (const cause of ['pause', 'revoke', 'budget']) {
      const f = await fixture({ budget: cause === 'budget' ? 100 : 100000 });
      await approve(f);
      if (cause === 'pause')
        await withRole('founder_role', f.scope, c => c.query("select public.transition_mission($1,'paused')", [f.scope.missionId]));
      if (cause === 'revoke')
        await db.query('insert into public.account_revocations(account_id,founder_id)values($1,$2)', [f.accountId, founder]);
      expect((await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport)).ok).toBe(false);
      expect(f.registrationPosts()).toBe(0);
    }
  });
  it('an unrelated approval question cannot provide legal consent, and foreign tenant/role cannot obtain the private quote', async () => {
    const f = await fixture();
    await approve(f, true, false);
    expect((await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport)).ok).toBe(false);
    expect(f.registrationPosts()).toBe(0);
    await expect(
      withRole('policy_role', { authUserId: randomUUID(), missionId: f.scope.missionId }, c =>
        c.query('select public.registrar_execution_context($1,$2,true)', [f.scope.missionId, f.proposal.artifactVersionId]),
      ),
    ).rejects.toThrow(/mission denied/);
    await expect(
      withRole('specialist_role', f.scope, c =>
        c.query('select public.registrar_execution_context($1,$2,true)', [f.scope.missionId, f.proposal.artifactVersionId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it('a receipt-write crash after remote acceptance recovers the durable operation without a second POST', async () => {
    const f = await fixture();
    await approve(f);
    await db.query(
      "create function private.synthetic_registrar_receipt_fault()returns trigger language plpgsql as $$begin if new.provider='godaddy'then raise exception 'explicit synthetic receipt-write fault';end if;return new;end$$;create trigger synthetic_registrar_receipt_fault before insert on public.provider_receipts for each row execute function private.synthetic_registrar_receipt_fault()",
    );
    try {
      expect((await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport)).ok).toBe(false);
    } finally {
      await db.query(
        'drop trigger synthetic_registrar_receipt_fault on public.provider_receipts;drop function private.synthetic_registrar_receipt_fault()',
      );
    }
    expect(f.registrationPosts()).toBe(1);
    expect(await reconcileDomainRegistrations(f.scope, f.transport)).toMatchObject({ filed: 1, unresolved: 0 });
    expect(f.registrationPosts()).toBe(1);
  });
  it('expires an approved quote without refreshing it or executing a purchase', async () => {
    const f = await fixture({ quoteTtl: 2000 });
    await approve(f);
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect((await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport)).ok).toBe(false);
    expect(f.registrationPosts()).toBe(0);
    expect(f.requests.filter(r => r.url.endsWith('registration-quotes'))).toHaveLength(1);
  });
  it('manual domain/handle ownership requires reviewed ownership documents; availability alone is rejected', async () => {
    const f = await fixture();
    expect(await prepareFounderOwnershipKit(f.scope, { kind: 'domain', accountId: f.accountId, resource: f.domain })).toMatchObject({
      ok: true,
      value: { status: 'awaiting_ownership_source', mode: 'C' },
    });
    for (const kind of ['name_availability', 'domain_ownership_document', 'handle_ownership_document']) {
      const resource = kind === 'handle_ownership_document' ? 'instagram:explicit-test-handle' : f.domain,
        evidenceId = await withRole('specialist_role', f.scope, async c =>
          z
            .uuid()
            .parse(
              (
                await c.query(
                  "select public.append_evidence($1,'brand',$2,'claimed',$3,'document','synthetic-upload:reviewed-ownership-document')id",
                  [f.scope.missionId, kind, { accountId: f.accountId, resource, synthetic: true }],
                )
              ).rows[0]?.id,
            ),
        ),
        kit = await prepareFounderOwnershipKit(f.scope, {
          kind: kind === 'handle_ownership_document' ? 'handles' : 'domain',
          accountId: f.accountId,
          resource,
          sourceEvidenceIds: [evidenceId],
        });
      if (!kit.ok) throw new Error('Missing manual ownership kit');
      const source = z.object({ artifactVersionId: z.uuid(), decisionQuestion: z.string() }).passthrough().parse(kit.value),
        packet = {
          question: source.decisionQuestion,
          options: [
            {
              id: 'a',
              label: 'Confirm ownership after reviewing exact source',
              artifactVersionIds: [source.artifactVersionId],
              evidenceIds: [evidenceId],
              cost: null,
              timeDays: 0,
              consequences: 'Founder-confirmed ownership; no provider purchase or payment is inferred',
            },
          ],
          approvedVersionIds: [source.artifactVersionId],
          recommendation: { optionId: 'a', reasons: ['Synthetic manual ownership boundary'] },
          staleImpact: [],
          defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
        },
        decision = await withRole('lead_role', f.scope, async c =>
          z
            .uuid()
            .parse(
              (
                await c.query("select public.propose_decision($1,'engagement',$2,'brand','account_ownership')id", [
                  f.scope.missionId,
                  packet,
                ])
              ).rows[0]?.id,
            ),
        );
      await withRole('founder_role', f.scope, async c => {
        await c.query("select public.resolve_decision($1,$2,'approve','a')", [f.scope.missionId, decision]);
        await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [f.scope.missionId, source.artifactVersionId, decision]);
      });
      const confirmed = await confirmFounderOwnership(f.scope, decision, source.artifactVersionId);
      expect(confirmed.ok).toBe(kind !== 'name_availability');
    }
    expect(
      (
        await db.query(
          "select trust from public.evidence where mission_id=$1 and kind in('founder_owned_domain','founder_owned_handles')",
          [f.scope.missionId],
        )
      ).rows,
    ).toEqual([{ trust: 'founder_confirmed' }, { trust: 'founder_confirmed' }]);
    expect(f.registrationPosts()).toBe(0);
  });
});
