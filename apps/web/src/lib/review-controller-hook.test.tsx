// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useMissionController } from './useMissionController';
import { perfumeMission, MISSIONS } from '../../tests/ui/fixtures/missions.fixture';
import type { MessageDraft } from '@lo/state/stream';
import type { MissionView } from '../ui-contract';

const doubles = vi.hoisted(() => ({
  session: vi.fn(),
  renew: vi.fn(),
  delay: vi.fn(),
  createClient: vi.fn(),
  streams: [] as { missionId: string; accept: (drafts: MessageDraft[]) => void; signal: AbortSignal }[],
}));
vi.mock('./session-client', () => ({ sessionFetch: doubles.session, renewSession: doubles.renew, tokenRefreshDelay: doubles.delay }));
vi.mock('@supabase/supabase-js', () => ({ createClient: doubles.createClient }));
vi.mock('./message-stream-client', () => ({
  consumeMessageStream: async (_response: Response, missionId: string, accept: (drafts: MessageDraft[]) => void, signal: AbortSignal) => {
    doubles.streams.push({ missionId, accept, signal });
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
}));
let snapshot: MissionView;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const mount = (local = true) =>
  renderHook(() =>
    useMissionController({
      initialView: perfumeMission(),
      initialMissions: MISSIONS,
      local,
      ...(!local ? { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'test-public-key' } : {}),
    }),
  );
const base = { missionId: 'm1', idempotencyKey: 'same-intent-key', seenLedgerVersion: 100 };
beforeEach(() => {
  vi.clearAllMocks();
  doubles.streams.length = 0;
  snapshot = perfumeMission();
  localStorage.clear();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  doubles.delay.mockReturnValue(60_000);
  doubles.renew.mockResolvedValue(true);
  doubles.session.mockImplementation(async (url: string) =>
    url.endsWith('/stream')
      ? new Response()
      : url === '/api/realtime-token'
        ? json({ token: 'test-token' })
        : url === '/api/missions'
          ? json({ missions: MISSIONS })
          : json({ view: snapshot }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ missions: MISSIONS })),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('independent actual controller lifecycle', () => {
  it('keeps the last complete ledger through malformed, foreign, unsafe and older snapshots', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    for (const invalid of [
      { missionId: 'm1' },
      { ...perfumeMission(), missionId: 'foreign' },
      { ...perfumeMission(), ledgerVersion: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      doubles.session.mockImplementation(async (url: string) => (url.endsWith('/stream') ? new Response() : json({ view: invalid })));
      await act(async () => {
        window.dispatchEvent(new Event('online'));
      });
      await waitFor(() => expect(hook.result.current.connection.status).toBe('reconnecting'));
      expect(hook.result.current.view.ledgerVersion).toBe(100);
      expect(hook.result.current.view.missionId).toBe('m1');
    }
    snapshot = { ...perfumeMission(), ledgerVersion: 99 };
    doubles.session.mockImplementation(async () => json({ view: snapshot }));
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    expect(hook.result.current.view.ledgerVersion).toBe(100);
  });
  it('discards a late old-mission response and synchronizes the selected mission next', async () => {
    let finish!: (response: Response) => void;
    const blocked = new Promise<Response>(resolve => {
      finish = resolve;
    });
    doubles.session.mockImplementation(async (url: string) =>
      url.endsWith('/stream')
        ? new Response()
        : url.includes('/m1')
          ? blocked
          : json({ view: { ...perfumeMission(), missionId: 'm2', ledgerVersion: 4 } }),
    );
    const hook = mount();
    await act(async () => {
      hook.result.current.host.selectMission('m2');
    });
    await act(async () => {
      finish(json({ view: { ...perfumeMission(), ledgerVersion: 999 } }));
    });
    await waitFor(() => expect(hook.result.current.view.missionId).toBe('m2'));
    expect(hook.result.current.view.ledgerVersion).toBe(4);
    expect(window.location.search).toContain('mission=m2');
  });
  it('keeps mutation input when offline and never sends a request', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const before = doubles.session.mock.calls.length;
    const result = await hook.result.current.commands.sendMessage({ ...base, text: 'Keep this founder input' });
    expect(result).toMatchObject({ ok: false, error: { code: 'offline', retryable: true } });
    expect(doubles.session.mock.calls.length).toBe(before);
    act(() => window.dispatchEvent(new Event('offline')));
    expect(hook.result.current.connection.status).toBe('offline');
  });
  it('submits the exact command identity and synchronizes only the returned ledger', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    doubles.session.mockImplementation(async (url: string) =>
      url === '/api/commands'
        ? json({ ok: true, ledgerVersion: 101 })
        : url === '/api/missions'
          ? json({ missions: MISSIONS })
          : url.endsWith('/stream')
            ? new Response()
            : json({ view: { ...perfumeMission(), ledgerVersion: 101 } }),
    );
    let result: unknown;
    await act(async () => {
      result = await hook.result.current.commands.sendMessage({ ...base, text: 'Exact founder request' });
    });
    expect(result).toMatchObject({ ok: true, ledgerVersion: 101 });
    expect(hook.result.current.view.ledgerVersion).toBe(101);
    const command = doubles.session.mock.calls.find(([url]) => url === '/api/commands');
    expect(JSON.parse(String(command?.[1]?.body))).toEqual({ ...base, text: 'Exact founder request', kind: 'sendMessage' });
    expect(hook.result.current.missions).toEqual(MISSIONS);
  });
  it('returns interruption without inventing success when command transport breaks', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    doubles.session.mockRejectedValue(new Error('synthetic unavailable'));
    expect(await hook.result.current.commands.sendMessage({ ...base, text: 'Retry me' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable', retryable: true },
    });
    expect(hook.result.current.view.ledgerVersion).toBe(100);
  });
  it('rejects malformed successful command replies instead of returning a false success', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    doubles.session.mockImplementation(async (url: string) =>
      url === '/api/commands' ? json({ ok: true }) : json({ view: perfumeMission() }),
    );
    let result: unknown;
    await act(async () => {
      result = await hook.result.current.commands.sendMessage({ ...base, text: 'Validate response' });
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });
  it('keeps the mission list when a command refresh returns a malformed list contract', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    doubles.session.mockImplementation(async (url: string) =>
      url === '/api/commands'
        ? json({ ok: true, ledgerVersion: 100 })
        : url === '/api/missions'
          ? json({ missions: 'invalid list' })
          : json({ view: perfumeMission() }),
    );
    await act(async () => {
      await hook.result.current.commands.sendMessage({ ...base, text: 'Refresh the mission list' });
    });
    expect(hook.result.current.missions).toEqual(MISSIONS);
  });
  it('persists valid preferences, discards corrupt JSON and builds a scoped deep link', async () => {
    localStorage.setItem('lo-preferences', '{broken');
    const hook = mount();
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    expect(localStorage.getItem('lo-preferences')).toBeNull();
    act(() => hook.result.current.host.setPreferences({ theme: 'dark', language: 'ar' }));
    expect(hook.result.current.theme).toBe('dark');
    expect(hook.result.current.language).toBe('ar');
    expect(JSON.parse(localStorage.getItem('lo-preferences') ?? 'null')).toEqual({ theme: 'dark', language: 'ar' });
    expect(document.cookie).toContain('lo-lang=ar');
    expect(hook.result.current.host.buildHref?.({ kind: 'system', view: 'money' })).toContain('mission=m1');
  });
  it('displays only current mission drafts and aborts the old stream on mission selection', async () => {
    const hook = mount();
    await waitFor(() => expect(doubles.streams.length).toBe(1));
    const first = doubles.streams[0];
    if (!first) throw new Error('Expected current mission stream');
    act(() =>
      first.accept([
        { runId: 'synthetic-run', attemptKey: 'call', sequence: 0, text: 'Actual streamed fixture', at: new Date().toISOString() },
      ]),
    );
    expect(hook.result.current.view.entries.at(-1)).toMatchObject({ id: 'stream:synthetic-run', streaming: true });
    act(() => hook.result.current.host.selectMission('m2'));
    await waitFor(() => expect(first.signal.aborted).toBe(true));
    act(() =>
      first.accept([{ runId: 'late-run', attemptKey: 'old', sequence: 1, text: 'Late obsolete draft', at: new Date().toISOString() }]),
    );
    expect(hook.result.current.view.entries.some(e => e.id === 'stream:late-run')).toBe(false);
  });
  it('authenticates private realtime and removes its subscription on unmount', async () => {
    let subscribed!: (status: string) => void;
    const channel = {
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn((callback: (status: string) => void) => {
          subscribed = callback;
          return channel;
        }),
      },
      client = {
        realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
        channel: vi.fn(() => channel),
        removeChannel: vi.fn().mockResolvedValue(undefined),
      };
    doubles.createClient.mockReturnValue(client);
    const hook = mount(false);
    await waitFor(() => expect(client.realtime.setAuth).toHaveBeenCalledWith('test-token'));
    expect(client.channel).toHaveBeenCalledWith('mission:m1', { config: { private: true } });
    act(() => subscribed('CHANNEL_ERROR'));
    expect(hook.result.current.connection.status).toBe('reconnecting');
    hook.unmount();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });
  it.each([
    { redirectUrl: 'http://www.paypal.com/checkoutnow' },
    { redirectUrl: 'https://user:password@www.paypal.com/checkoutnow' },
    { redirectUrl: 'https://www.paypal.com:444/checkoutnow' },
    { redirectUrl: 'https://attacker.test/checkoutnow' },
    { downloadUrl: 'https://attacker.test/archive.zip' },
  ])('holds unsafe navigation replies: %j', async navigation => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    doubles.session.mockImplementation(async (url: string) =>
      url === '/api/commands'
        ? json({ ok: true, ledgerVersion: 100, ...navigation })
        : url === '/api/missions'
          ? json({ missions: MISSIONS })
          : json({ view: perfumeMission() }),
    );
    let result: unknown;
    await act(async () => {
      result = await hook.result.current.commands.exportLaunchRecord({ ...base, format: 'zip' });
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });
  it('does not accept an HTTP failure disguised as a successful command payload', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    doubles.session.mockImplementation(async () => json({ ok: true, ledgerVersion: 100 }, 503));
    expect(await hook.result.current.commands.sendMessage({ ...base, text: 'Synthetic retry' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
  });
  it('records only bounded active/idle presence while the visible workspace has focus', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const hook = mount();
    await act(async () => {
      await Promise.resolve();
    });
    const presence = () =>
      doubles.session.mock.calls.filter(([url]) => String(url).endsWith('/presence')).map(([, init]) => JSON.parse(String(init.body)));
    expect(presence().at(-1)).toEqual({ active: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(presence().at(-1)).toEqual({ active: false });
    act(() => document.dispatchEvent(new Event('keydown')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(presence().at(-1)).toEqual({ active: true });
    hook.unmount();
    const count = presence().length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(presence()).toHaveLength(count);
  });
  it('renews realtime authentication without duplicating the channel, then holds renewal failure', async () => {
    vi.useFakeTimers();
    doubles.delay.mockReturnValue(1000);
    const channel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() },
      client = {
        realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
        channel: vi.fn(() => channel),
        removeChannel: vi.fn().mockResolvedValue(undefined),
      };
    doubles.createClient.mockReturnValue(client);
    const hook = mount(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.channel).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(doubles.renew).toHaveBeenCalledTimes(1);
    expect(client.realtime.setAuth).toHaveBeenCalledTimes(2);
    expect(client.channel).toHaveBeenCalledTimes(1);
    doubles.renew.mockResolvedValueOnce(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hook.result.current.connection.status).toBe('reconnecting');
    hook.unmount();
  });
  it('restores valid persisted preferences without changing business state', async () => {
    localStorage.setItem('lo-preferences', JSON.stringify({ theme: 'dark', language: 'ar' }));
    const hook = mount();
    await waitFor(() => expect(hook.result.current.connection.status).toBe('live'));
    expect(hook.result.current.theme).toBe('dark');
    expect(hook.result.current.language).toBe('ar');
    expect(hook.result.current.view.ledgerVersion).toBe(100);
  });
});
