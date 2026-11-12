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
import { prepareDomainRegistration, executeApprovedDomainRegistration, reconcileDomainRegistrations } from './registrar.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_review_registrar_${Date.now()}`,
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
describe('independent registrar original-consent recovery', () => {
  it('files an original pending registration after another same-version approval without changing its actual consent time', async () => {
    const f = await fixture({ pending: true });
    await approve(f);
    expect((await executeApprovedDomainRegistration(f.scope, f.proposal.artifactVersionId, f.taskId, f.transport)).ok).toBe(false);
    expect(f.registrationPosts()).toBe(1);
    const packet = {
        question: f.proposal.decisionQuestion,
        options: [
          {
            id: 'a',
            label: 'Review the same frozen registration again',
            artifactVersionIds: [f.proposal.artifactVersionId],
            evidenceIds: [],
            cost: { amountMinor: 1500, currency: 'USD' },
            timeDays: 0,
            consequences: 'Synthetic reapproval; original remote operation remains pending',
          },
        ],
        approvedVersionIds: [f.proposal.artifactVersionId],
        recommendation: { optionId: 'a', reasons: ['Independent consent-recovery probe'] },
        staleImpact: [],
        defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
      },
      decision = await withRole('lead_role', f.scope, async c =>
        z
          .uuid()
          .parse(
            (
              await c.query("select public.propose_decision($1,'engagement',$2,'brand','domain_registration')id", [
                f.scope.missionId,
                packet,
              ])
            ).rows[0]?.id,
          ),
      );
    await withRole('founder_role', f.scope, c =>
      c.query("select public.resolve_decision($1,$2,'approve','a')", [f.scope.missionId, decision]),
    );
    const token = randomBytes(32).toString('hex'),
      approval = await withRole('founder_role', f.scope, c =>
        new PostgresMissionRepository(c).issueApproval(
          z.uuid().parse(f.scope.missionId),
          decision,
          {
            action: 'registration',
            counterpartyId: f.counterpartyId,
            amountMinor: 1500,
            currency: 'USD',
            artifactVersionId: f.proposal.artifactVersionId,
          },
          token,
          new Date(Date.now() + 3600000).toISOString(),
        ),
      );
    if (!approval.ok) throw new Error('Expected actual new synthetic approval');
    await storeApprovalToken(f.scope, approval.value, token);
    f.complete();
    expect(await reconcileDomainRegistrations(f.scope, f.transport)).toMatchObject({ filed: 1, unresolved: 0 });
    expect(f.registrationPosts()).toBe(1);
  });
});
