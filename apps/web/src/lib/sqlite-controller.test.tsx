// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { perfumeMission, MISSIONS } from '../../tests/ui/fixtures/missions.fixture';
import { useMissionController } from './useMissionController';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), client: vi.fn(), stream: vi.fn() }));
vi.mock('./session-client', () => ({ sessionFetch: mocks.fetch, renewSession: vi.fn(), tokenRefreshDelay: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.client }));
vi.mock('./message-stream-client', () => ({ consumeMessageStream: mocks.stream }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('SQLite workspace transport', () => {
  it('polls scoped snapshots and commits ordinary commands without opening Supabase, SSE or presence transports', async () => {
    let version = 100;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url === '/api/commands') {
        version++;
        return new Response(JSON.stringify({ ok: true, ledgerVersion: version }));
      }
      return new Response(
        JSON.stringify(url === '/api/missions' ? { missions: MISSIONS } : { view: { ...perfumeMission(), ledgerVersion: version } }),
      );
    });
    const hook = renderHook(() =>
      useMissionController({
        initialView: perfumeMission(),
        initialMissions: MISSIONS,
        local: true,
        localBackend: 'sqlite',
        localAi: 'simulated',
      }),
    );
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    await act(async () => {
      await hook.result.current.commands.sendMessage({
        missionId: 'm1',
        idempotencyKey: 'sqlite-message-attempt',
        seenLedgerVersion: 100,
        text: 'A local testing question',
      });
    });
    expect(hook.result.current.view.ledgerVersion).toBe(101);
    expect(mocks.fetch).toHaveBeenCalledWith('/api/commands', expect.objectContaining({ method: 'POST' }));
    expect(mocks.fetch.mock.calls.some(([url]) => /stream|presence|realtime/.test(String(url)))).toBe(false);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});
