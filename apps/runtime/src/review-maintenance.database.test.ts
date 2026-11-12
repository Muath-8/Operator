import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  protectPrivateFile,
  createLogicalBackup,
  restoreLogicalBackup,
  readProtectedJson,
  SERVICE_LOGIN_ROLES,
  runRetention,
  configureTraceRetention,
  appendKnowledge,
  inspectKnowledge,
  activateKnowledge,
  provisionKnowledgeReviewer,
} from './maintenance.js';
import { withRole, closeDatabasePools } from './database.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_review_ops_${Date.now()}`,
  restoreName = `lo_restore_review_ops_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  prefix = `lo_review_ops_${Date.now().toString(36)}`,
  priorEnv = { ...process.env };
let db: Client, directory: string, url: URL;
const extraDatabases: string[] = [];
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${name}`);
  url = new URL(adminUrl);
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
  await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
  await db.query(
    "create table public.maintenance_rehearsal(id uuid primary key,fixture text not null);insert into public.maintenance_rehearsal values(gen_random_uuid(),'Explicit synthetic restore rehearsal only')",
  );
  directory = await mkdtemp(join(tmpdir(), 'lo-review-ops-rehearsal-'));
  await protectPrivateFile(directory);
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
}, 40000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = priorEnv;
  await db?.end();
  for (const target of extraDatabases) await admin.query(`drop database if exists ${target}with(force)`);
  await admin.query(`drop database if exists ${restoreName}with(force)`);
  await admin.query(`drop database if exists ${name}with(force)`);
  for (const group of Object.values(SERVICE_LOGIN_ROLES)) {
    const login = `${prefix}_${group.replace('_role', '')}`;
    await admin.query(`drop role if exists "${login}"`);
  }
  await admin.query(`drop role if exists "${prefix}_human_reviewer"`);
  await admin.end();
  if (directory?.startsWith(join(tmpdir(), 'lo-review-ops-rehearsal-'))) await rm(directory, { recursive: true, force: true });
});

const scope = { authUserId: '00000000-0000-4000-8000-000000000001', missionId: '20000000-0000-4000-8000-000000000001' };
async function aged() {
  const id = String(
    (
      await db.query(
        "insert into public.retention_objects(mission_id,kind,source_reference,payload_hash,byte_length,expires_at)values($1,'recording',$2,encode(public.digest('{}','sha256'),'hex'),2,clock_timestamp()-interval'1 second')returning id",
        [scope.missionId, randomUUID()],
      )
    ).rows[0]?.id,
  );
  await db.query('insert into private.retention_payloads(object_id,payload)values($1,\'{"syntheticPrivateRaw":true}\')', [id]);
  return id;
}
const raw = (id: string) =>
  withRole(
    'founder_role',
    scope,
    async c => (await c.query('select public.read_retained_content($1,$2)body', [scope.missionId, id])).rows[0]?.body,
  );

