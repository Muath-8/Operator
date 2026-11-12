// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WorkspaceContext, type WorkspaceApi } from '../workspace/context';
import { initialUi } from '../workspace/uiState';
import { perfumeMission } from '../../../tests/ui/fixtures/missions.fixture';
import { PrivacyControls } from './PrivacyControls';
import type { CommandResult } from '../../ui-contract';

const id = '91111111-1111-4111-8111-111111111111';
const recording = {
  id,
  kind: 'recording',
  sourceReference: 'private-source',
  createdAt: '2026-11-12T09:00:00Z',
  expiresAt: '2027-02-10T09:00:00Z',
  kept: false,
  available: true,
};
const metadata = (extra = {}) => ({
  traceRetentionEnabled: true,
  externalTraceExportConfigured: false,
  retentionDays: 90,
  objects: [recording],
  ...extra,
});
let result: CommandResult;
let api: WorkspaceApi;
let fetchMock: ReturnType<typeof vi.fn>;
function mount(extra: Partial<WorkspaceApi> = {}, language: 'en' | 'ar' = 'en') {
  api = {
    view: perfumeMission(),
    missions: [],
    connection: { status: 'live', lastSyncedAt: null },
    host: {},
    theme: 'light',
    language,
    layout: 'side',
    reducedMotion: true,
    ui: initialUi(null),
    commands: { setTraceRetention: vi.fn(async () => result), keepRetainedContent: vi.fn(async () => result) },
    run: vi.fn(async (_key, execute) =>
      execute({ missionId: api.view.missionId, seenLedgerVersion: api.view.ledgerVersion, idempotencyKey: 'retained-attempt' }),
    ),
    commandState: () => undefined,
    ...extra,
  } as WorkspaceApi;
  const wrap = (children: ReactNode) =>
    createElement(I18nProvider, {
      lang: language,
      timeZone: 'UTC',
      children: createElement(WorkspaceContext.Provider, { value: api }, children),
    });
  const tree = () => wrap(createElement(PrivacyControls, { key: api.view.missionId }));
  const rendered = render(tree());
  return {
    ...rendered,
    update: (patch: Partial<WorkspaceApi>) => {
      api = { ...api, ...patch };
      rendered.rerender(tree());
    },
  };
}
beforeEach(() => {
  result = { ok: true, ledgerVersion: perfumeMission().ledgerVersion };
  fetchMock = vi.fn(async () => new Response(JSON.stringify(metadata()), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('founder privacy controls actual DOM', () => {
  it('shows scoped metadata, truthful export eligibility and separate archive attachment', async () => {
    mount();
    await screen.findByRole('checkbox');
    expect(screen.getByText(/currently disabled for this service/)).toBeTruthy();
    expect(screen.queryByText('private-source')).toBeNull();
    const archive = screen.getByRole('link', { name: 'Download full mission archive' });
    expect(archive.getAttribute('href')).toBe('/api/missions/m1/archive');
    expect(archive.getAttribute('download')).toBe('mission-m1.ndjson');
    expect(screen.getByText(/Its final record must say/)).toBeTruthy();
  });
  it('binds a trace change to current revision and waits for the acknowledged ledger before metadata refresh', async () => {
    const page = mount();
    await screen.findByRole('checkbox');
    result = { ok: true, ledgerVersion: api.view.ledgerVersion + 1 };
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(api.commands.setTraceRetention).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          missionId: 'm1',
          seenLedgerVersion: api.view.ledgerVersion,
          idempotencyKey: 'retained-attempt',
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    page.update({ view: { ...api.view, ledgerVersion: result.ledgerVersion } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
  it('sends keep and unkeep with exact object ids, and never offers keep for traces or unavailable data', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify(
            metadata({
              objects: [
                recording,
                { ...recording, id: '92222222-2222-4222-8222-222222222222', kind: 'trace' },
                { ...recording, id: '93333333-3333-4333-8333-333333333333', available: false },
              ],
            }),
          ),
        ),
    );
    mount();
    const keep = await screen.findByRole('button', { name: 'Keep this content' });
    fireEvent.click(keep);
    await waitFor(() =>
      expect(api.commands.keepRetainedContent).toHaveBeenCalledWith(expect.objectContaining({ objectId: id, keep: true })),
    );
    cleanup();
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(metadata({ objects: [{ ...recording, kept: true, available: false }] }))),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop keeping this content' }));
    await waitFor(() =>
      expect(api.commands.keepRetainedContent).toHaveBeenCalledWith(expect.objectContaining({ objectId: id, keep: false })),
    );
  });
  it('keeps choices unchanged on command failure and permits a deliberate retry', async () => {
    result = { ok: false, error: { code: 'conflict', message: 'Refresh required', retryable: true } };
    mount({ commandState: () => ({ phase: 'error', error: { code: 'conflict', message: 'Refresh required', retryable: true } }) });
    await screen.findByRole('checkbox');
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(api.commands.setTraceRetention).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(api.commands.setTraceRetention).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
  it('rejects malformed metadata and retries without interpreting missing data as empty', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ objects: [] })));
    mount();
    await screen.findByRole('alert');
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('checkbox');
  });
  it('aborts stale mission requests and never displays late prior-mission settings', async () => {
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          release = resolve;
        }),
    );
    const page = mount();
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    page.update({ view: { ...api.view, missionId: 'm2' } });
    await screen.findByRole('checkbox');
    expect(signal.aborted).toBe(true);
    release(new Response(JSON.stringify(metadata({ externalTraceExportConfigured: true }))));
    await waitFor(() => expect(screen.queryByText(/configured for this service; your permission/)).toBeNull());
    expect(screen.getByRole('link').getAttribute('href')).toBe('/api/missions/m2/archive');
  });
  it('prevents offline commands/download and does not fetch founder metadata for a viewer', async () => {
    mount({ connection: { status: 'offline', lastSyncedAt: null } });
    await screen.findByRole('checkbox');
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    fetchMock.mockClear();
    mount({ view: { ...perfumeMission(), access: { ...perfumeMission().access, role: 'viewer' } } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('provides Arabic controls, empty-state honesty and global configured disclosure', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(metadata({ objects: [], externalTraceExportConfigured: true }))));
    mount({}, 'ar');
    await screen.findByRole('checkbox', { name: /السماح بالاحتفاظ/ });
    expect(screen.getByText(/لا يوجد محتوى خام/)).toBeTruthy();
    expect(screen.getByText(/يتطلّب موافقتك/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /تنزيل أرشيف/ })).toBeTruthy();
  });
});
