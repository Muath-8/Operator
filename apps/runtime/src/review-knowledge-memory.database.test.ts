import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';
import { loadKnowledge, taskKnowledge } from './knowledge.js';
import { TaskBriefSchema } from './contracts.js';
import { createModelMeter } from './model-meter.js';
import { persistEditableSources, assertAssetReferences } from './editable-assets.js';
vi.mock('../../web/src/lib/auth', () => ({
  currentActor: vi.fn(async () => ({ authUserId: '00000000-0000-4000-8000-000000000001', local: true })),
}));
import { GET as downloadAsset } from '../../web/src/app/api/missions/[missionId]/assets/[assetId]/route';
const root = fileURLToPath(new URL('../../../', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  database = `lo_review_memory_${Date.now()}`;
const admin = new Client({ connectionString: adminUrl });
let db: Client;
const prior = { ...process.env };
const actor = '00000000-0000-4000-8000-000000000001',
  missionId = '20000000-0000-4000-8000-000000000001',
  scope = { authUserId: actor, missionId };
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${database}`);
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
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
  await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
  // Enables only this disposable database's synthetic model-budget tests. No provider is called.
  await db.query('update private.platform_controls set effects_enabled=true where singleton');
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${database} with(force)`);
  await admin.end();
});
const question = (key: string, level = 'mission') =>
  withRole(
    'lead_role',
    scope,
    async client =>
      (
        await client.query(
          "select public.propose_mission_question($1,$2,$3,'What should I record?','Recommended explicit default',false,'brand') id",
          [missionId, key, level],
        )
      ).rows[0]?.id as string | null,
  );