describe('independent maintenance privacy and recovery boundaries', () => {
  it('withholds expired unkept raw content before the maintenance job runs', async () => {
    const object = await aged();
    expect((await db.query('select from private.retention_payloads where object_id=$1', [object])).rowCount).toBe(1);
    expect(await raw(object)).toBeNull();
  });
  it('withholds an opted-out trace immediately before the asynchronous purge job runs', async () => {
    const object = await withRole('policy_role', scope, async c =>
      String(
        (
          await c.query("select public.store_retained_content($1,'trace',$2,'{\"syntheticRedactedTrace\":true}',null,true)id", [
            scope.missionId,
            randomUUID(),
          ])
        ).rows[0]?.id,
      ),
    );
    expect(await raw(object)).toEqual({ syntheticRedactedTrace: true });
    await configureTraceRetention(scope, false);
    expect((await db.query('select from private.retention_payloads where object_id=$1', [object])).rowCount).toBe(1);
    expect(await raw(object)).toBeNull();
  });
  it('rejects a physically readable shared archive before creating a restore target', async () => {
    const backup = join(directory, 'acl-backup'),
      config = { databaseUrl: url.href, binaryDirectory: 'C:/Program Files/PostgreSQL/15/bin' };
    await createLogicalBackup(config, backup);
    const archive = join(backup, 'database.dump'),
      target = `${restoreName}_acl`;
    extraDatabases.push(target);
    if (process.platform === 'win32') await promisify(execFile)('icacls.exe', [archive, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
    else await chmod(archive, 0o644);
    try {
      await expect(restoreLogicalBackup(config, backup, target)).rejects.toThrow(/private|ACL|permission|owner/);
      expect((await admin.query('select from pg_database where datname=$1', [target])).rowCount).toBe(0);
    } finally {
      if (process.platform === 'win32') await promisify(execFile)('icacls.exe', [archive, '/remove:g', '*S-1-1-0'], { windowsHide: true });
      await protectPrivateFile(archive);
    }
  }, 60000);
  it('performs actual private backup/restore and quarantines the verified clone', async () => {
    const config = { databaseUrl: url.href, binaryDirectory: 'C:/Program Files/PostgreSQL/15/bin' },
      backup = join(directory, 'positive-backup');
    await db.query('update private.platform_controls set effects_enabled=true');
    const result = await createLogicalBackup(config, backup);
    expect(result.tables).toBeGreaterThan(100);
    const restored = await restoreLogicalBackup(config, backup, restoreName);
    expect(restored).toMatchObject({ verified: true, effectsQuarantined: true, tables: result.tables });
    expect((await db.query('select effects_enabled from private.platform_controls')).rows[0]?.effects_enabled).toBe(true);
    const manifest = await readProtectedJson(join(backup, 'manifest.json'));
    expect(manifest).toHaveProperty('containsExternalStorageBinaries', false);
  }, 60000);
  it('keeps a failed restored clone quarantined before any deliberate cutover', async () => {
    const config = { databaseUrl: url.href, binaryDirectory: 'C:/Program Files/PostgreSQL/15/bin' },
      backup = join(directory, 'failed-restore-backup'),
      target = `${restoreName}_failed`;
    extraDatabases.push(target);
    await db.query('update private.platform_controls set effects_enabled=true');
    await createLogicalBackup(config, backup);
    const path = join(backup, 'manifest.json'),
      manifest = (await readProtectedJson(path)) as { tables: { sha256: string }[] };
    if (!manifest.tables[0]) throw new Error('Expected real backup table fingerprint');
    manifest.tables[0].sha256 = '0'.repeat(64);
    await writeFile(path, JSON.stringify(manifest));
    await expect(restoreLogicalBackup(config, backup, target)).rejects.toThrow(/fingerprint/);
    const clonedUrl = new URL(url.href);
    clonedUrl.pathname = `/${target}`;
    const clone = new Client({ connectionString: clonedUrl.href });
    await clone.connect();
    try {
      expect((await clone.query('select effects_enabled from private.platform_controls')).rows[0]?.effects_enabled).toBe(false);
    } finally {
      await clone.end();
    }
  }, 60000);
  it('denies actual nonprivileged runtime login connections to both successful and failed clones', async () => {
    const login = `${prefix}_lead`;
    await admin.query(`create role "${login}" login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await admin.query(`grant lead_role to "${login}"`);
    const sourceUrl = new URL(url.href);
    sourceUrl.username = login;
    sourceUrl.password = '';
    const source = new Client({ connectionString: sourceUrl.href });
    await source.connect();
    await source.end();
    for (const target of [restoreName, `${restoreName}_failed`]) {
      const cloned = new URL(sourceUrl.href);
      cloned.pathname = `/${target}`;
      const denied = new Client({ connectionString: cloned.href });
      try {
        await expect(denied.connect()).rejects.toThrow(/permission denied for database/);
      } finally {
        await denied.end();
      }
      expect((await admin.query("select has_database_privilege($1,$2,'CONNECT')allowed", [login, target])).rows[0]?.allowed).toBe(false);
    }
  });
  it('runs purge without deleting immutable mission business rows', async () => {
    const before = (
      await db.query(
        'select(select count(*)from public.evidence)ev,(select count(*)from public.decisions)d,(select count(*)from public.money_ledger)m,(select count(*)from public.messages)msg',
      )
    ).rows[0];
    expect(await runRetention({ databaseUrl: url.href }, false)).toMatchObject({ businessLedgerRowsDeleted: 0 });
    expect(
      (
        await db.query(
          'select(select count(*)from public.evidence)ev,(select count(*)from public.decisions)d,(select count(*)from public.money_ledger)m,(select count(*)from public.messages)msg',
        )
      ).rows[0],
    ).toEqual(before);
  });
  it('does not infer human review from an author payload, mismatched hashes or an arbitrary SET ROLE', async () => {
    const input = {
      kind: 'playbook',
      id: `review-ops-${Date.now()}`,
      version: 1,
      content: {
        steps: [{ id: 'test', instruction: 'Synthetic source review only', source: 'https://example.test/source', optional: false }],
      },
      sources: ['https://example.test/source'],
    };
    const config = { databaseUrl: url.href },
      hashes = await inspectKnowledge(config, input);
    await expect(
      appendKnowledge(config, input, {
        ...hashes,
        reviewReference: 'https://example.test/fixture',
        reviewedAt: new Date().toISOString(),
        attestation: 'I personally reviewed this exact content and sources',
      }),
    ).rejects.toThrow(/review/);
    const result = await appendKnowledge(config, input);
    expect(result.reviewStatus).toBe('unverified');
  });
  it('deduplicates retained raw payloads when a signed voice event is replayed', async () => {
    const party = randomUUID(),
      session = randomUUID(),
      refs = [randomUUID(), randomUUID()];
    await db.query(
      "insert into public.counterparties(id,founder_id,kind,name)values($1,'10000000-0000-4000-8000-000000000001','supplier','Synthetic replay contact')",
      [party],
    );
    for (const [i, provider] of ['twilio', 'openai'].entries()) {
      const account = randomUUID();
      await db.query(
        "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,'10000000-0000-4000-8000-000000000001',$2,'connected','{}')",
        [account, provider],
      );
      await db.query(
        'insert into private.provider_credentials(ref,mission_id,account_id,provider,sandbox_mode,encrypted)values($1,$2,$3,$4,true,\'{"fixture":"no provider secret"}\')',
        [refs[i], scope.missionId, account, provider],
      );
    }
    await db.query(
      "insert into public.voice_sessions(id,mission_id,task_id,counterparty_id,twilio_ref,openai_ref,language,disclosure,recording_consent,bounds)values($1,$2,$3,$4,$5,$6,'en','Explicit synthetic replay fixture',true,'{}')",
      [session, scope.missionId, randomUUID(), party, ...refs],
    );
    const append = () =>
      withRole('ingress_role', scope, c =>
        c.query("select public.append_voice_event($1,$2,'transcript','synthetic-replayed-event',$3)", [
          scope.missionId,
          session,
          { text: 'Explicit synthetic raw replay payload' },
        ]),
      );
    await append();
    await append();
    expect((await db.query('select from public.voice_session_events where session_id=$1', [session])).rowCount).toBe(1);
    expect((await db.query('select from public.retention_objects where voice_session_id=$1', [session])).rowCount).toBe(1);
  });
  it('binds a registered reviewer attestation to exact content and sources and rolls active pointers back append-only', async () => {
    // This registered login and attestation are synthetic authorization fixtures, not actual human review.
    const file = join(directory, 'reviewer-fixture.json');
    await provisionKnowledgeReviewer({ databaseUrl: url.href }, `${prefix}_human`, `reviewer:${randomUUID()}`, file);
    const bundle = z
        .object({ credentials: z.record(z.string(), z.string()) })
        .passthrough()
        .parse(await readProtectedJson(file)),
      connection = bundle.credentials.DATABASE_KNOWLEDGE_REVIEWER_URL;
    if (!connection) throw new Error('Expected independently registered reviewer credentials');
    const author = { databaseUrl: url.href },
      reviewer = { databaseUrl: connection },
      id = `independent-source-${Date.now()}`,
      input = {
        kind: 'playbook',
        id,
        version: 1,
        content: {
          steps: [{ id: 'check', instruction: 'Synthetic checked source fixture', source: 'https://example.test/source', optional: false }],
        },
        sources: ['https://example.test/source'],
      };
    await appendKnowledge(author, input);
    const current = () =>
        withRole('lead_role', scope, async c => (await c.query("select public.knowledge_active_version('playbook',$1)v", [id])).rows[0]?.v),
      second = { ...input, version: 2 },
      hashes = await inspectKnowledge(author, second),
      review = {
        ...hashes,
        reviewReference: 'https://example.test/synthetic-attestation',
        reviewedAt: new Date().toISOString(),
        attestation: 'I personally reviewed this exact content and sources',
      };
    for (const patch of [
      { contentHash: '0'.repeat(64) },
      { sourceHash: '0'.repeat(64) },
      { reviewedAt: '2000-01-01T00:00:00Z' },
      { reviewedAt: '2100-01-01T00:00:00Z' },
    ])
      await expect(appendKnowledge(reviewer, second, { ...review, ...patch })).rejects.toThrow();
    await appendKnowledge(reviewer, second, review);
    expect(await current()).toBe(1);
    await activateKnowledge(reviewer, 'playbook', id, 2);
    expect(await current()).toBe(2);
    const third = {
      ...input,
      version: 3,
      content: { steps: [{ ...input.content.steps[0], instruction: 'Synthetic next immutable source' }] },
    };
    await appendKnowledge(reviewer, third, { ...review, ...(await inspectKnowledge(author, third)) });
    await activateKnowledge(reviewer, 'playbook', id, 3);
    expect(await current()).toBe(3);
    await activateKnowledge(reviewer, 'playbook', id, 2);
    expect(await current()).toBe(2);
    expect((await db.query('select from public.knowledge_revisions where knowledge_id=$1', [id])).rowCount).toBe(3);
    expect((await db.query('select from public.knowledge_pointers where knowledge_id=$1', [id])).rowCount).toBe(3);
    await expect(db.query('delete from public.knowledge_revisions where knowledge_id=$1', [id])).rejects.toThrow(/append.only/);
  });
  it('selects the latest bundled baseline without automatically promoting an operator-added unreviewed version', async () => {
    const id = `bundled-review-${Date.now()}`,
      content = {
        steps: [{ id: 'check', instruction: 'Synthetic bundled baseline', source: 'https://example.test/source', optional: false }],
      };
    for (const version of [2, 1])
      await db.query("insert into public.playbooks(id,version,content,review_status,sources)values($1,$2,$3,'unverified',$4)", [
        id,
        version,
        content,
        ['https://example.test/source'],
      ]);
    const current = () =>
      withRole('lead_role', scope, async c => (await c.query("select public.knowledge_active_version('playbook',$1)v", [id])).rows[0]?.v);
    expect(await current()).toBe(2);
    await appendKnowledge(
      { databaseUrl: url.href },
      { kind: 'playbook', id, version: 3, content, sources: ['https://example.test/source'] },
    );
    expect(await current()).toBe(2);
    const operatorId = `operator-only-${Date.now()}`;
    await appendKnowledge(
      { databaseUrl: url.href },
      { kind: 'playbook', id: operatorId, version: 1, content, sources: ['https://example.test/source'] },
    );
    expect(
      await withRole(
        'lead_role',
        scope,
        async c => (await c.query("select public.knowledge_active_version('playbook',$1)v", [operatorId])).rows[0]?.v,
      ),
    ).toBe(1);
  });
});
