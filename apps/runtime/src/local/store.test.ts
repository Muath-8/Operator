import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  listLocalMissionIds,
  readLocalSnapshot,
  createLocalMission,
  executeLocalCommand,
  closeLocalStores,
  LOCAL_TEST_AUTH_USER_ID,
} from './index.js';
import { JsonObjectSchema } from '@lo/state';
let directory: string;
const prior = { ...process.env },
  user = LOCAL_TEST_AUTH_USER_ID;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lo-sqlite-local-'));
  process.env = {
    ...prior,
    LO_STORAGE_BACKEND: 'sqlite',
    LO_EXECUTION_MODE: 'local',
    LO_LOCAL_AI: 'simulated',
    LO_SQLITE_PATH: join(directory, 'operator.sqlite'),
    DATABASE_URL: undefined,
    DATABASE_FOUNDER_URL: undefined,
    DATABASE_LEAD_URL: undefined,
    DATABASE_POLICY_URL: undefined,
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    OPENAI_API_KEY: undefined,
    NODE_ENV: 'test',
  };
});
afterEach(async () => {
  closeLocalStores();
  process.env = prior;
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const command = (missionId: string, ledgerVersion: number, kind: string, extra: Record<string, unknown> = {}) => ({
  missionId,
  idempotencyKey: randomUUID(),
  seenLedgerVersion: ledgerVersion,
  kind,
  ...extra,
});
describe('isolated local SQLite testing without PostgreSQL/provider keys', () => {
  it('seeds two simulation-labelled missions durably and isolates different users', async () => {
    const ids = await listLocalMissionIds(user);
    expect(ids).toHaveLength(2);
    const snapshot = await readLocalSnapshot(user, String(ids[0]));
    expect(JsonObjectSchema.parse(snapshot.mission).sandbox_mode).toBe(true);
    expect(JSON.stringify(snapshot)).toContain('Local simulation');
    expect(snapshot.provider_receipts).toEqual([]);
    expect(snapshot.payments).toEqual([]);
    closeLocalStores();
    expect(await listLocalMissionIds(user)).toEqual(ids);
    const foreign = randomUUID(),
      others = await listLocalMissionIds(foreign);
    expect(others.some(id => ids.includes(id))).toBe(false);
    await expect(readLocalSnapshot(foreign, String(ids[0]))).rejects.toThrow(/unavailable for this user/);
  });
  it('creates missions idempotently and rejects a reused creation identity with changed content', async () => {
    const input = { idempotencyKey: randomUUID(), title: 'A local idea', goalBrief: 'Explore a reusable product' };
    const first = await createLocalMission(user, input);
    expect(await createLocalMission(user, input)).toEqual(first);
    await expect(createLocalMission(user, { ...input, title: 'Different' })).rejects.toThrow(/identity/);
    expect(JsonObjectSchema.parse((await readLocalSnapshot(user, first.missionId)).mission).goal_brief).toBe(input.goalBrief);
  });
  it('atomically approves a seeded sample choice once without moving money or making a receipt', async () => {
    const missionId = String((await listLocalMissionIds(user))[0]),
      snapshot = await readLocalSnapshot(user, missionId),
      decision = JsonObjectSchema.array()
        .parse(snapshot.decisions)
        .find(row => row.gate === 'demo_sample');
    if (!decision) throw new Error('Expected actual seeded sample decision');
    const input = command(missionId, Number(snapshot.ledger_version), 'resolveDecision', {
        decisionId: decision.id,
        response: 'approve',
        optionId: 'approve',
      }),
      results = await Promise.all([executeLocalCommand(user, input), executeLocalCommand(user, input)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.ok).toBe(true);
    const saved = await readLocalSnapshot(user, missionId);
    expect(
      JsonObjectSchema.array()
        .parse(saved.decision_resolutions)
        .filter(row => row.decision_id === decision.id),
    ).toHaveLength(1);
    expect(saved.provider_receipts).toEqual([]);
    expect(saved.money_ledger).toEqual([]);
    expect(saved.payments).toEqual([]);
    expect(JSON.stringify(saved.messages)).toContain('No supplier message, payment');
    expect(await executeLocalCommand(user, { ...input, optionId: 'different' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });
  it('persists pause/resume, rejects stale revisions and cannot mutate a foreign mission', async () => {
    const id = String((await listLocalMissionIds(user))[0]),
      s = await readLocalSnapshot(user, id),
      pause = command(id, Number(s.ledger_version), 'setMissionStatus', { status: 'paused' }),
      result = await executeLocalCommand(user, pause);
    expect(result.ok).toBe(true);
    expect((await readLocalSnapshot(user, id)).status).toBe('paused');
    expect(await executeLocalCommand(user, command(id, Number(s.ledger_version), 'setMissionStatus', { status: 'active' }))).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    if (!result.ok) throw new Error('Expected local pause');
    expect((await executeLocalCommand(user, command(id, result.ledgerVersion, 'setMissionStatus', { status: 'active' }))).ok).toBe(true);
    expect(await executeLocalCommand(randomUUID(), pause)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
  it('saves chat and a labelled simulated reply once, with no live service configuration', async () => {
    const id = String((await listLocalMissionIds(user))[0]),
      s = await readLocalSnapshot(user, id),
      input = command(id, Number(s.ledger_version), 'sendMessage', { text: 'Help me compare these illustrative options' }),
      first = await executeLocalCommand(user, input);
    expect(first.ok).toBe(true);
    expect(await executeLocalCommand(user, input)).toEqual(first);
    closeLocalStores();
    const snapshot = await readLocalSnapshot(user, id),
      messages = JsonObjectSchema.array().parse(snapshot.messages);
    expect(
      messages.filter(row => row.direction === 'founder' && row.original === 'Help me compare these illustrative options'),
    ).toHaveLength(1);
    expect(
      messages.some(row => row.local_reply_source === 'simulated' && String(row.original).startsWith('Simulated local assistant:')),
    ).toBe(true);
  });
  it('prevents concurrent duplicate chat generation and blocks new approvals while paused', async () => {
    const id = String((await listLocalMissionIds(user))[0]),
      snapshot = await readLocalSnapshot(user, id),
      chat = command(id, Number(snapshot.ledger_version), 'sendMessage', { text: 'One concurrent local message' }),
      results = await Promise.all([executeLocalCommand(user, chat), executeLocalCommand(user, chat)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    const current = await readLocalSnapshot(user, id),
      paused = await executeLocalCommand(user, command(id, Number(current.ledger_version), 'setMissionStatus', { status: 'paused' }));
    if (!paused.ok) throw new Error('Expected local pause');
    const decision = JsonObjectSchema.array().parse(current.decisions)[0];
    if (!decision) throw new Error('Expected seeded decision');
    expect(
      await executeLocalCommand(
        user,
        command(id, paused.ledgerVersion, 'resolveDecision', { decisionId: decision.id, response: 'approve', optionId: 'quiet' }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const version = JsonObjectSchema.array().parse(current.artifact_versions)[0];
    if (!version) throw new Error('Expected seeded draft');
    expect(
      await executeLocalCommand(
        user,
        command(id, paused.ledgerVersion, 'approveDraft', { draftId: version.id, artifactId: version.artifact_id }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const messages = JsonObjectSchema.array().parse((await readLocalSnapshot(user, id)).messages);
    expect(messages.filter(message => message.direction === 'founder' && message.original === 'One concurrent local message')).toHaveLength(
      1,
    );
  });
  it('rejects unsupported actions and mismatched draft references without claiming completion', async () => {
    const id = String((await listLocalMissionIds(user))[0]),
      s = await readLocalSnapshot(user, id);
    expect(await executeLocalCommand(user, command(id, Number(s.ledger_version), 'retryStep', { stepId: randomUUID() }))).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(
      await executeLocalCommand(
        user,
        command(id, Number(s.ledger_version), 'discardDraft', { draftId: randomUUID(), artifactId: randomUUID() }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect((await readLocalSnapshot(user, id)).ledger_version).toBe(s.ledger_version);
  });
  it('refuses SQLite access in production or without the explicit backend switch', async () => {
    process.env = { ...process.env, NODE_ENV: 'production' };
    await expect(listLocalMissionIds(user)).rejects.toThrow(/nonproduction local mode/);
    process.env = { ...process.env, NODE_ENV: 'test', LO_STORAGE_BACKEND: 'postgres' };
    await expect(listLocalMissionIds(user)).rejects.toThrow(/nonproduction local mode/);
  });
});
