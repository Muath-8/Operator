import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from './database.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const admin = new Client({ connectionString: adminUrl }),
  name = `lo_message_stream_${Date.now()}`;
let db: Client;
const prior = { ...process.env };
const user = '00000000-0000-4000-8000-000000000001',
  mission = '20000000-0000-4000-8000-000000000001',
  scope = { authUserId: user, missionId: mission };
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
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
  process.env.DATABASE_URL = url.href;
  process.env.LO_EXECUTION_MODE = 'local';
  process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
  process.env.PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
});

import { readMessageDrafts } from './message-stream.js';
describe('ephemeral stream ownership and recovery', () => {
  let run: string;
  it('accepts only scoped Lead runs and monotonically replaces actual attempt text', async () => {
    run = randomUUID();
    await db.query(
      "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier,status)values($1,$2,'lead','{}','synthetic','frontier','running')",
      [run, mission],
    );
    for (const [seq, text] of [
      [0, 'Draft'],
      [1, 'Draft now'],
      [0, 'Old'],
    ])
      await withRole('lead_role', scope, d =>
        d.query('select public.publish_agent_message_stream($1,$2,$3,$4,$5)', [mission, run, 'attempt-a', seq, text]),
      );
    expect(await readMessageDrafts(scope)).toEqual([expect.objectContaining({ runId: run, sequence: 1, text: 'Draft now' })]);
    await withRole('lead_role', scope, d =>
      d.query('select public.publish_agent_message_stream($1,$2,$3,0,$4)', [mission, run, 'attempt-b', 'New attempt']),
    );
    expect((await readMessageDrafts(scope))[0]?.text).toBe('New attempt');
  });
  it('denies foreign reading, founder writing and non-Lead publication', async () => {
    await expect(readMessageDrafts({ authUserId: randomUUID(), missionId: mission })).rejects.toThrow(/mission denied/);
    await expect(
      withRole('founder_role', scope, d =>
        d.query('select public.publish_agent_message_stream($1,$2,$3,2,$4)', [mission, run, 'attempt-b', 'Forged']),
      ),
    ).rejects.toThrow(/permission denied/);
    const specialist = randomUUID();
    await db.query(
      "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier,status)values($1,$2,'research','{}','synthetic','small','running')",
      [specialist, mission],
    );
    await expect(
      withRole('lead_role', scope, d =>
        d.query('select public.publish_agent_message_stream($1,$2,$3,0,$4)', [mission, specialist, 'attempt', 'wrong role']),
      ),
    ).rejects.toThrow(/invalid draft/);
  });
  it('expires interrupted drafts and clears completion without a conversation or receipt write', async () => {
    const before = (await db.query('select count(*)::int n from public.messages where mission_id=$1', [mission])).rows[0]?.n;
    await db.query("update public.agent_message_streams set expires_at=clock_timestamp()-interval'1 second'where run_id=$1", [run]);
    expect(await readMessageDrafts(scope)).toEqual([]);
    await withRole('lead_role', scope, d => d.query('select public.clear_agent_message_stream($1,$2)', [mission, run]));
    expect((await db.query('select from public.agent_message_streams where run_id=$1', [run])).rowCount).toBe(0);
    expect((await db.query('select count(*)::int n from public.messages where mission_id=$1', [mission])).rows[0]?.n).toBe(before);
  });
});
