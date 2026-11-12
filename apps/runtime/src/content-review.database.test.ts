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
  name = 'lo_claims_' + Date.now(),
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
describe('FR-CPL-05 deterministic approved checklist content screening', () => {
  it.each(['CURES DISEASE', 'cures <b>disease</b>', 'cur&#101;s disease', 'cures&#x20;disease', 'cures\u200Bdisease', 'عِلاج نهائي'])(
    'flags prohibited content including encoding and formatting: %s',
    async text => {
      const scope = await fixture(),
        f = await checklist(scope);
      const sample = text === 'cures\u200Bdisease' ? 'cures\u200B disease' : text;
      expect(await check(scope, f.version, sample)).toMatchObject({ clear: false, requiresDomainReview: true });
    },
  );
  it('combines current high-trust source evidence with checklist screening without upgrading claimed evidence', async () => {
    const scope = await fixture(),
      f = await checklist(scope);
    const claimed = await withRole('specialist_role', scope, async c =>
        String(
          (
            await c.query(
              "select public.append_evidence($1,'compliance','document','claimed','{}','document','Synthetic unverified claim source')id",
              [scope.missionId],
            )
          ).rows[0]?.id,
        ),
      ),
      confirmed = await withRole('founder_role', scope, async c =>
        String(
          (
            await c.query(
              'select public.append_evidence($1,\'compliance\',\'claim_check\',\'founder_confirmed\',\'{"claimText":"Floral notes","assessment":"supported","sourceExcerpt":"Synthetic reviewed specification lists floral fragrance notes."}\',\'document\',\'Synthetic founder-reviewed source\')id',
              [scope.missionId],
            )
          ).rows[0]?.id,
        ),
      );
    expect(
      await screenContentClaims(scope, {
        checklistVersionId: f.version,
        claims: [
          { text: 'Floral notes', evidenceIds: [claimed] },
          { text: 'Floral notes', evidenceIds: [confirmed] },
          { text: 'Cures disease', evidenceIds: [confirmed] },
        ],
      }),
    ).toMatchObject([{ supported: false }, { supported: true }, { supported: false, matches: ['cures disease'] }]);
    await withRole('founder_role', scope, c =>
      c.query(
        "select public.append_evidence($1,'compliance','document','founder_confirmed','{}','document','Synthetic source correction',null,$2)",
        [scope.missionId, confirmed],
      ),
    );
    expect(
      await screenContentClaims(scope, { checklistVersionId: f.version, claims: [{ text: 'Floral notes', evidenceIds: [confirmed] }] }),
    ).toMatchObject([{ supported: false }]);
  });
  it('accepts neutral copy without declaring legal certification and rejects unknown entity ambiguity', async () => {
    const scope = await fixture(),
      f = await checklist(scope);
    expect(await check(scope, f.version, 'A floral fragrance.')).toMatchObject({ clear: true, matches: [], requiresDomainReview: true });
    await expect(check(scope, f.version, 'cures&Tab;disease')).rejects.toThrow(/unsupported named/);
  });
  it('refuses foreign, unapproved and corrected checklists', async () => {
    const scope = await fixture(),
      f = await checklist(scope);
    await expect(check(await fixture(), f.version, 'Neutral')).rejects.toThrow(/current approved/);
    const draft = await artifact(scope, 'compliance_checklist', { prohibitedClaims: [] });
    await expect(check(scope, draft.version, 'Neutral')).rejects.toThrow(/current approved/);
    await withRole('specialist_role', scope, c =>
      c.query('select public.append_artifact_version($1,$2,$3)', [scope.missionId, f.artifact, { prohibitedClaims: ['new condition'] }]),
    );
    await expect(check(scope, f.version, 'Neutral')).rejects.toThrow(/current approved/);
  });
  it('blocks the actual effect reservation on prohibited copy even after founder approval', async () => {
    const scope = await fixture(),
      f = await checklist(scope),
      party = randomUUID(),
      account = randomUUID();
    await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'supplier','Synthetic store owner')", [
      party,
      founder,
    ]);
    await db.query(
      "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'shopify','connected','{write_products}')",
      [account, founder],
    );
    const content = {
      contentReview: { checklistVersionId: f.version },
      effectIntent: { action: 'store_configure', effectClass: 'communicate', counterpartyId: party, instrumentId: account },
      payload: {
        kind: 'product',
        title: 'Cures disease',
        descriptionHtml: 'Synthetic prohibited listing',
        vendor: 'Fixture',
        productType: 'Fixture',
      },
    };
    const v = await artifact(scope, 'note', content),
      decision = await approve(scope, v.version),
      token = randomUUID();
    await withRole('founder_role', scope, async c => {
      const issued = await new PostgresMissionRepository(c).issueApproval(
        String(scope.missionId),
        decision,
        { action: 'store_configure', counterpartyId: party, amountMinor: null, currency: null, artifactVersionId: v.version },
        token,
        new Date(Date.now() + 3600000).toISOString(),
      );
      if (!issued.ok) throw new Error('Expected fixture approval');
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
            artifactVersionId: v.version,
            idempotencyKey: randomUUID(),
            mode: 'do',
            sandboxMode: true,
            newContact: false,
          },
          createHash('sha256').update(token).digest('hex'),
        ]),
      ),
    ).rejects.toThrow(/prohibited claim/);
    expect((await db.query('select from public.effect_authorizations where mission_id=$1', [scope.missionId])).rowCount).toBe(0);
  });
});
