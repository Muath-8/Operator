import { readMissionPrivacy } from './privacy.js';
import { writeMissionArchive, missionArchiveStream, type ArchiveRecord } from './full-export.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = 'lo_archive_' + Date.now(),
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

async function records(scope: ActorScope) {
  const result: ArchiveRecord[] = [];
  await writeMissionArchive(scope, async row => {
    result.push(row);
  });
  return result;
}
describe('NFR-13 full portable mission export', () => {
  it('exports available redacted raw content but omits expired and opted-out payloads without losing ledger metadata', async () => {
    const scope = await fixture();
    const current = await withRole('policy_role', scope, async c =>
      String(
        (
          await c.query("select public.store_retained_content($1,'trace','synthetic:archive-current',$2,null,true)id", [
            scope.missionId,
            { summary: 'Synthetic current trace', authorization_id: 'durable-business-reference' },
          ])
        ).rows[0]?.id,
      ),
    );
    const expired = randomUUID();
    await db.query(
      "insert into public.retention_objects(id,mission_id,kind,source_reference,payload_hash,byte_length,expires_at)values($1,$2,'trace','synthetic:archive-expired',repeat('0',64),1,clock_timestamp()-interval'1 day')",
      [expired, scope.missionId],
    );
    await db.query('insert into private.retention_payloads(object_id,payload)values($1,$2)', [
      expired,
      { summary: 'Expired raw fixture must not export' },
    ]);
    const privacy = await readMissionPrivacy(scope);
    expect(privacy.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: current, available: true }),
        expect.objectContaining({ id: expired, available: false }),
      ]),
    );
    expect(JSON.stringify(privacy)).not.toContain('Synthetic current trace');
    await expect(readMissionPrivacy({ ...scope, authUserId: randomUUID() })).rejects.toThrow();
    let result = await records(scope);
    expect(result.filter(r => r.kind === 'retained_content')).toEqual([
      {
        kind: 'retained_content',
        value: { objectId: current, payload: { summary: 'Synthetic current trace', authorization_id: 'durable-business-reference' } },
      },
    ]);
    expect(result.filter(r => r.table === 'retention_objects')).toHaveLength(2);
    await withRole('founder_role', scope, c => c.query('select public.configure_trace_retention($1,false)', [scope.missionId]));
    result = await records(scope);
    expect(result.filter(r => r.kind === 'retained_content')).toHaveLength(0);
    expect(result.filter(r => r.table === 'retention_objects')).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('Expired raw fixture must not export');
  });
  it('includes original messages, immutable references and actual editable asset bytes in a consistent complete archive', async () => {
    const scope = await fixture();
    const thread = randomUUID();
    await db.query('insert into public.threads(id,mission_id)values($1,$2)', [thread, scope.missionId]);
    await db.query(
      "insert into public.messages(mission_id,thread_id,channel,direction,original,translation)values($1,$2,'web','inbound','Synthetic founder original','Synthetic translation')",
      [scope.missionId, thread],
    );
    const asset = randomUUID();
    await db.query(
      "insert into public.provider_assets(id,mission_id,mime_type,content_base64,payload_hash,provider_reference)values($1,$2,'image/png',$3,'synthetic-hash','synthetic-asset')",
      [asset, scope.missionId, Buffer.from('Actual synthetic byte fixture').toString('base64')],
    );
    const archive = await records(scope);
    expect(archive[0]?.kind).toBe('manifest');
    expect(archive.at(-1)?.kind).toBe('complete');
    expect(archive.filter(r => r.table === 'messages')).toMatchObject([
      { value: { original: 'Synthetic founder original', translation: 'Synthetic translation' } },
    ]);
    expect(archive.find(r => r.table === 'provider_assets')).toMatchObject({
      value: { id: asset, content_base64: Buffer.from('Actual synthetic byte fixture').toString('base64') },
    });
    expect(archive.some(r => r.table === 'knowledge')).toBe(true);
    expect(archive.some(r => r.table?.startsWith('private'))).toBe(false);
  });
  it('holds one repeatable-read snapshot across a concurrent ledger write', async () => {
    const scope = await fixture(),
      thread = randomUUID();
    await db.query('insert into public.threads(id,mission_id)values($1,$2)', [thread, scope.missionId]);
    const archive: ArchiveRecord[] = [];
    await writeMissionArchive(scope, async row => {
      archive.push(row);
      if (row.kind === 'manifest')
        await db.query(
          "insert into public.messages(mission_id,thread_id,channel,direction,original)values($1,$2,'web','inbound','Concurrent new message after snapshot')",
          [scope.missionId, thread],
        );
    });
    expect(archive.filter(r => r.table === 'messages')).toHaveLength(0);
    expect((await records(scope)).filter(r => r.table === 'messages')).toHaveLength(1);
  });
  it('denies foreign founders, arbitrary tables and agent access', async () => {
    const scope = await fixture();
    await expect(records({ ...scope, authUserId: randomUUID() })).rejects.toThrow();
    await expect(
      withRole('founder_role', scope, c => c.query("select public.mission_export_rows($1,'provider_credentials')", [scope.missionId])),
    ).rejects.toThrow(/outside scoped/);
    await expect(
      withRole('specialist_role', scope, c => c.query('select public.mission_export_tables($1)', [scope.missionId])),
    ).rejects.toThrow(/permission denied/);
  });
  it('includes scoped storage bytes and fails incomplete when storage is unavailable', async () => {
    const scope = await fixture(),
      other = await fixture(),
      id = randomUUID(),
      foreign = randomUUID();
    await db.query('alter table storage.objects add column if not exists metadata jsonb');
    await db.query("insert into storage.objects(id,bucket_id,name,metadata)values($1,'mission-files',$2,$3),($4,'mission-files',$5,$3)", [
      id,
      scope.missionId + '/attachment.bin',
      { size: 3, eTag: 'fixture1', mimetype: 'application/octet-stream' },
      foreign,
      other.missionId + '/secret.bin',
    ]);
    const partial: ArchiveRecord[] = [];
    await expect(
      writeMissionArchive(scope, async row => {
        partial.push(row);
      }),
    ).rejects.toThrow(/storage reader/);
    expect(partial.some(row => row.kind === 'complete')).toBe(false);
    const archive: ArchiveRecord[] = [];
    let requests = 0;
    await writeMissionArchive(
      scope,
      async row => {
        archive.push(row);
      },
      undefined,
      async file => {
        requests++;
        expect(file.name).toBe(scope.missionId + '/attachment.bin');
        return new Response('abc', { headers: { etag: '"fixture1"', 'content-length': '3' } });
      },
    );
    expect(requests).toBe(1);
    expect(archive.find(row => row.kind === 'file_chunk')).toMatchObject({ value: { id, data: 'YWJj' } });
    expect(archive.at(-1)?.kind).toBe('complete');
    expect(JSON.stringify(archive)).not.toContain('secret.bin');
    await expect(
      withRole('specialist_role', scope, c => c.query('select public.mission_export_files($1)', [scope.missionId])),
    ).rejects.toThrow(/permission denied/);
  });
  it('emits parseable NDJSON and cancels without keeping the snapshot transaction open', async () => {
    const scope = await fixture(),
      reader = missionArchiveStream(scope).getReader();
    const first = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(first.value))).toMatchObject({ kind: 'manifest' });
    await reader.cancel();
    await closeDatabasePools();
    const states = await db.query(
      "select state from pg_stat_activity where datname=$1 and application_name='launch-operator:founder_role'and state='idle in transaction'",
      [name],
    );
    expect(states.rows).toHaveLength(0);
    const stream = missionArchiveStream(scope),
      response = new Response(stream),
      lines = (await response.text())
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { kind: string });
    expect(lines.at(-1)?.kind).toBe('complete');
  });
});
