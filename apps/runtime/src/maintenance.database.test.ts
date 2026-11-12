import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir, mkdtemp, rm, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  protectPrivateFile,
  createLogicalBackup,
  restoreLogicalBackup,
  provisionServiceLogins,
  provisionKnowledgeReviewer,
  readProtectedJson,
  SERVICE_LOGIN_ROLES,
  BackupManifestSchema,
  expireBackupArchives,
  runRetention,
  keepRetainedContent,
  configureTraceRetention,
  missionTraceExportAllowed,
  inspectKnowledge,
  appendKnowledge,
  activateKnowledge,
} from './maintenance.js';
import { withRole, closeDatabasePools } from './database.js';
import { z } from 'zod';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_ops_${Date.now()}`,
  restoreName = `lo_restore_ops_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  prefix = `lo_ops_${Date.now().toString(36)}`,
  priorEnv = { ...process.env };
let db: Client, directory: string, url: URL;
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
  directory = await mkdtemp(join(tmpdir(), 'lo-ops-rehearsal-'));
  await protectPrivateFile(directory);
  process.env['DATABASE_URL'] = url.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
}, 40000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = priorEnv;
  await db?.end();
  await admin.query(`drop database if exists ${restoreName}with(force)`);
  await admin.query(`drop database if exists ${name}with(force)`);
  for (const group of Object.values(SERVICE_LOGIN_ROLES)) {
    const login = `${prefix}_${group.replace('_role', '')}`;
    await admin.query(`drop role if exists "${login}"`);
  }
  await admin.query(`drop role if exists "${prefix}_human_reviewer"`);
  await admin.end();
  if (directory?.startsWith(join(tmpdir(), 'lo-ops-rehearsal-'))) await rm(directory, { recursive: true, force: true });
});
describe('Quality7/12 actual least-privilege logins and logical backup/isolated restore rehearsal', () => {
  it('creates separate non-inheriting logins with one membership each and never exposes passwords in operator output', async () => {
    const file = join(directory, 'credentials.json'),
      result = await provisionServiceLogins({ databaseUrl: url.href }, prefix, file);
    expect(result.roles).toBe(Object.keys(SERVICE_LOGIN_ROLES).length);
    const output = z
      .object({ credentials: z.record(z.string(), z.string()) })
      .passthrough()
      .parse(await readProtectedJson(file));
    for (const [env, group] of Object.entries(SERVICE_LOGIN_ROLES)) {
      const connection = output.credentials[env];
      if (!connection) throw new Error('Missing scoped service credential');
      const login = new URL(connection).username,
        attributes = (
          await admin.query(
            'select rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls from pg_roles where rolname=$1',
            [login],
          )
        ).rows[0];
      expect(attributes).toEqual({
        rolcanlogin: true,
        rolinherit: false,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
      });
      expect(
        (
          await admin.query(
            'select parent.rolname from pg_auth_members m join pg_roles member on member.oid=m.member join pg_roles parent on parent.oid=m.roleid where member.rolname=$1',
            [login],
          )
        ).rows,
      ).toEqual([{ rolname: group }]);
      const restricted = new Client({ connectionString: connection });
      await restricted.connect();
      try {
        await restricted.query(`set role ${group}`);
        await expect(restricted.query(`set role ${group === 'policy_role' ? 'founder_role' : 'policy_role'}`)).rejects.toThrow(
          /permission denied/,
        );
        if (group === 'operator_role' || group === 'auth_role' || group === 'maintenance_role')
          await expect(restricted.query('select *from public.messages')).rejects.toThrow(/permission denied/);
      } finally {
        await restricted.end();
      }
    }
    await expect(provisionServiceLogins({ databaseUrl: url.href }, prefix, join(directory, 'other.json'))).rejects.toThrow();
    const password = new URL(output.credentials.DATABASE_POLICY_URL ?? '').password;
    expect(JSON.stringify(result).includes(password)).toBe(false);
  });
  it('rehearses real pg_dump/pg_restore into a new isolated target, verifies every table fingerprint and refuses corruption or existing targets', async () => {
    await db.query('update private.platform_controls set effects_enabled=true');
    const backup = join(directory, 'daily-backup'),
      config = { databaseUrl: url.href, binaryDirectory: process.env['PG_BIN_DIRECTORY'] ?? 'C:/Program Files/PostgreSQL/15/bin' },
      created = await createLogicalBackup(config, backup),
      manifest = BackupManifestSchema.parse(await readProtectedJson(join(backup, 'manifest.json')));
    expect(manifest.tables.length).toBeGreaterThan(100);
    expect(manifest.tables.find(t => t.table === 'maintenance_rehearsal')?.rows).toBe('1');
    const restored = await restoreLogicalBackup(config, backup, restoreName);
    expect(restored).toMatchObject({ verified: true, effectsQuarantined: true });
    expect(restored.tables).toBe(created.tables);
    const restoredUrl = new URL(url.href);
    restoredUrl.pathname = `/${restoreName}`;
    const isolated = new Client({ connectionString: restoredUrl.href });
    await isolated.connect();
    try {
      expect((await isolated.query('select effects_enabled from private.platform_controls')).rows[0]?.effects_enabled).toBe(false);
    } finally {
      await isolated.end();
    }
    expect((await db.query('select effects_enabled from private.platform_controls')).rows[0]?.effects_enabled).toBe(true);
    await expect(restoreLogicalBackup(config, backup, restoreName)).rejects.toThrow(/new isolated/);
    await expect(restoreLogicalBackup(config, backup, name)).rejects.toThrow();
    const archiveRoot = join(directory, 'archive-expiry'),
      old = join(archiveRoot, 'lo_backup_synthetic_old');
    await mkdir(archiveRoot);
    await protectPrivateFile(archiveRoot);
    await mkdir(old);
    await protectPrivateFile(old);
    await copyFile(join(backup, 'database.dump'), join(old, 'database.dump'));
    await protectPrivateFile(join(old, 'database.dump'));
    await writeFile(join(old, 'manifest.json'), JSON.stringify({ ...manifest, createdAt: '2000-01-01T00:00:00Z' }), { mode: 0o600 });
    await protectPrivateFile(join(old, 'manifest.json'));
    expect(await expireBackupArchives(archiveRoot)).toMatchObject({ expiredBackups: 1, purgedArchives: 0, blocked: 0 });
    expect((await stat(join(old, 'database.dump'))).size).toBe(manifest.bytes);
    expect(await expireBackupArchives(archiveRoot, false)).toMatchObject({ purgedArchives: 1, blocked: 0 });
    await expect(stat(join(old, 'database.dump'))).rejects.toThrow();
    expect((await stat(join(old, 'manifest.json'))).isFile()).toBe(true);
    expect((await stat(join(old, 'purge-completed.json'))).isFile()).toBe(true);
    expect(await expireBackupArchives(archiveRoot, false)).toMatchObject({ expiredBackups: 0, purgedArchives: 0 });
    await writeFile(join(backup, 'database.dump'), 'Explicit test-only corruption');
    await expect(restoreLogicalBackup(config, backup, `${restoreName}_bad`)).rejects.toThrow(/integrity/);
    expect((await admin.query('select 1 from pg_database where datname=$1', [`${restoreName}_bad`])).rowCount).toBe(0);
    console.info('isolated_backup_restore_rehearsal', {
      tables: created.tables,
      archiveSha256: created.sha256,
      verified: true,
      source: 'synthetic_disposable_database',
    });
  }, 60000);
  it('retention removes eligible raw content and expired streams only, preserves founder-kept content and ledger metadata, and honors trace opt-out', async () => {
    const authUserId = randomUUID(),
      founderId = randomUUID(),
      missionId = randomUUID(),
      scope = { authUserId, missionId };
    await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founderId, authUserId]);
    await db.query(
      "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode)values($1,$2,'launch','Synthetic retention fixture','SAR',true)",
      [missionId, founderId],
    );
    const aged = async (source: string) => {
        const object = String(
          (
            await db.query(
              "insert into public.retention_objects(mission_id,kind,source_reference,payload_hash,byte_length,created_at,expires_at)values($1,'recording',$2,encode(public.digest($3::jsonb::text,'sha256'),'hex'),octet_length($3::text),clock_timestamp()-interval'100 days',clock_timestamp()-interval'10 days')returning id",
              [missionId, source, JSON.stringify({ fixture: 'Explicit synthetic raw recording only' })],
            )
          ).rows[0]?.id,
        );
        await db.query(
          'insert into private.retention_payloads(object_id,payload)values($1,\'{"fixture":"Explicit synthetic raw recording only"}\')',
          [object],
        );
        return object;
      },
      expired = await aged('synthetic-expired'),
      kept = await aged('synthetic-kept');
    await keepRetainedContent(scope, kept, true);
    await expect(keepRetainedContent({ ...scope, authUserId: randomUUID() }, kept, false)).rejects.toThrow();
    await expect(
      withRole('policy_role', scope, c =>
        c.query("select public.store_retained_content($1,'recording','unconsented','{}',null,false)", [missionId]),
      ),
    ).rejects.toThrow(/consent/);
    await expect(
      withRole('policy_role', scope, c =>
        c.query("select public.store_retained_content($1,'trace','not-redacted','{}',null,false)", [missionId]),
      ),
    ).rejects.toThrow(/redacted/);
    const trace = await withRole('policy_role', scope, async c =>
      String(
        (
          await c.query(
            "select public.store_retained_content($1,'trace','synthetic-redacted-trace','{\"runId\":\"explicit-test-only\"}',null,true)id",
            [missionId],
          )
        ).rows[0]?.id,
      ),
    );
    expect(await missionTraceExportAllowed(scope)).toBe(true);
    await expect(keepRetainedContent(scope, trace, true)).rejects.toThrow();
    await configureTraceRetention(scope, false);
    expect(await missionTraceExportAllowed(scope)).toBe(false);
    expect(
      await withRole(
        'policy_role',
        scope,
        async c =>
          (await c.query("select public.store_retained_content($1,'trace','opted-out-new-trace','{}',null,true)id", [missionId])).rows[0]
            ?.id,
      ),
    ).toBeNull();
    for (const expiredStream of [true, false]) {
      const run = randomUUID();
      await db.query(
        "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier)values($1,$2,'lead','{}','synthetic-retention','small')",
        [run, missionId],
      );
      await db.query(
        "insert into public.agent_message_streams(mission_id,run_id,attempt_key,sequence,text,expires_at)values($1,$2,'synthetic',0,'Explicit ephemeral draft fixture',clock_timestamp()+$3::interval)",
        [missionId, run, expiredStream ? '-1 minute' : '5 minutes'],
      );
    }
    const ledgerCounts = async () =>
        JSON.stringify(
          (
            await db.query(
              "select 'messages'table_name,count(*)::text n from public.messages union all select 'evidence',count(*)::text from public.evidence union all select 'events',count(*)::text from public.events union all select 'money_ledger',count(*)::text from public.money_ledger order by table_name",
            )
          ).rows,
        ),
      before = await ledgerCounts();
    expect(await runRetention({ databaseUrl: url.href })).toMatchObject({
      dryRun: true,
      rawObjects: 2,
      ephemeralStreams: 1,
      businessLedgerRowsDeleted: 0,
    });
    expect((await db.query('select count(*)::int n from private.retention_payloads')).rows[0]?.n).toBe(3);
    expect(await runRetention({ databaseUrl: url.href }, false)).toMatchObject({
      rawObjects: 2,
      ephemeralStreams: 1,
      businessLedgerRowsDeleted: 0,
    });
    expect(await ledgerCounts()).toBe(before);
    expect((await db.query('select count(*)::int n from public.retention_objects where mission_id=$1', [missionId])).rows[0]?.n).toBe(3);
    expect((await db.query('select count(*)::int n from public.retention_purges where mission_id=$1', [missionId])).rows[0]?.n).toBe(2);
    expect(
      await withRole(
        'founder_role',
        scope,
        async c => (await c.query('select public.read_retained_content($1,$2)body', [missionId, expired])).rows[0]?.body,
      ),
    ).toBeNull();
    expect(
      await withRole(
        'founder_role',
        scope,
        async c => (await c.query('select public.read_retained_content($1,$2)body', [missionId, kept])).rows[0]?.body,
      ),
    ).toEqual({ fixture: 'Explicit synthetic raw recording only' });
    await expect(keepRetainedContent(scope, expired, true)).rejects.toThrow(/expired/);
    await expect(withRole('policy_role', scope, c => c.query('select *from private.retention_payloads'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(withRole('founder_role', scope, c => c.query('select public.expire_retained_content(false)'))).rejects.toThrow(
      /permission denied/,
    );
    expect(await runRetention({ databaseUrl: url.href }, false)).toMatchObject({ rawObjects: 0, ephemeralStreams: 0 });
  });
  it('consented voice raw payloads become private retained objects while immutable events keep only hashes and provider identifiers', async () => {
    const authUserId = randomUUID(),
      founderId = randomUUID(),
      missionId = randomUUID(),
      party = randomUUID(),
      twilio = randomUUID(),
      openai = randomUUID(),
      session = randomUUID(),
      scope = { authUserId, missionId };
    await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founderId, authUserId]);
    await db.query(
      "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode)values($1,$2,'launch','Synthetic consent/retention fixture','SAR',true)",
      [missionId, founderId],
    );
    await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'supplier','Synthetic recording contact')", [
      party,
      founderId,
    ]);
    for (const [ref, provider] of [
      [twilio, 'twilio'],
      [openai, 'openai'],
    ]) {
      const account = randomUUID();
      await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,$3,'connected','{}')", [
        account,
        founderId,
        provider,
      ]);
      await db.query(
        'insert into private.provider_credentials(ref,mission_id,account_id,provider,sandbox_mode,encrypted)values($1,$2,$3,$4,true,\'{"fixture":"explicit-test-no-provider-secret"}\')',
        [ref, missionId, account, provider],
      );
    }
    await db.query(
      "insert into public.voice_sessions(id,mission_id,task_id,counterparty_id,twilio_ref,openai_ref,language,disclosure,recording_consent,bounds)values($1,$2,$3,$4,$5,$6,'en','Explicit synthetic AI disclosure',true,'{}')",
      [session, missionId, randomUUID(), party, twilio, openai],
    );
    const payload = { recordingSid: `RE${'1'.repeat(32)}`, callSid: `CA${'2'.repeat(32)}`, notes: 'RAW_SYNTHETIC_RECORDING_ONLY' },
      event = await withRole('ingress_role', scope, async c =>
        String(
          (
            await c.query("select public.append_voice_event($1,$2,'recording','synthetic-retained-recording',$3)id", [
              missionId,
              session,
              payload,
            ])
          ).rows[0]?.id,
        ),
      ),
      stored = (await db.query('select payload from public.voice_session_events where id=$1', [event])).rows[0]?.payload as {
        retentionObjectId: string;
        payloadHash: string;
        recordingSid: string;
      };
    expect(stored.recordingSid).toBe(payload.recordingSid);
    expect(stored.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored).includes(payload.notes)).toBe(false);
    expect(
      await withRole(
        'founder_role',
        scope,
        async c =>
          (await c.query('select public.read_retained_content($1,$2)payload', [missionId, stored.retentionObjectId])).rows[0]?.payload,
      ),
    ).toEqual(payload);
    await expect(
      withRole('voice_role', scope, c => c.query('select public.read_retained_content($1,$2)', [missionId, stored.retentionObjectId])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('ingress_role', scope, c => c.query("update public.voice_session_events set payload='{}' where id=$1", [event])),
    ).rejects.toThrow(/permission denied/);
  });
  it('a founder keep that commits while a purge waits on the mission lock prevents deletion', async () => {
    const authUserId = randomUUID(),
      founderId = randomUUID(),
      missionId = randomUUID(),
      scope = { authUserId, missionId };
    await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founderId, authUserId]);
    await db.query(
      "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode)values($1,$2,'launch','Synthetic keep race fixture','SAR',true)",
      [missionId, founderId],
    );
    const object = String(
      (
        await db.query(
          "insert into public.retention_objects(mission_id,kind,source_reference,payload_hash,byte_length,created_at,expires_at)values($1,'recording','synthetic-keep-race',encode(public.digest('{}','sha256'),'hex'),2,clock_timestamp()-interval'100 days',clock_timestamp()-interval'10 days')returning id",
          [missionId],
        )
      ).rows[0]?.id,
    );
    await db.query("insert into private.retention_payloads(object_id,payload)values($1,'{}')", [object]);
    let release: () => void = () => undefined,
      ready: () => void = () => undefined;
    const heldGate = new Promise<void>(resolve => {
        release = resolve;
      }),
      entered = new Promise<void>(resolve => {
        ready = resolve;
      }),
      holding = withRole('founder_role', scope, async c => {
        await c.query('select public.keep_retained_content($1,$2,true)', [missionId, object]);
        ready();
        await heldGate;
      });
    await entered;
    const connection = new URL(url.href);
    connection.searchParams.set('application_name', 'lo-retention-race');
    const purge = runRetention({ databaseUrl: connection.href }, false);
    let waited = false;
    try {
      for (let i = 0; i < 50; i++) {
        if (
          Number(
            (await db.query("select count(*)n from pg_stat_activity where application_name='lo-retention-race'and wait_event_type='Lock'"))
              .rows[0]?.n,
          ) > 0
        ) {
          waited = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally {
      release();
    }
    await holding;
    expect(waited).toBe(true);
    expect(await purge).toMatchObject({ rawObjects: 0 });
    expect((await db.query('select count(*)::int n from private.retention_payloads where object_id=$1', [object])).rows[0]?.n).toBe(1);
  });
  it('knowledge appends require source provenance; reviewed/activated versions require a distinct registered human login and exact content hashes', async () => {
    const bundle = z
        .object({ credentials: z.record(z.string(), z.string()) })
        .passthrough()
        .parse(await readProtectedJson(join(directory, 'credentials.json'))),
      author = { databaseUrl: z.string().parse(bundle.credentials.DATABASE_KNOWLEDGE_URL) },
      reviewerFile = join(directory, 'human-reviewer.json');
    await provisionKnowledgeReviewer({ databaseUrl: url.href }, `${prefix}_human`, `reviewer:${randomUUID()}`, reviewerFile);
    const human = z
        .object({ credentials: z.record(z.string(), z.string()) })
        .passthrough()
        .parse(await readProtectedJson(reviewerFile)),
      reviewer = { databaseUrl: z.string().parse(human.credentials.DATABASE_KNOWLEDGE_REVIEWER_URL) },
      input = {
        kind: 'category_profile',
        id: 'ops-synthetic-fixture',
        version: 1,
        content: { palette: ['gray'] },
        sources: ['repo:docs/01-BRD-and-Functional-Requirements.md'],
      };
    expect(await appendKnowledge(author, input)).toMatchObject({ reviewStatus: 'unverified' });
    await expect(appendKnowledge(author, { ...input, id: 'missing-sources', sources: [] })).rejects.toThrow();
    await expect(activateKnowledge(author, input.kind, input.id, 1)).rejects.toThrow();
    const current = async () => {
      const c = new Client({ connectionString: author.databaseUrl });
      await c.connect();
      try {
        await c.query('set role knowledge_role');
        return (await c.query('select public.knowledge_active_version($1,$2)version', [input.kind, input.id])).rows[0]?.version;
      } finally {
        await c.end();
      }
    };
    expect(await current()).toBe(1);
    const reviewedInput = { ...input, version: 2, content: { palette: ['blue'] } },
      hashes = await inspectKnowledge(author, reviewedInput),
      review = {
        ...hashes,
        reviewReference: 'repo:docs/implementation/OPERATIONS-RUNBOOK.md',
        reviewedAt: new Date().toISOString(),
        attestation: 'I personally reviewed this exact content and sources',
      };
    await expect(appendKnowledge(author, reviewedInput, review)).rejects.toThrow();
    await expect(appendKnowledge(reviewer, reviewedInput, { ...review, contentHash: '0'.repeat(64) })).rejects.toThrow();
    await expect(appendKnowledge(reviewer, reviewedInput, { ...review, contentHash: null })).rejects.toThrow();
    await expect(appendKnowledge(reviewer, reviewedInput, { ...review, reviewedAt: '2100-01-01T00:00:00Z' })).rejects.toThrow();
    expect(await appendKnowledge(reviewer, reviewedInput, review)).toMatchObject({ reviewStatus: 'reviewed' });
    expect(await current()).toBe(1);
    await activateKnowledge(reviewer, input.kind, input.id, 2);
    expect(await current()).toBe(2);
    const third = { ...reviewedInput, version: 3, content: { palette: ['green'] } },
      thirdReview = { ...review, ...(await inspectKnowledge(author, third)) };
    await appendKnowledge(reviewer, third, thirdReview);
    await activateKnowledge(reviewer, input.kind, input.id, 3);
    expect(await current()).toBe(3);
    await activateKnowledge(reviewer, input.kind, input.id, 2);
    expect(await current()).toBe(2);
    expect((await db.query('select count(*)::int n from public.knowledge_revisions where knowledge_id=$1', [input.id])).rows[0]?.n).toBe(3);
    expect((await db.query('select count(*)::int n from public.knowledge_pointers where knowledge_id=$1', [input.id])).rows[0]?.n).toBe(3);
    const rules = ['brand', 'product', 'supply', 'commerce', 'compliance', 'demand'].flatMap(outcome =>
        Array.from({ length: 5 }, (_, n) => ({
          outcome,
          level: n + 1,
          evidenceKinds: ['external_verification'],
          decisionGates: [],
          highTrust: n >= 3,
        })),
      ),
      staged = { kind: 'readiness_rules', id: 'ops-synthetic-rules', version: 3, content: { rules }, sources: input.sources },
      stagedReview = { ...review, ...(await inspectKnowledge(author, staged)) };
    await expect(appendKnowledge(author, staged)).rejects.toThrow();
    const unsafe = { ...staged, content: { rules: rules.map(r => ({ ...r, highTrust: false })) } };
    await expect(appendKnowledge(reviewer, unsafe, { ...review, ...(await inspectKnowledge(author, unsafe)) })).rejects.toThrow();
    await appendKnowledge(reviewer, staged, stagedReview);
    await expect(activateKnowledge(reviewer, 'readiness_rules', staged.id, 3)).rejects.toThrow();
  });
});