describe('independent real knowledge26/memory30 review (FR-STATE-09 FR-PLY-01 FR-EASE-02/03/12 I-12)', () => {
  it('loads actual pinned profile/playbook data and exposes unknown-category unverified research', async () => {
    const known = await withRole('lead_role', scope, client =>
      loadKnowledge(client, { categoryProfileId: 'perfume', categoryProfileVersion: 2 }),
    );
    expect(known.profile.version).toBe(2);
    expect(known.playbooks.some(p => p.id === 'sourcing' && p.version === 2)).toBe(true);
    expect(known.profile.review_status).toBe('unverified');
    const unknown = await withRole('lead_role', scope, client => loadKnowledge(client, { categoryProfileId: 'new-independent-category' }));
    expect(unknown).toMatchObject({ requestedCategory: 'new-independent-category', unknownCategory: true });
    expect(unknown.profile.id).toBe('generic');
    expect(unknown.warning).toContain('unverified');
  });
  it('refuses a task that borrows a valid playbook step with a different source', async () => {
    const task = TaskBriefSchema.parse({
      id: randomUUID(),
      missionId,
      role: 'sourcing',
      outcome: 'supply',
      objective: 'Review sourced work',
      constraints: [],
      budgetAuthority: [],
      deadline: new Date(Date.now() + 100000).toISOString(),
      doneCriteria: ['Review'],
      evidenceRequired: ['Source'],
      playbook: { id: 'sourcing', version: 2, step: 'compare', source: 'https://unrelated.example.test' },
      maxToolCalls: 1,
      maxTokens: 2000,
      tier: 'mid',
      requestedByFounder: true,
      overdueExposure: false,
      unblocks: [],
      parentRunId: null,
    });
    await expect(withRole('lead_role', scope, client => taskKnowledge(client, task))).rejects.toThrow('exact sourced');
  });
  it('known metadata facts cannot be re-asked and an answer/default becomes durable fact memory', async () => {
    expect(await question('budgetMinor')).toBeNull();
    const id = await question('reviewNewFact');
    expect(id).toBeTruthy();
    await withRole('founder_role', scope, client =>
      client.query('select public.answer_mission_question($1,$2,$3,true)', [missionId, id, '']),
    );
    const value = await withRole(
      'lead_role',
      scope,
      async client => (await client.query('select public.conversation_facts($1) value', [missionId])).rows[0]?.value,
    );
    expect(value.reviewNewFact).toBe('Recommended explicit default');
    expect(await question('reviewNewFact')).toBeNull();
  });
  it('a budget alias cannot bypass the known-budget rule', async () => {
    expect(await question('budget')).toBeNull();
  });
  it('cannot promote mission-specific budget facts to founder-wide reuse', async () => {
    await expect(question('reviewBudget', 'founder')).rejects.toThrow('mission-specific');
  });
  it('the first glossary use is durable and definitions are added once only', async () => {
    const thread = String(
      (await db.query('select id from public.threads where mission_id=$1 and counterparty_id is null limit 1', [missionId])).rows[0]?.id,
    );
    const post = () =>
      withRole('lead_role', scope, async client =>
        String(
          (await client.query("select public.append_lead_message($1,$2,'The MOQ is not yet confirmed.') id", [missionId, thread])).rows[0]
            ?.id,
        ),
      );
    const first = await post(),
      second = await post();
    const messages = await db.query('select id,original from public.messages where id=any($1::uuid[])', [[first, second]]);
    expect(messages.rows.find(r => r.id === first)?.original).toContain('smallest quantity');
    expect(messages.rows.find(r => r.id === second)?.original).not.toContain('smallest quantity');
    expect(
      (await db.query("select count(*)::integer n from public.glossary_first_uses where mission_id=$1 and term_id='moq'", [missionId]))
        .rows[0]?.n,
    ).toBe(1);
  });
  it('a foreign founder cannot fetch facts or create questions for this mission', async () => {
    await expect(
      withRole('lead_role', { authUserId: randomUUID(), missionId }, client =>
        client.query('select public.conversation_facts($1)', [missionId]),
      ),
    ).rejects.toThrow('mission denied');
  });
  it('aggregate token reservations serialize outer and nested attempts under the same run ceiling', async () => {
    const run = randomUUID(),
      keys = [`outer:${randomUUID()}`, `nested:${randomUUID()}`];
    await db.query(
      "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier)values($1,$2,'sourcing','{\"maxTokens\":1000}','review aggregate fixture','mid')",
      [run, missionId],
    );
    process.env['MODEL_PRICE_RATES_JSON'] = JSON.stringify({
      'review-budget-model': {
        inputPerMillion: 2,
        cachedInputPerMillion: 0.5,
        outputPerMillion: 8,
        source: 'https://example.test/review-pricing',
        observedAt: new Date().toISOString(),
      },
    });
    process.env['MODEL_FOUNDER_DAILY_CAP_MICRO_USD'] = '100000000';
    const meter = createModelMeter(scope, run, 'review-budget-model'),
      results = await Promise.allSettled(keys.map(key => meter.reserve(key, 600)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await db.query('select count(*)::integer n from public.model_token_reservations where run_id=$1', [run])).rows[0]?.n).toBe(1);
    const key = keys[results.findIndex(r => r.status === 'fulfilled')];
    if (!key) throw new Error('Expected exactly one reserved model-call key');
    await meter.record({ callKey: key, inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, totalTokens: 20 });
    await expect(meter.reserve(`after-complete:${randomUUID()}`, 900)).resolves.toBeUndefined();
    await expect(meter.reserve(`over-remaining:${randomUUID()}`, 100)).rejects.toThrow('aggregate');
  });
  it('a failed money reservation rolls back its token reservation in the same transaction', async () => {
    const run = randomUUID(),
      key = randomUUID();
    await db.query(
      "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier)values($1,$2,'sourcing','{\"maxTokens\":1000}','review rollback fixture','mid')",
      [run, missionId],
    );
    process.env['MODEL_FOUNDER_DAILY_CAP_MICRO_USD'] = '1';
    const meter = createModelMeter(scope, run, 'review-budget-model');
    await expect(meter.reserve(key, 100)).rejects.toThrow('daily model budget');
    expect((await db.query('select count(*)::integer n from public.model_token_reservations where run_id=$1', [run])).rows[0]?.n).toBe(0);
  });
  it('usage cannot borrow a reserved call key from another run to release its token ceiling', async () => {
    const first = randomUUID(),
      second = randomUUID(),
      key = randomUUID();
    for (const run of [first, second])
      await db.query(
        "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier)values($1,$2,'sourcing','{\"maxTokens\":1000}','review crossrun fixture','mid')",
        [run, missionId],
      );
    await withRole('policy_role', scope, async client => {
      await client.query('select public.reserve_run_tokens($1,$2,$3,900)', [missionId, first, key]);
      await client.query('select public.reserve_model_budget($1,$2,$3,100,100000000)', [missionId, first, key]);
    });
    await expect(
      withRole('policy_role', scope, client =>
        client.query('select public.record_model_usage($1,$2,$3,$4,0,0,0,null,true,null,null)', [
          missionId,
          second,
          key,
          'review-budget-model',
        ]),
      ),
    ).rejects.toThrow();
  });
  it('all private helpers lose PUBLIC execute while explicit RLS identity grants still function', async () => {
    const publicFunctions = await db.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where n.nspname='private'and a.grantee=0 and a.privilege_type='EXECUTE'",
    );
    expect(publicFunctions.rows).toEqual([]);
    const identity = await db.query("select has_function_privilege('founder_role','private.owns_mission(uuid)','EXECUTE') allowed");
    expect(identity.rows[0]?.allowed).toBe(true);
    expect(
      (await withRole('founder_role', scope, client => client.query('select id from public.missions where id=$1', [missionId]))).rowCount,
    ).toBe(1);
    expect(
      (await withRole('specialist_role', scope, client => client.query('select *from public.readiness($1)', [missionId]))).rowCount,
    ).toBe(6);
    await expect(
      withRole('founder_role', scope, client => client.query('select private.authorization_json($1,false)', [randomUUID()])),
    ).rejects.toThrow('permission denied');
    await db.query(
      "create function private.review_default_privilege_probe()returns integer language sql security definer set search_path=''as 'select 1'",
    );
    expect(
      (
        await db.query(
          "select a.grantee from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where n.nspname='private'and p.proname='review_default_privilege_probe'and a.grantee=0 and a.privilege_type='EXECUTE'",
        )
      ).rowCount,
    ).toBe(0);
  });
  it('editable assets persist once with real scoped source IDs; raster and foreign logos are refused', async () => {
    const run = randomUUID();
    await db.query(
      "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier)values($1,$2,'brand','{\"maxTokens\":1000}','review asset fixture','mid')",
      [run, missionId],
    );
    const source = {
      logoSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0L20 20" stroke="#123456"/></svg>',
      editableLogoAssetIds: [],
    };
    const saved = await withRole('specialist_role', scope, client => persistEditableSources(client, missionId, run, source));
    expect(saved.logoSvg).toBeUndefined();
    expect(saved.editableLogoAssetIds).toHaveLength(1);
    expect(
      (await withRole('specialist_role', scope, client => persistEditableSources(client, missionId, run, source))).editableLogoAssetIds,
    ).toEqual(saved.editableLogoAssetIds);
    await expect(withRole('specialist_role', scope, client => assertAssetReferences(client, missionId, saved))).resolves.toBeUndefined();
    await expect(
      withRole('specialist_role', scope, client =>
        assertAssetReferences(client, missionId, { directions: [{ sourceAssetIds: [randomUUID()] }] }),
      ),
    ).rejects.toThrow('missing');
    const otherMission = '20000000-0000-4000-8000-000000000002';
    await expect(
      withRole('specialist_role', { authUserId: actor, missionId: otherMission }, client =>
        assertAssetReferences(client, otherMission, saved),
      ),
    ).rejects.toThrow('foreign');
    const raster = String(
      (
        await db.query(
          "insert into public.provider_assets(mission_id,mime_type,content_base64,payload_hash,provider_reference)values($1,'image/png','fixture','fixture',$2)returning id",
          [missionId, randomUUID()],
        )
      ).rows[0]?.id,
    );
    await expect(
      withRole('specialist_role', scope, client => assertAssetReferences(client, missionId, { editableLogoAssetIds: [raster] })),
    ).rejects.toThrow('not editable');
    await expect(withRole('founder_role', scope, client => persistEditableSources(client, missionId, run, source))).rejects.toThrow(
      'permission denied',
    );
  });
  it('the actual asset route returns an inert downloadable SVG and refuses cross-mission or hostile stored content', async () => {
    const run = randomUUID();
    await db.query(
      "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier)values($1,$2,'brand','{\"maxTokens\":1000}','review route fixture','mid')",
      [run, missionId],
    );
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><text>Editable source</text></svg>';
    const saved = await withRole('specialist_role', scope, client =>
        persistEditableSources(client, missionId, run, { logoSvg: source, editableLogoAssetIds: [] }),
      ),
      assetId = String((saved.editableLogoAssetIds as string[])[0]);
    const request = new Request('http://127.0.0.1/api/test');
    const response = await downloadAsset(request, { params: Promise.resolve({ missionId, assetId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(await response.text()).toBe(source);
    expect(
      (await downloadAsset(request, { params: Promise.resolve({ missionId: '20000000-0000-4000-8000-000000000002', assetId }) })).status,
    ).toBe(404);
    const hostile = String(
      (
        await db.query(
          "insert into public.editable_assets(mission_id,source_run_id,name,mime_type,content_base64,payload_hash,actor_id)values($1,$2,'hostile.svg','image/svg+xml',$3,$4,$5)returning id",
          [
            missionId,
            run,
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64'),
            'a'.repeat(64),
            actor,
          ],
        )
      ).rows[0]?.id,
    );
    expect((await downloadAsset(request, { params: Promise.resolve({ missionId, assetId: hostile }) })).status).toBe(404);
  });
});
