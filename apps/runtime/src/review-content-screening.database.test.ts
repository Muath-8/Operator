import { screenContentClaims } from './content-review.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { PostgresMissionRepository } from '@lo/state';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = 'lo_review_claims_' + Date.now(),
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
  await db.query('update private.platform_controls set effects_enabled=true');
  await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
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
  const scope = { authUserId: user, missionId: randomUUID() };
  await db.query(
    "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode)values($1,$2,'launch','Synthetic optional experiment test','SAR',true)",
    [scope.missionId, founder],
  );
  return scope;
}

async function artifact(scope: ActorScope, type: string, content: object) {
  return withRole('specialist_role', scope, async c => {
    const artifact = String(
        (await c.query("select public.create_artifact($1,$2,'compliance','Synthetic content gate')id", [scope.missionId, type])).rows[0]
          ?.id,
      ),
      version = String(
        (await c.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, artifact, content])).rows[0]?.id,
      );
    await c.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, version]);
    return { artifact, version };
  });
}
async function approve(scope: ActorScope, version: string) {
  const packet = {
    question: 'Approve exact synthetic copy?',
    options: [
      {
        id: 'yes',
        label: 'Approve',
        artifactVersionIds: [version],
        evidenceIds: [],
        cost: null,
        timeDays: 0,
        consequences: 'Synthetic test only',
      },
    ],
    approvedVersionIds: [version],
    recommendation: { optionId: 'yes', reasons: ['Native gate test'] },
    staleImpact: [],
    defaultIfNoAnswer: { optionId: 'yes', at: null, binding: true },
  };
  const id = await withRole('lead_role', scope, async c =>
    String(
      (await c.query("select public.propose_decision($1,'engagement',$2,'commerce','publication')id", [scope.missionId, packet])).rows[0]
        ?.id,
    ),
  );
  await withRole('founder_role', scope, async c => {
    await c.query("select public.resolve_decision($1,$2,'approve','yes')", [scope.missionId, id]);
    await c.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, version, id]);
  });
  return id;
}
async function checklist(scope: ActorScope) {
  const f = await artifact(scope, 'compliance_checklist', {
    prohibitedClaims: ['cures disease', 'علاج نهائي'],
    reviewStatus: 'unverified',
    items: [],
  });
  await approve(scope, f.version);
  return f;
}
const check = (scope: ActorScope, id: string, text: string) =>
  withRole(
    'specialist_role',
    scope,
    async c => (await c.query('select public.check_content_claims($1,$2,$3)result', [scope.missionId, id, text])).rows[0]?.result,
  );

