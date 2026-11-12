import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { executeFounderCommand, ledgerVersion } from './commands.js';
import { closeDatabasePools, withRole } from './database.js';
import { missionTick, type EngineServices } from './engine.js';
import { createCoreTools } from './core-tools.js';
import { TaskBriefSchema } from './contracts.js';
import { buildLaunchRecord } from './export.js';
import { closeDemandPool, publishDemandPage, readValidationPage, recordWaitlistSignup } from './demand.js';
import { writeMissionArchive, type ArchiveRecord } from './full-export.js';
import { ProviderStorage } from './provider-storage.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const name = `lo_runtime_${Date.now()}`;
const admin = new Client({ connectionString: adminUrl });
let db: Client;
const user = '00000000-0000-4000-8000-000000000001',
  mission = '20000000-0000-4000-8000-000000000001';
const priorEnv = { ...process.env };
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
  await closeDemandPool();
  process.env = priorEnv;
  await db?.end();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
});
const scope = { authUserId: user, missionId: mission };
const version = () => withRole('founder_role', scope, d => ledgerVersion(d, mission));
const createApproved = async (content: Record<string, unknown>, gate: string, type = 'validation') => {
  const versionId = await withRole('specialist_role', scope, async d => {
    const artifact = (await d.query("select public.create_artifact($1,$2,'demand','Validation setup') as id", [mission, type])).rows[0]?.id;
    const v = (await d.query('select public.append_artifact_version($1,$2,$3) as id', [mission, artifact, content])).rows[0]?.id as string;
    await d.query("select public.set_artifact_status($1,$2,'proposed')", [mission, v]);
    return v;
  });
  const packet = {
    question: 'Approve this exact setup',
    options: [
      {
        id: 'approve',
        label: 'Approve',
        evidenceIds: [],
        artifactVersionIds: [versionId],
        cost: null,
        timeDays: 0,
        consequences: 'Publish only this approved version',
      },
    ],
    recommendation: { optionId: 'approve', reasons: ['Review this exact version'] },
    approvedVersionIds: [versionId],
    staleImpact: [],
    defaultIfNoAnswer: { optionId: 'approve', at: null, binding: true },
  };
  const decisionId = await withRole(
    'lead_role',
    scope,
    async d =>
      (await d.query("select public.propose_decision($1,'selection',$2,'demand',$3) as id", [mission, packet, gate])).rows[0]?.id as string,
  );
  await executeFounderCommand(user, {
    kind: 'resolveDecision',
    missionId: mission,
    idempotencyKey: randomUUID(),
    seenLedgerVersion: await version(),
    decisionId,
    response: 'approve',
    optionId: 'approve',
  });
  return { versionId, decisionId };
};

