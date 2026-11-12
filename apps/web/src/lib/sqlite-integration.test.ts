import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeLocalStores, LOCAL_TEST_AUTH_USER_ID } from '@lo/runtime/local';
import { listMissionIds, readSnapshot } from './snapshot';
import { projectMission } from './projection';
import validateMissionView from './mission-view-validator';
const actor = vi.hoisted(() => ({ user: '00000000-0000-4000-8000-000000000001' as string | null, after: vi.fn(), pg: vi.fn() }));
vi.mock('./auth', () => ({
  currentActor: async () => (actor.user ? { authUserId: actor.user, local: true } : null),
  sameOrigin: (request: Request) => request.headers.get('origin') === 'http://127.0.0.1:3100',
}));
vi.mock('next/server', () => ({ after: actor.after }));
vi.mock('@lo/runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('@lo/runtime')>()),
  withRole: actor.pg.mockImplementation(() => {
    throw new Error('PostgreSQL must never be called in the SQLite variant');
  }),
}));
import { POST as command } from '../app/api/commands/route';
import { POST as create } from '../app/api/missions/create/route';
import { GET as list } from '../app/api/missions/route';
import { GET as get } from '../app/api/missions/[missionId]/route';
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'operator-web-sqlite-'));
  vi.stubEnv('LO_STORAGE_BACKEND', 'sqlite');
  vi.stubEnv('LO_EXECUTION_MODE', 'local');
  vi.stubEnv('LO_LOCAL_AI', 'simulated');
  vi.stubEnv('LO_SQLITE_PATH', join(directory, 'test.sqlite'));
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('SUPABASE_URL', '');
});
afterAll(async () => {
  closeLocalStores();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const request = (body: unknown) =>
  new Request('http://127.0.0.1:3100/api/commands', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:3100', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('real isolated SQLite → existing web routes/projection', () => {
  it('projects both seeded six-outcome workspaces through the full UI contract with no provider receipts', async () => {
    const ids = await listMissionIds(LOCAL_TEST_AUTH_USER_ID);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const snapshot = await readSnapshot(LOCAL_TEST_AUTH_USER_ID, id),
        view = projectMission(snapshot);
      expect(validateMissionView(view)).toBe(true);
      expect(view.sandbox).toBe(true);
      expect(view.readiness.outcomes).toHaveLength(6);
      expect(Object.keys(view.artifacts).length).toBeGreaterThan(0);
      expect(Object.keys(view.decisions).length).toBeGreaterThan(0);
      expect(snapshot.provider_receipts).toEqual([]);
      expect((await get(new Request('http://127.0.0.1:3100'), { params: Promise.resolve({ missionId: id }) })).status).toBe(200);
    }
    expect((await list()).status).toBe(200);
    expect(actor.pg).not.toHaveBeenCalled();
  });
  it('creates a real local mission, pauses/replays and resumes through existing authenticated command routes without an outbox', async () => {
    const response = await create(request({ kind: 'createMission', idempotencyKey: 'sqlite-web-create-attempt' }));
    expect(response.status).toBe(200);
    const created = await response.json();
    const input = {
      kind: 'setMissionStatus',
      missionId: created.missionId,
      idempotencyKey: 'sqlite-web-pause-attempt',
      seenLedgerVersion: created.ledgerVersion,
      status: 'paused',
    };
    const paused = await command(request(input));
    expect(paused.status).toBe(200);
    const receipt = await paused.json();
    expect(receipt.ok).toBe(true);
    expect(await (await command(request(input))).json()).toEqual(receipt);
    expect(projectMission(await readSnapshot(LOCAL_TEST_AUTH_USER_ID, created.missionId)).status).toBe('paused');
    const resumed = await command(
      request({ ...input, idempotencyKey: 'sqlite-web-resume-attempt', seenLedgerVersion: receipt.ledgerVersion, status: 'active' }),
    );
    expect(resumed.status).toBe(200);
    const unsupported = await command(
      request({
        kind: 'setTraceRetention',
        missionId: created.missionId,
        idempotencyKey: 'sqlite-web-unsupported-attempt',
        seenLedgerVersion: (await resumed.json()).ledgerVersion,
        enabled: true,
      }),
    );
    expect(unsupported.status).toBe(503);
    expect(await unsupported.json()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(actor.after).not.toHaveBeenCalled();
    expect(actor.pg).not.toHaveBeenCalled();
  });
  it('requires authentication and origin checks before a local command', async () => {
    actor.user = null;
    expect((await list()).status).toBe(401);
    expect((await create(request({ kind: 'createMission', idempotencyKey: 'sqlite-no-auth-attempt' }))).status).toBe(401);
    actor.user = LOCAL_TEST_AUTH_USER_ID;
    expect(
      (await command(new Request('http://127.0.0.1:3100/api/commands', { method: 'POST', headers: { Origin: 'https://foreign.example' } })))
        .status,
    ).toBe(403);
  });
});