describe('independent publication text and checklist boundaries', () => {
  it.each([
    'cur&#X65;s disease',
    'cur&#101s disease',
    '&#xff43;&#xff55;&#xff52;&#xff45;&#xff53; disease',
    'cur\u2060es disease',
    'cu\u00adres disease',
    'cures<script>hidden()</script> disease',
    'cures<span hidden>unseen padding</span> disease',
    'cures<span style="display:none">unseen padding</span> disease',
  ])('never clears a visually prohibited encoded claim: %s', async text => {
    const scope = await fixture(),
      list = await checklist(scope);
    let clear = false;
    try {
      clear = (await check(scope, list.version, text)).clear;
    } catch (error) {
      expect(String(error)).toMatch(/validation|rejected|approval/);
      return;
    }
    expect(clear).toBe(false);
  });
  it('does not use arbitrary current high-trust evidence to support unrelated claim content', async () => {
    const scope = await fixture(),
      list = await checklist(scope),
      source = await withRole('founder_role', scope, async c =>
        String(
          (
            await c.query(
              "select public.append_evidence($1,'compliance','document','founder_confirmed',$2,'document','Synthetic ownership source')id",
              [scope.missionId, { statement: 'This account belongs to the founder.' }],
            )
          ).rows[0]?.id,
        ),
      );
    const result = await screenContentClaims(scope, {
      checklistVersionId: list.version,
      claims: [{ text: 'Clinical testing established 99 percent efficacy', evidenceIds: [source] }],
    });
    expect(result[0]?.supported).toBe(false);
  });
  it('binds support to an exact current claim-specific attestation without turning it into legal certification', async () => {
    const scope = await fixture(),
      list = await checklist(scope),
      text = 'Floral notes',
      payload = { claimText: text, assessment: 'supported', sourceExcerpt: 'Explicit synthetic reviewed excerpt' };
    const source = await withRole('founder_role', scope, async c =>
      String(
        (
          await c.query(
            "select public.append_evidence($1,'compliance','claim_check','founder_confirmed',$2,'document','Synthetic claim attestation')id",
            [scope.missionId, payload],
          )
        ).rows[0]?.id,
      ),
    );
    expect(
      await screenContentClaims(scope, {
        checklistVersionId: list.version,
        claims: [
          { text, evidenceIds: [source] },
          { text: 'A different claim', evidenceIds: [source] },
        ],
      }),
    ).toMatchObject([{ supported: true, requiresDomainReview: true }, { supported: false }]);
    await withRole('founder_role', scope, c =>
      c.query(
        "select public.append_evidence($1,'compliance','claim_check','founder_confirmed',$2,'document','Synthetic corrected attestation',null,$3)",
        [scope.missionId, { ...payload, assessment: 'unsupported' }, source],
      ),
    );
    expect(await screenContentClaims(scope, { checklistVersionId: list.version, claims: [{ text, evidenceIds: [source] }] })).toMatchObject(
      [{ supported: false }],
    );
  });
  it('rejects the actual publication authorization when a prohibited phrase is encoded with uppercase hex', async () => {
    const scope = await fixture(),
      list = await checklist(scope),
      party = randomUUID(),
      account = randomUUID();
    await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'service','Synthetic reviewed store')", [
      party,
      founder,
    ]);
    await db.query(
      "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'shopify','connected','{write_products}')",
      [account, founder],
    );
    const output = await artifact(scope, 'note', {
        contentReview: { checklistVersionId: list.version },
        effectIntent: { action: 'store_configure', effectClass: 'communicate', counterpartyId: party, instrumentId: account },
        payload: {
          kind: 'product',
          title: 'cur&#X65;s disease',
          descriptionHtml: 'Synthetic encoded listing',
          vendor: 'Fixture',
          productType: 'Fixture',
        },
      }),
      decision = await approve(scope, output.version),
      token = randomUUID();
    await withRole('founder_role', scope, async c => {
      const issued = await new PostgresMissionRepository(c).issueApproval(
        String(scope.missionId),
        decision,
        { action: 'store_configure', counterpartyId: party, amountMinor: null, currency: null, artifactVersionId: output.version },
        token,
        new Date(Date.now() + 3600000).toISOString(),
      );
      if (!issued.ok) throw new Error('Expected explicit synthetic approval');
    });
    await expect(
      withRole('policy_role', scope, c =>
        c.query('select public.reserve_effect($1,$2,$3)', [
          scope.missionId,
          {
            missionId: scope.missionId,
            taskId: randomUUID(),
            action: 'store_configure',
            effectClass: 'communicate',
            counterpartyId: party,
            instrumentId: account,
            artifactVersionId: output.version,
            idempotencyKey: randomUUID(),
            mode: 'do',
            sandboxMode: true,
            newContact: false,
          },
          createHash('sha256').update(token).digest('hex'),
        ]),
      ),
    ).rejects.toThrow(/prohibited|validation|rejected/);
  });
  it.each(['vendor', 'productType'])('screens public product field %s as well as title and description', async field => {
    const scope = await fixture(),
      list = await checklist(scope),
      party = randomUUID(),
      account = randomUUID();
    await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'service','Synthetic public field store')", [
      party,
      founder,
    ]);
    await db.query(
      "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'shopify','connected','{write_products}')",
      [account, founder],
    );
    const output = await artifact(scope, 'note', {
        contentReview: { checklistVersionId: list.version },
        effectIntent: { action: 'store_configure', effectClass: 'communicate', counterpartyId: party, instrumentId: account },
        payload: {
          kind: 'product',
          title: 'Neutral fragrance',
          descriptionHtml: 'Neutral description',
          vendor: 'Neutral vendor',
          productType: 'Neutral category',
          [field]: 'Cures disease',
        },
      }),
      decision = await approve(scope, output.version),
      token = randomUUID();
    await withRole('founder_role', scope, async c => {
      const issued = await new PostgresMissionRepository(c).issueApproval(
        String(scope.missionId),
        decision,
        { action: 'store_configure', counterpartyId: party, amountMinor: null, currency: null, artifactVersionId: output.version },
        token,
        new Date(Date.now() + 3600000).toISOString(),
      );
      if (!issued.ok) throw new Error('Expected explicit synthetic field approval');
    });
    await expect(
      withRole('policy_role', scope, c =>
        c.query('select public.reserve_effect($1,$2,$3)', [
          scope.missionId,
          {
            missionId: scope.missionId,
            taskId: randomUUID(),
            action: 'store_configure',
            effectClass: 'communicate',
            counterpartyId: party,
            instrumentId: account,
            artifactVersionId: output.version,
            idempotencyKey: randomUUID(),
            mode: 'do',
            sandboxMode: true,
            newContact: false,
          },
          createHash('sha256').update(token).digest('hex'),
        ]),
      ),
    ).rejects.toThrow(/prohibited|rejected/);
  });
});