describe('native database runtime integration', () => {
  it('retries a founder message once and rejects changed payload with same key', async () => {
    const command = {
      kind: 'sendMessage',
      missionId: mission,
      idempotencyKey: randomUUID(),
      seenLedgerVersion: await version(),
      text: 'Please compare the terms.',
    };
    const first = await executeFounderCommand(user, command);
    const second = await executeFounderCommand(user, command);
    expect(first.ledgerVersion).toBe(second.ledgerVersion);
    const messages = await withRole('founder_role', scope, d =>
      d.query('select * from public.messages where mission_id=$1 and original=$2', [mission, command.text]),
    );
    expect(messages.rowCount).toBe(1);
    await expect(executeFounderCommand(user, { ...command, text: 'Changed intent' })).rejects.toThrow(/idempotency/);
  });
  it('rejects cross-tenant commands and keeps append-only runtime ledgers isolated', async () => {
    await expect(
      executeFounderCommand(randomUUID(), {
        kind: 'setMissionStatus',
        missionId: mission,
        idempotencyKey: randomUUID(),
        seenLedgerVersion: 0,
        status: 'paused',
      }),
    ).rejects.toThrow();
    const tables = ['command_requests', 'command_results', 'run_results', 'runtime_ticks', 'ledger_events'];
    for (const table of tables) {
      const rows = await withRole('founder_role', { authUserId: randomUUID() }, d => d.query(`select * from public.${table}`));
      expect(rows.rowCount).toBe(0);
    }
  });
  it('durably consumes a tick across engine restart without duplicated Lead messages', async () => {
    const services: EngineServices = {
      plan: async () => ({
        ok: true,
        value: {
          questions: [],
          runs: [],
          decisions: [],
          commitments: [
            {
              party: '30000000-0000-4000-8000-000000000001',
              direction: 'owed_to_us',
              description: 'Send requested specification',
              dueAt: '2026-12-01T12:00:00Z',
              evidenceIds: [],
            },
          ],
          founderMessage: 'Test Lead planned from evidence.',
          evidenceIds: [],
          focus: null,
        },
      }),
      run: async () => {
        throw new Error('No run scheduled');
      },
      review: async () => ({ accepted: false, defects: ['No review requested'] }),
      dispatch: async () => {
        throw new Error('No dispatch scheduled');
      },
    };
    const event = { id: randomUUID(), missionId: mission, authUserId: user, type: 'test.tick', payload: {} };
    const steps = { run: <T>(_id: string, work: () => Promise<T>) => work() };
    expect(await missionTick(event, steps, services)).toMatchObject({ status: 'planned' });
    await closeDatabasePools();
    expect(await missionTick(event, steps, services)).toMatchObject({ status: 'replayed' });
    const count = await withRole('founder_role', scope, d =>
      d.query('select count(*)::int n from public.messages where mission_id=$1 and original=$2', [
        mission,
        'Test Lead planned from evidence.',
      ]),
    );
    expect(count.rows[0]?.n).toBe(1);
    const commitments = await withRole('founder_role', scope, d =>
      d.query('select direction from public.commitments where mission_id=$1 and description=$2', [mission, 'Send requested specification']),
    );
    expect(commitments.rows).toEqual([{ direction: 'inbound' }]);
  });
  it('creates one new mission with one app thread across repeated creation requests', async () => {
    const key = randomUUID();
    const create = () =>
      withRole(
        'founder_role',
        { authUserId: user },
        async d => (await d.query('select public.start_mission($1,true) as id', [key])).rows[0]?.id as string,
      );
    const first = await create();
    expect(await create()).toBe(first);
    const threads = await withRole('founder_role', { authUserId: user, missionId: first }, d =>
      d.query('select id from public.threads where mission_id=$1', [first]),
    );
    expect(threads.rowCount).toBe(1);
  });
  it('does not support claims from corrected founder-confirmed evidence', async () => {
    const original = await withRole(
      'founder_role',
      scope,
      async d =>
        (
          await d.query(
            "select public.append_evidence($1,'compliance','claim_check','founder_confirmed','{}','document','founder review') as id",
            [mission],
          )
        ).rows[0]?.id as string,
    );
    await withRole('founder_role', scope, d =>
      d.query("select public.append_evidence($1,'compliance','claim_check','founder_confirmed','{}','document','correction',null,$2)", [
        mission,
        original,
      ]),
    );
    const tool = createCoreTools(scope).validate_claims;
    if (!tool) throw new Error('Tool missing');
    const task = TaskBriefSchema.parse({
      id: randomUUID(),
      missionId: mission,
      role: 'compliance',
      outcome: 'compliance',
      objective: 'Validate claim',
      constraints: [],
      budgetAuthority: [],
      deadline: '2026-12-01T00:00:00Z',
      doneCriteria: ['Source-backed'],
      evidenceRequired: ['claim_check'],
      playbook: { id: 'test', version: 1, step: 'check', source: 'https://example.test' },
      maxToolCalls: 1,
      maxTokens: 256,
      tier: 'small',
      requestedByFounder: false,
      overdueExposure: false,
      unblocks: [],
      parentRunId: null,
    });
    const reviewed = await createApproved({ prohibitedClaims: [], items: [] }, 'specification', 'compliance_checklist');
    expect(
      await tool.execute({ checklistVersionId: reviewed.versionId, claims: [{ text: 'Proposed claim', evidenceIds: [original] }] }, task),
    ).toMatchObject({ ok: true, value: [{ supported: false }] });
  });
  it('FR-PLY-08 publishes only the approved page with a prior numeric threshold and measures deduplicated protected signups', async () => {
    const threshold = await createApproved(
      { threshold: { metric: 'distinct_consented_signups', target: 1, endsAt: '2027-12-31T23:59:59Z' } },
      'validation_threshold',
    );
    const effectIntent = { action: 'marketing_publish', effectClass: 'publish', counterpartyId: '30000000-0000-4000-8000-000000000001' };
    const checklist = await createApproved({ prohibitedClaims: [], items: [] }, 'specification', 'compliance_checklist');
    const page = await createApproved(
      {
        contentReview: { checklistVersionId: checklist.versionId },
        title: 'A test validation page',
        description: 'A sandbox interest test',
        consentText: 'I consent to joining this waitlist',
        effectIntent,
      },
      'specification',
    );
    await db.query('update private.platform_controls set effects_enabled=true');
    const storage = new ProviderStorage(scope);
    const intent = await storage.buildIntent(
      randomUUID(),
      'marketing_publish',
      'publish',
      { counterpartyId: effectIntent.counterpartyId, artifactVersionId: page.versionId },
      [],
    );
    const publication = await publishDemandPage(scope, intent, page.versionId, threshold.decisionId, 'sandbox-test');
    expect(await readValidationPage('sandbox-test')).toMatchObject({ sandbox: true, title: 'A test validation page' });
    await recordWaitlistSignup({ slug: 'sandbox-test', email: 'fixture@example.test', consent: true, website: '' });
    await recordWaitlistSignup({ slug: 'sandbox-test', email: 'FIXTURE@example.test', consent: true, website: '' });
    const measurement = await withRole('policy_role', scope, d =>
      d.query('select public.measure_demand($1,$2) as report', [mission, publication.pageId]),
    );
    expect(measurement.rows[0]?.report).toMatchObject({ count: 1, target: 1, met: true, emailOwnershipVerified: false });
    const signups = await db.query('select email_hash,email_ciphertext from public.demand_signups where mission_id=$1', [mission]);
    expect(signups.rowCount).toBe(1);
    expect(JSON.stringify(signups.rows)).not.toContain('fixture@example.test');
    const archive: ArchiveRecord[] = [];
    await writeMissionArchive(scope, async row => {
      archive.push(row);
    });
    expect(archive.filter(r => r.table === 'demand_signups')).toMatchObject([
      { value: { email: 'fixture@example.test', email_ciphertext: '[REDACTED]' } },
    ]);
    expect(archive.at(-1)?.kind).toBe('complete');
    const archivedSignup = JSON.stringify(archive.filter(r => r.table === 'demand_signups'));
    expect(archivedSignup).not.toContain(String(signups.rows[0]?.email_ciphertext));
    const encryptionKey = process.env.PROVIDER_ENCRYPTION_KEY;
    process.env.PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
    const interrupted: ArchiveRecord[] = [];
    try {
      await expect(
        writeMissionArchive(scope, async row => {
          interrupted.push(row);
        }),
      ).rejects.toThrow();
      expect(interrupted.some(r => r.kind === 'complete')).toBe(false);
    } finally {
      process.env.PROVIDER_ENCRYPTION_KEY = encryptionKey;
    }

    await expect(
      withRole('specialist_role', scope, d => d.query('select public.measure_demand($1,$2)', [mission, publication.pageId])),
    ).rejects.toThrow(/permission denied/);
    const measured = await db.query(
      "select trust,payload from public.evidence where mission_id=$1 and outcome='demand' and kind='validation_result'",
      [mission],
    );
    expect(measured.rows[0]).toMatchObject({ trust: 'verified', payload: { count: 1, emailOwnershipVerified: false } });
    const vault = await db.query('select encrypted from private.approval_token_vault where mission_id=$1', [mission]);
    expect(JSON.stringify(vault.rows)).not.toContain(intent.approvalToken);
  });
  it('pause blocks a new tick before planning or dispatch', async () => {
    await executeFounderCommand(user, {
      kind: 'setMissionStatus',
      missionId: mission,
      idempotencyKey: randomUUID(),
      seenLedgerVersion: await version(),
      status: 'paused',
    });
    const forbidden = async (): Promise<never> => {
      throw new Error('Paused mission invoked model or provider');
    };
    expect(
      await missionTick(
        { id: randomUUID(), missionId: mission, authUserId: user, type: 'test.tick', payload: {} },
        { run: (_id, work) => work() },
        { plan: forbidden, run: forbidden, review: forbidden, dispatch: forbidden },
      ),
    ).toMatchObject({ status: 'paused', started: 0 });
  });
  it('FR-ACC-06 scoped confirmed erasure removes mission data while retaining founder accounts and other missions', async () => {
    const target = '20000000-0000-4000-8000-000000000002';
    const eraseScope = { authUserId: user, missionId: target };
    await expect(
      withRole('founder_role', eraseScope, d => d.query('select public.erase_mission($1,$2)', [target, randomUUID()])),
    ).rejects.toThrow(/confirmed deletion/);
    const result = await withRole('founder_role', eraseScope, async d => {
      const request = (await d.query('select public.request_mission_deletion($1) as id', [target])).rows[0]?.id;
      return d.query('select public.erase_mission($1,$2) as id', [target, request]);
    });
    expect(result.rows[0]?.id).toBeTruthy();
    const remaining = await withRole('founder_role', { authUserId: user }, d =>
      d.query('select id from public.missions where id=any($1::uuid[])', [[mission, target]]),
    );
    expect(remaining.rows).toEqual([{ id: mission }]);
    const leftovers = await db.query('select count(*)::int n from public.artifacts where mission_id=$1', [target]);
    expect(leftovers.rows[0]?.n).toBe(0);
  });
  it('FR-MIS-10 exports founder ownership and safe account refs, excludes raw message and credential records', () => {
    const record = buildLaunchRecord({
      mission: { id: mission, founder_id: 'founder' },
      founder_accounts: [{ id: 'account', provider: 'shopify', status: 'connected' }],
      messages: [{ original: 'private supplier message' }],
      provider_credentials: [{ secret: 'private' }],
    });
    expect(record.ownership).toMatchObject({ ownerFounderId: 'founder', externalAccountsRemainFounderOwned: true });
    expect(record.founder_accounts).toEqual([{ id: 'account', provider: 'shopify', status: 'connected' }]);
    expect(record.messages).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('private');
  });
});
