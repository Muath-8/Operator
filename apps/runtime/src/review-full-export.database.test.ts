import { readMissionPrivacy } from './privacy.js';
import { writeMissionArchive, missionArchiveStream, type ArchiveRecord } from './full-export.js';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
const identity = vi.hoisted(() => ({ user: null as string | null }));
vi.mock('../../web/src/lib/auth', () => ({
  currentActor: async () => (identity.user ? { authUserId: identity.user, local: true } : null),
}));
import { GET as archiveRoute } from '../../web/src/app/api/missions/[missionId]/archive/route';
import { GET as privacyRoute } from '../../web/src/app/api/missions/[missionId]/privacy/route';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = 'lo_review_archive_' + Date.now(),
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

describe('independent complete archive and privacy boundaries', () => {
  it('redacts structured credential variants while preserving durable authorization references', async () => {
    const scope = await fixture();
    await withRole('founder_role', scope, c =>
      c.query(
        "select public.append_evidence($1,'commerce','document','founder_confirmed',$2,'document','Synthetic structured credential source')",
        [
          scope.missionId,
          {
            clientSecret: 'SYNTHETIC-CLIENT-SECRET',
            sessionCookie: 'SYNTHETIC-SESSION-COOKIE',
            'api-key': 'SYNTHETIC-API-KEY',
            authorization_id: 'durable-business-reference',
          },
        ],
      ),
    );
    const result = await records(scope),
      serialized = JSON.stringify(result);
    for (const secret of ['SYNTHETIC-CLIENT-SECRET', 'SYNTHETIC-SESSION-COOKIE', 'SYNTHETIC-API-KEY'])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain('durable-business-reference');
  });
  it('does not export private credential references through otherwise public voice metadata', async () => {
    const scope = await fixture(),
      party = randomUUID(),
      session = randomUUID(),
      refs = [randomUUID(), randomUUID()];
    await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'supplier','Synthetic archive contact')", [
      party,
      founder,
    ]);
    for (const [i, provider] of ['twilio', 'openai'].entries()) {
      const account = randomUUID();
      await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,$3,'connected','{}')", [
        account,
        founder,
        provider,
      ]);
      await db.query(
        'insert into private.provider_credentials(ref,mission_id,account_id,provider,sandbox_mode,encrypted)values($1,$2,$3,$4,true,\'{"fixture":"no provider secret"}\')',
        [refs[i], scope.missionId, account, provider],
      );
    }
    await db.query(
      "insert into public.voice_sessions(id,mission_id,task_id,counterparty_id,twilio_ref,openai_ref,language,disclosure,recording_consent,bounds)values($1,$2,$3,$4,$5,$6,'en','Synthetic archive disclosure',false,'{}')",
      [session, scope.missionId, randomUUID(), party, ...refs],
    );
    const result = await records(scope),
      serialized = JSON.stringify(result);
    expect(result.some(row => row.table === 'voice_sessions')).toBe(true);
    for (const ref of refs) expect(serialized).not.toContain(ref);
  });
  it('cancels a database-blocked archive before the unrelated table lock is released', async () => {
    const scope = await fixture(),
      locker = new Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    await locker.query('begin');
    await locker.query('lock table public.messages in access exclusive mode');
    const abort = new AbortController();
    let settled = false;
    const archive = writeMissionArchive(scope, async () => {}, abort.signal).catch(error => {
      settled = true;
      return error;
    });
    let blocked = false;
    try {
      for (let n = 0; n < 100; n++) {
        const result = await db.query(
          "select from pg_stat_activity where datname=$1 and application_name='launch-operator:founder_role'and wait_event_type='Lock'",
          [name],
        );
        if (result.rowCount) {
          blocked = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      abort.abort();
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(settled).toBe(true);
      expect(
        (
          await db.query(
            "select from pg_stat_activity where datname=$1 and application_name='launch-operator:founder_role'and state in('active','idle in transaction')",
            [name],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await locker.query('rollback');
      await locker.end();
      await archive;
    }
  });
  it('never exports expired or opted-out raw payloads and exposes only their metadata in privacy', async () => {
    const scope = await fixture(),
      id = randomUUID();
    await db.query(
      "insert into public.retention_objects(id,mission_id,kind,source_reference,payload_hash,byte_length,expires_at)values($1,$2,'trace','synthetic-expired',repeat('0',64),1,clock_timestamp()-interval'1 day')",
      [id, scope.missionId],
    );
    await db.query('insert into private.retention_payloads(object_id,payload)values($1,\'{"sensitiveRaw":"SYNTHETIC-EXPIRED-RAW"}\')', [
      id,
    ]);
    expect(JSON.stringify(await records(scope))).not.toContain('SYNTHETIC-EXPIRED-RAW');
    expect(await readMissionPrivacy(scope)).toMatchObject({ retentionDays: 90, objects: [{ id, available: false }] });
    await expect(readMissionPrivacy({ ...scope, authUserId: randomUUID() })).rejects.toThrow();
  });
  it('honors consumer backpressure and releases its snapshot when that consumer cancels', async () => {
    const scope = await fixture(),
      reader = missionArchiveStream(scope).getReader();
    expect(JSON.parse(new TextDecoder().decode((await reader.read()).value))).toMatchObject({ kind: 'manifest' });
    await reader.cancel();
    let held = true;
    for (let n = 0; n < 100; n++) {
      held = Boolean(
        (
          await db.query(
            "select from pg_stat_activity where datname=$1 and application_name='launch-operator:founder_role'and state='idle in transaction'",
            [name],
          )
        ).rowCount,
      );
      if (!held) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(held).toBe(false);
  });
  it('preserves a large source asset exactly while excluding another founder mission', async () => {
    const scope = await fixture(),
      bytes = Buffer.alloc(5_000_000, 7),
      encoded = bytes.toString('base64'),
      id = randomUUID();
    await db.query(
      "insert into public.provider_assets(id,mission_id,mime_type,content_base64,payload_hash,provider_reference)values($1,$2,'image/png',$3,'synthetic-large-source','synthetic-large-source')",
      [id, scope.missionId, encoded],
    );
    const foreignFounder = randomUUID(),
      foreignMission = randomUUID();
    await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [foreignFounder, randomUUID()]);
    await db.query(
      "insert into public.missions(id,founder_id,type,goal_brief,currency,sandbox_mode)values($1,$2,'launch','FOREIGN-ARCHIVE-SOURCE','SAR',true)",
      [foreignMission, foreignFounder],
    );
    let seen = false;
    await writeMissionArchive(scope, async row => {
      expect(JSON.stringify(row)).not.toContain('FOREIGN-ARCHIVE-SOURCE');
      if (row.table === 'provider_assets') {
        expect(row.value).toMatchObject({ id, content_base64: encoded });
        seen = true;
      }
    });
    expect(seen).toBe(true);
    await expect(records({ authUserId: user, missionId: foreignMission })).rejects.toThrow();
  });
  it('serves owner-only private archive and metadata routes without exposing raw content in privacy', async () => {
    const scope = await fixture(),
      context = { params: Promise.resolve({ missionId: String(scope.missionId) }) },
      request = new Request('http://127.0.0.1:3000');
    identity.user = null;
    expect((await archiveRoute(request, context)).status).toBe(401);
    expect((await privacyRoute(request, context)).status).toBe(401);
    identity.user = randomUUID();
    expect((await archiveRoute(request, context)).status).toBe(404);
    expect((await privacyRoute(request, context)).status).toBe(404);
    identity.user = user;
    await withRole('policy_role', scope, c =>
      c.query(
        "select public.store_retained_content($1,'trace','synthetic-owner-route','{\"original\":\"SYNTHETIC-PRIVATE-BODY\"}',null,true)",
        [scope.missionId],
      ),
    );
    const privacy = await privacyRoute(request, context);
    expect(privacy.status).toBe(200);
    expect(privacy.headers.get('cache-control')).toBe('private, no-store');
    expect(await privacy.text()).not.toContain('SYNTHETIC-PRIVATE-BODY');
    const archive = await archiveRoute(request, context);
    expect(archive.status).toBe(200);
    expect(archive.headers.get('content-type')).toContain('application/x-ndjson');
    expect(archive.headers.get('content-disposition')).toContain('attachment;');
    expect(archive.headers.get('x-content-type-options')).toBe('nosniff');
    const rows = (await archive.text())
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string });
    expect(rows[0]?.kind).toBe('manifest');
    expect(rows.at(-1)?.kind).toBe('complete');
    expect(JSON.stringify(rows)).toContain('SYNTHETIC-PRIVATE-BODY');
  });
});
