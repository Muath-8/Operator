import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools, type ActorScope } from './database.js';
import { executeFounderCommand, ledgerVersion } from './commands.js';
import { readMissionPrivacy } from './privacy.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = 'lo_commands_' + Date.now(),
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

async function command(scope: ActorScope, fields: Record<string, unknown>, idempotencyKey = randomUUID()) {
  const seenLedgerVersion = await withRole('founder_role', scope, c => ledgerVersion(c, z.uuid().parse(scope.missionId)));
  return executeFounderCommand(scope.authUserId, { missionId: scope.missionId, idempotencyKey, seenLedgerVersion, ...fields });
}
async function artifact(scope: ActorScope) {
  return withRole('specialist_role', scope, async c => {
    const id = String(
        (await c.query("select public.create_artifact($1,'brief','brand','Synthetic scoped draft')id", [scope.missionId])).rows[0].id,
      ),
      version = String(
        (await c.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, id, { text: 'Synthetic review draft' }]))
          .rows[0].id,
      );
    await c.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, version]);
    return { id, version };
  });
}
describe('founder commands commit real scoped ledger behavior', () => {
  it('FR-MIS-01 FR-COM-01 records contextual founder text once and rejects changed replay or foreign context', async () => {
    const scope = await fixture();
    await db.query('insert into public.threads(mission_id)values($1)', [scope.missionId]);
    const own = await artifact(scope),
      other = await artifact(await fixture()),
      key = randomUUID();
    const fields = {
      kind: 'sendMessage',
      text: 'Synthetic scoped founder request',
      context: { artifactId: own.id, versionId: own.version, point: { x: 0.2, y: 0.8 } },
    };
    // Replay the exact immutable request including the original seen revision.
    const seen = await withRole('founder_role', scope, c => ledgerVersion(c, z.uuid().parse(scope.missionId))),
      raw = { missionId: scope.missionId, idempotencyKey: key, seenLedgerVersion: seen, ...fields };
    await executeFounderCommand(scope.authUserId, raw);
    await executeFounderCommand(scope.authUserId, raw);
    expect((await db.query('select original from public.messages where mission_id=$1', [scope.missionId])).rows).toEqual([
      { original: fields.text },
    ]);
    expect(
      (await db.query("select value from public.founder_preferences where mission_id=$1 and kind='message_context'", [scope.missionId]))
        .rows[0].value,
    ).toMatchObject(fields.context);
    await expect(executeFounderCommand(scope.authUserId, { ...raw, text: 'Changed replay' })).rejects.toThrow();
    await expect(command(scope, { ...fields, context: { artifactId: other.id } })).rejects.toThrow(/context not found/);
  });
  it('FR-ACC-05 persists trace and keep choices without exposing raw text', async () => {
    const scope = await fixture();
    await command(scope, { kind: 'setTraceRetention', enabled: true });
    const traceId = await withRole('policy_role', scope, async c =>
      String(
        (
          await c.query("select public.store_retained_content($1,'trace','synthetic:command-privacy',$2,null,true)id", [
            scope.missionId,
            { text: 'Sensitive synthetic raw text' },
          ])
        ).rows[0].id,
      ),
    );
    await expect(command(scope, { kind: 'keepRetainedContent', objectId: traceId, keep: true })).rejects.toThrow(/scoped retained/);
    // Synthetic already-consented transcript payload fixture; this test asserts
    // founder retention commands, not a real voice/provider recording receipt.
    const objectId = randomUUID();
    await db.query(
      "insert into public.retention_objects(id,mission_id,kind,source_reference,payload_hash,byte_length)values($1,$2,'transcript','synthetic:consented-transcript',repeat('0',64),30)",
      [objectId, scope.missionId],
    );
    await db.query('insert into private.retention_payloads(object_id,payload)values($1,$2)', [
      objectId,
      { text: 'Sensitive synthetic raw text' },
    ]);
    await command(scope, { kind: 'keepRetainedContent', objectId, keep: true });
    expect((await readMissionPrivacy(scope)).objects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: objectId, kept: true })]),
    );
    await command(scope, { kind: 'keepRetainedContent', objectId, keep: false });
    await command(scope, { kind: 'setTraceRetention', enabled: false });
    const privacy = await readMissionPrivacy(scope);
    expect(privacy.traceRetentionEnabled).toBe(false);
    expect(JSON.stringify(privacy)).not.toContain('Sensitive synthetic raw text');
    await expect(command(await fixture(), { kind: 'keepRetainedContent', objectId, keep: true })).rejects.toThrow();
  });
  it('FR-NOT-01 records notification cadence, read acknowledgements and target help preference', async () => {
    const scope = await fixture(),
      notificationIds = [randomUUID()];
    await command(scope, {
      kind: 'updateNotificationSettings',
      settings: { momentsPerWeek: 2, digestCadence: 'weekly', quietHours: { from: '22:00', to: '07:00' } },
    });
    await command(scope, { kind: 'markNotificationsRead', notificationIds });
    await command(scope, { kind: 'setHelpMode', control: { targetId: randomUUID(), targetKind: 'thread' }, mode: 'guide' });
    const preferences = (await db.query('select kind,value from public.founder_preferences where mission_id=$1', [scope.missionId])).rows;
    expect(preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'notifications', value: expect.objectContaining({ momentsPerWeek: 2 }) }),
        { kind: 'notifications_read', value: notificationIds },
        expect.objectContaining({ kind: 'help_mode', value: expect.objectContaining({ mode: 'guide' }) }),
      ]),
    );
  });
  it('FR-ART-01 rejects mismatched draft/artifact before changing either immutable version', async () => {
    const scope = await fixture(),
      first = await artifact(scope),
      second = await artifact(scope);
    await expect(command(scope, { kind: 'discardDraft', artifactId: first.id, draftId: second.version })).rejects.toThrow(
      /not in this artifact/,
    );
    expect(
      (
        await db.query(
          'select status from public.artifact_statuses where mission_id=$1 and artifact_version_id=$2 order by created_at desc,id desc limit 1',
          [scope.missionId, second.version],
        )
      ).rows[0].status,
    ).toBe('proposed');
    await command(scope, { kind: 'discardDraft', artifactId: second.id, draftId: second.version });
    expect(
      (
        await db.query(
          'select status from public.artifact_statuses where mission_id=$1 and artifact_version_id=$2 order by created_at desc,id desc limit 1',
          [scope.missionId, second.version],
        )
      ).rows[0].status,
    ).toBe('rejected');
  });
  it('queues variation/action/retry requests without fabricating completion and returns scoped export locations', async () => {
    const scope = await fixture(),
      source = await artifact(scope);
    for (const fields of [
      {
        kind: 'requestVariation',
        artifactId: source.id,
        frameId: 'frame',
        versionId: source.version,
        request: 'Please change the synthetic wording',
      },
      { kind: 'runArtifactAction', artifactId: source.id, actionId: 'draft-revision' },
      { kind: 'retryStep', stepId: randomUUID() },
    ])
      await command(scope, fields);
    expect(
      (
        await db.query("select value->>'status' status from public.founder_preferences where mission_id=$1 and kind='agent_request'", [
          scope.missionId,
        ])
      ).rows,
    ).toEqual([{ status: 'queued' }, { status: 'queued' }, { status: 'queued' }]);
    expect((await db.query('select count(*)::int n from public.provider_receipts where mission_id=$1', [scope.missionId])).rows[0].n).toBe(
      0,
    );
    for (const format of ['json', 'markdown', 'pdf', 'zip'])
      expect(await command(scope, { kind: 'exportLaunchRecord', format })).toMatchObject({
        downloadUrl: `/api/missions/${scope.missionId}/export?format=${format}`,
      });
  });
});
