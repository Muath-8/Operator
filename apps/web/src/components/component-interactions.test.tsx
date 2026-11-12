// @vitest-environment jsdom
import { createElement, useEffect, useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, en } from '../i18n';
import { FakeMissionServer } from '../../tests/ui/fixtures/fakeServer.fixture';
import { closingScene, mandateScene, paymentScene } from '../../tests/ui/fixtures/variants.fixture';
import { MissionWorkspace } from './MissionWorkspace';
import { WorkspaceContext, type WorkspaceApi } from './workspace/context';
import { initialUi } from './workspace/uiState';
import { perfumeMission, strapMission, MISSIONS } from '../../tests/ui/fixtures/missions.fixture';
import { ACCOUNTS, DELETION_NOTICE } from '../../tests/ui/fixtures/account.fixture';
import type { CommandResult, MissionCommands, MissionView, SystemPeek } from '../ui-contract';
import { AccountsPeek } from './account/AccountsPeek';
import { DeleteMissionDialog } from './account/DeleteMissionDialog';
import { StartMission } from './account/StartMission';
import { ValidationForm } from './account/ValidationForm';
import { CommandPalette } from './shell/CommandPalette';
import { Composer } from './shell/Composer';
import { Dialog } from './primitives/Dialog';
import { TooltipHost } from './primitives/Tooltip';
import { CanvasEngine } from './canvas/CanvasEngine';
import { ActionButtons } from './peek/DocumentView';
import { SignIn } from './account/SignIn';
import { Dial } from './primitives/Dial';
import { Inspector } from './canvas/Inspector';
import { ThreadView } from './peek/ThreadView';
import { NotificationsPeek, MoneyPeek, LogPeek } from './peek/SystemViews';

let api: WorkspaceApi;
let calls: Record<string, ReturnType<typeof vi.fn>>;
let fetchMock: ReturnType<typeof vi.fn>;
function context(child: ReactNode, extra: Partial<WorkspaceApi> = {}) {
  calls = {};
  const commands = new Proxy(
    {},
    { get: (_target, name: string) => (calls[name] ??= vi.fn(async (): Promise<CommandResult> => ({ ok: true, ledgerVersion: 1 }))) },
  ) as MissionCommands;
  api = {
    view: perfumeMission(),
    missions: MISSIONS,
    connection: { status: 'live', lastSyncedAt: null },
    commands,
    host: {
      selectMission: vi.fn(),
      setPreferences: vi.fn(),
      loadAccounts: async () => ACCOUNTS,
      loadDeletionNotice: async () => DELETION_NOTICE,
    },
    theme: 'light',
    language: 'en',
    layout: 'side',
    reducedMotion: true,
    ui: initialUi(null),
    dispatch: vi.fn(),
    open: vi.fn(),
    closePeek: vi.fn(),
    canDecide: true,
    canMessage: true,
    compose: vi.fn(),
    announce: vi.fn(),
    send: vi.fn(async () => true),
    run: vi.fn(async (_key, execute) =>
      execute({ missionId: api.view.missionId, seenLedgerVersion: api.view.ledgerVersion, idempotencyKey: 'actual-dom-attempt' }),
    ),
    commandState: () => undefined,
    commandStates: {},
    clearCommand: vi.fn(),
    isNewEntry: () => false,
    openPalette: vi.fn(),
    startMoment: vi.fn(),
    ...extra,
  };
  return render(
    createElement(I18nProvider, { lang: 'en', timeZone: 'UTC', children: createElement(WorkspaceContext.Provider, { value: api }, child) }),
  );
}
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('min-width') || query.includes('reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom has no CSS.escape. Ledger fixtures here contain only identifier-safe ids.
  vi.stubGlobal('CSS', {
    escape: (value: string) => {
      if (!/^[a-z0-9-]+$/i.test(value)) throw new Error('Fixture id needs actual browser escaping');
      return value;
    },
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ traceRetentionEnabled: false, externalTraceExportConfigured: false, retentionDays: 90, objects: [] })),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function workspace(view: MissionView, target: { kind: 'system'; view: SystemPeek } | { kind: 'artifact'; artifactId: string }) {
  const commands = new Proxy({}, { get: () => vi.fn(async () => ({ ok: true, ledgerVersion: view.ledgerVersion })) }) as MissionCommands;
  return render(
    createElement(MissionWorkspace, {
      view,
      missions: MISSIONS,
      connection: { status: 'live', lastSyncedAt: null },
      commands,
      host: { selectMission: vi.fn(), setPreferences: vi.fn(), loadAccounts: async () => ACCOUNTS },
      theme: 'light',
      language: 'en',
      initialTarget: target,
    }),
  );
}
describe('actual mounted workspace surfaces', () => {
  it.each(['money', 'readiness', 'log', 'notifications', 'plates', 'record', 'accounts'] as const)(
    'opens the %s surface with an accessible close action',
    async name => {
      workspace(perfumeMission(), { kind: 'system', view: name });
      expect(screen.getAllByRole('heading').length).toBeGreaterThan(1);
      const close = screen.getAllByRole('button', { name: /Close/ });
      expect(close.length).toBeGreaterThan(0);
      fireEvent.click(close[0] as HTMLElement);
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull());
    },
  );
  for (const make of [perfumeMission, strapMission]) {
    const view = make();
    for (const artifact of Object.values(view.artifacts)) {
      it(`opens ${view.missionId} ${artifact.id} with its real content`, async () => {
        workspace(view, { kind: 'artifact', artifactId: artifact.id });
        expect(screen.getAllByText(artifact.title).length).toBeGreaterThan(0);
        if (artifact.content.kind === 'canvas') {
          const zoom = screen.queryByRole('button', { name: 'Zoom in' });
          if (zoom) {
            fireEvent.click(zoom);
            fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
          }
          const frame = screen.queryAllByRole('button', { name: /^Frame:/ })[0];
          if (frame) fireEvent.click(frame);
        }
      });
    }
  }
});

describe('component intentions and failure states', () => {
  it('moves dial focus without approval and activates only on an explicit click, including RTL focus', async () => {
    const control = { targetId: 'scope', targetKind: 'thread' as const, mode: 'guide' as const, allowed: ['guide', 'do', 'help'] as const };
    context(createElement(Dial, { control }));
    const radios = screen.getAllByRole('radio');
    (radios[0] as HTMLElement).focus();
    fireEvent.keyDown(radios[0] as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radios[1]);
    expect(calls['setHelpMode']).toBeUndefined();
    document.documentElement.dir = 'rtl';
    fireEvent.keyDown(radios[1] as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.click(radios[2] as HTMLElement);
    await waitFor(() =>
      expect(calls['setHelpMode']).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'help', control: { targetId: 'scope', targetKind: 'thread' } }),
      ),
    );
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
    document.documentElement.dir = 'ltr';
  });
  it('keeps palette key handling local, searches, runs an explicit item, and closes on escape', () => {
    const onRun = vi.fn(),
      onClose = vi.fn();
    context(createElement(CommandPalette, { onRun, onClose }));
    const box = screen.getByRole('combobox');
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'End' });
    fireEvent.keyDown(box, { key: 'Home' });
    fireEvent.keyDown(box, { key: 'Tab' });
    fireEvent.change(box, { target: { value: 'A unique founder question' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ action: { k: 'say', text: 'A unique founder question' } }));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('sends exact notification settings while keeping the moment preference and read ids', async () => {
    context(createElement(NotificationsPeek));
    const read = screen.queryByRole('button', { name: /Mark.*read/i });
    if (read) fireEvent.click(read);
    for (const select of screen.getAllByRole('combobox')) {
      const option = (select as HTMLSelectElement).options[1];
      if (option) fireEvent.change(select, { target: { value: option.value } });
    }
    for (const check of screen.queryAllByRole('checkbox')) fireEvent.click(check);
    await waitFor(() => expect(calls['updateNotificationSettings']).toHaveBeenCalled());
    expect(calls['updateNotificationSettings']?.mock.calls[0]?.[0].settings.momentsPerWeek).toBe(
      api.view.notificationSettings.momentsPerWeek,
    );
    if (api.view.notifications.some(n => !n.read))
      expect(calls['markNotificationsRead']).toHaveBeenCalledWith(
        expect.objectContaining({ notificationIds: api.view.notifications.filter(n => !n.read).map(n => n.id) }),
      );
  });
  it('requires a separate account revocation confirmation and displays the provider refusal', async () => {
    const revokeAccount = vi.fn(async () => ({ ok: false as const, message: 'Provider refused' }));
    context(createElement(AccountsPeek), { host: { ...api?.host, loadAccounts: async () => ACCOUNTS, revokeAccount } });
    const revoke = await screen.findAllByRole('button', { name: 'Revoke my access' });
    fireEvent.click(revoke[0] as HTMLElement);
    expect(revokeAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Revoke access to / }));
    await waitFor(() => expect(revokeAccount).toHaveBeenCalledOnce());
    await screen.findByText(/Provider refused/);
  });
  it('requires both deletion gestures, preserves the disclosure on failure, and allows close', async () => {
    const onClose = vi.fn(),
      deleteMission = vi.fn(async () => ({ ok: false as const, message: 'Deletion did not complete' }));
    context(createElement(DeleteMissionDialog, { onClose }), {
      host: { selectMission: vi.fn(), setPreferences: vi.fn(), loadDeletionNotice: async () => DELETION_NOTICE, deleteMission },
    });
    const checks = await screen.findAllByRole('checkbox');
    const button = screen.getByRole('button', { name: 'Delete mission records' });
    fireEvent.click(button);
    expect(deleteMission).not.toHaveBeenCalled();
    fireEvent.click(checks[0] as HTMLElement);
    fireEvent.click(button);
    expect(deleteMission).not.toHaveBeenCalled();
    fireEvent.click(checks[1] as HTMLElement);
    fireEvent.click(button);
    await waitFor(() => expect(deleteMission).toHaveBeenCalledOnce());
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).not.toMatch(/mission is paused/i);
    expect(screen.getByRole('alert').textContent).toContain('Refresh the mission');
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Keep the mission' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('preserves a validation email on server rejection, then acknowledges only confirmed signup', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Try later' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    render(createElement(ValidationForm, { slug: 'test-page', consentText: 'Explicit signup consent' }));
    const email = screen.getByRole('textbox', { name: 'Email' });
    const consent = screen.getByRole('checkbox');
    const form = email.closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(email, { target: { value: 'founder@example.test' } });
    fireEvent.submit(form);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(consent);
    fireEvent.submit(form);
    await screen.findByRole('alert');
    expect((email as HTMLInputElement).value).toBe('founder@example.test');
    fireEvent.submit(form);
    await screen.findByRole('status');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('reuses a mission creation attempt after retryable transport failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Still unavailable', retryable: true } }), { status: 503 }));
    render(createElement(StartMission));
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[1].body).toBe(fetchMock.mock.calls[1]?.[1].body);
  });
});

describe('editable artifacts and contextual actions', () => {
  const view = perfumeMission();
  const canvases = Object.values(view.artifacts).filter(a => a.content.kind === 'canvas');
  const thread = Object.values(view.artifacts).find(a => a.content.kind === 'thread');
  for (const artifact of canvases) {
    if (artifact.content.kind !== 'canvas') continue;
    for (const frame of artifact.content.frames) {
      it(`binds inspector actions and comments to ${artifact.id}/${frame.id}`, async () => {
        const onPin = vi.fn();
        context(createElement(Inspector, { artifact, frame, viewingVersionId: frame.inspector.currentVersionId, onPin, pinning: false }));
        expect(screen.getByRole('heading', { name: frame.title })).toBeTruthy();
        const input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: 'A precise founder revision' } });
        fireEvent.submit(input.closest('form') as HTMLFormElement);
        await waitFor(() => expect(api.run).toHaveBeenCalled());
        const command = frame.inspector.allowVariation ? calls['requestVariation'] : calls['sendMessage'];
        expect(command).toHaveBeenCalledWith(
          expect.objectContaining(
            frame.inspector.allowVariation
              ? {
                  artifactId: artifact.id,
                  frameId: frame.id,
                  versionId: frame.inspector.currentVersionId,
                  request: 'A precise founder revision',
                }
              : {
                  text: 'A precise founder revision',
                  context: { artifactId: artifact.id, frameId: frame.id, versionId: frame.inspector.currentVersionId },
                },
          ),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Pin a comment here' }));
        expect(onPin).toHaveBeenCalledOnce();
        const version = screen.getAllByRole('button', { name: /^v\d/ })[0];
        if (version) fireEvent.click(version);
        fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
        expect(api.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'inspect', frameId: null }));
      });
    }
  }
  it('renders bilingual messages and binds approval/discard to the exact held draft', async () => {
    if (!thread || thread.content.kind !== 'thread' || !thread.content.draft)
      throw new Error('The explicit thread fixture must contain a held draft');
    context(createElement(ThreadView, { artifactId: thread.id, title: thread.title, content: thread.content }));
    const draft = thread.content.draft;
    expect(screen.getByText(draft.original.text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and send' }));
    await waitFor(() =>
      expect(calls['approveDraft']).toHaveBeenCalledWith(expect.objectContaining({ artifactId: thread.id, draftId: draft.id })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(calls['discardDraft']).toHaveBeenCalledWith(expect.objectContaining({ artifactId: thread.id, draftId: draft.id })),
    );
    const edit = screen.queryByRole('button', { name: 'Ask for edits' });
    if (edit) {
      fireEvent.click(edit);
      expect(api.compose).toHaveBeenCalled();
    }
  });
  it('requires an impact flow for a version-bound approved action and preserves open navigation', async () => {
    context(
      createElement(ActionButtons, {
        artifactId: 'artifact',
        frameId: 'frame',
        versionId: 'version',
        actions: [
          { id: 'impact', label: 'Revise approved work', kind: 'command', runsImpact: true },
          { id: 'act', label: 'Run scoped action', kind: 'command' },
          { id: 'open', label: 'Inspect source', kind: 'open', target: { kind: 'system', view: 'log' } },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revise approved work' }));
    await waitFor(() =>
      expect(calls['requestChange']).toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: 'artifact', versionId: 'version', actionId: 'impact' }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run scoped action' }));
    await waitFor(() =>
      expect(calls['runArtifactAction']).toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: 'artifact', frameId: 'frame', versionId: 'version' }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect source' }));
    expect(api.open).toHaveBeenCalledWith({ kind: 'system', view: 'log' }, expect.anything());
  });
  it('pans and zooms the actual desktop canvas by keyboard and wheel without business commands', () => {
    const artifact = canvases[0];
    if (!artifact || artifact.content.kind !== 'canvas') throw new Error('Explicit canvas fixture required');
    const page = context(createElement(CanvasEngine, { artifact, content: artifact.content }));
    const stage = screen.getByRole('region', { name: artifact.title });
    const world = page.container.querySelector('.world') as HTMLElement;
    const before = world.style.transform;
    fireEvent.keyDown(stage, { key: 'ArrowRight' });
    expect(world.style.transform).not.toBe(before);
    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowDown', '+', '-', '0']) fireEvent.keyDown(stage, { key });
    fireEvent.wheel(stage, { deltaY: 20, deltaX: 10 });
    fireEvent.wheel(stage, { deltaY: -10, ctrlKey: true, clientX: 100, clientY: 100 });
    expect(world.style.transform).not.toContain('NaN');
    expect(api.run).not.toHaveBeenCalled();
    const frameButton = page.container.querySelector('.fsel');
    if (!frameButton) throw new Error('Canvas frame control required');
    fireEvent.click(frameButton);
    expect(api.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'inspect', artifactId: artifact.id }));
  });
  it('requires mandate revoke confirmation and filters log through presentation state', async () => {
    context(createElement(MoneyPeek));
    const revoke = screen.getAllByRole('button', { name: 'Revoke this mandate' })[0];
    if (!revoke) throw new Error('Fixture needs an active mandate');
    fireEvent.click(revoke);
    expect(calls['setMandateStatus']).toBeUndefined();
    const confirm = screen.getAllByRole('button', { name: /^Revoke / }).find(button => button.textContent !== 'Revoke this mandate');
    if (!confirm) throw new Error('Explicit revoke confirmation required');
    fireEvent.click(confirm);
    await waitFor(() => expect(calls['setMandateStatus']).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' })));
    cleanup();
    context(createElement(LogPeek));
    const filters = screen.getAllByRole('button', { pressed: false });
    fireEvent.click(filters[0] as HTMLElement);
    expect(api.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'logFilter' }));
  });
  it('keeps a composer draft after rejection, restores it, and clears only after acceptance', async () => {
    sessionStorage.clear();
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onRun = vi.fn();
    context(createElement(Composer, { request: null, onRun }), { send });
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'A new founder instruction' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect((input as HTMLInputElement).value).toBe('A new founder instruction');
    expect(sessionStorage.getItem('lo-draft:m1')).toBe('A new founder instruction');
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    expect(sessionStorage.getItem('lo-draft:m1')).toBeNull();
  });
  it('shows text-only evidence tooltips for keyboard users and dismisses them on escape', () => {
    render(
      createElement(
        'div',
        {},
        createElement('button', { 'data-tip': '<b>untrusted text</b>', 'data-tip-title': 'Evidence', 'data-tip-toggle': '' }, 'Source'),
        createElement(TooltipHost),
      ),
    );
    const button = screen.getByRole('button');
    fireEvent.focusIn(button);
    expect(screen.getByRole('tooltip').textContent).toContain('<b>untrusted text</b>');
    expect(screen.getByRole('tooltip').querySelector('b')?.textContent).toContain('Evidence');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseOver(button);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.scroll(document);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('reports local sign-in refusal and clears callback fragments before a failed exchange', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 403 }));
    render(createElement(SignIn, { local: true, supabaseUrl: null, supabaseAnonKey: null }));
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('alert');
    expect(fetchMock).toHaveBeenCalledWith('/api/session/local', { method: 'POST' });
    cleanup();
    history.replaceState(null, '', '/login#access_token=secret&refresh_token=private');
    render(createElement(SignIn, { local: false, supabaseUrl: null, supabaseAnonKey: null }));
    expect(location.hash).toBe('');
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain('secret');
    history.replaceState(null, '', '/');
  });
});

function liveWorkspace(view = perfumeMission(), hostExtra = {}) {
  const server = new FakeMissionServer({ latencyMs: 0, lagMs: 0 });
  server.setView(view);
  const host = {
    selectMission: vi.fn(),
    setPreferences: vi.fn(),
    signOut: vi.fn(async () => {
      throw new Error('Session still active');
    }),
    loadAccounts: async () => ACCOUNTS,
    loadDeletionNotice: async () => DELETION_NOTICE,
    ...hostExtra,
  };
  function Live() {
    const [current, update] = useState(view);
    useEffect(() => server.subscribe(update), []);
    return createElement(MissionWorkspace, {
      view: current,
      missions: MISSIONS,
      connection: { status: 'live', lastSyncedAt: null },
      commands: server.commands,
      host,
      theme: 'light',
      language: 'en',
    });
  }
  const page = render(createElement(Live));
  return { ...page, server, host };
}
function paletteRun(label: string) {
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  const box = screen.getByRole('combobox', { expanded: true });
  fireEvent.change(box, { target: { value: label } });
  const option = screen.getAllByRole('option').find(node => node.textContent?.startsWith(label));
  if (!option) throw new Error(`Palette item missing: ${label}`);
  fireEvent.click(option);
}
describe('mounted workspace command orchestration', () => {
  it('navigates palette targets and applies presentation preferences without a business decision', async () => {
    const page = liveWorkspace();
    for (const label of [en.money, en.readiness, en.accounts, en.exportRecord]) {
      paletteRun(label);
      expect(screen.queryByRole('listbox')).toBeNull();
    }
    paletteRun(en.themeToDark);
    expect(page.host.setPreferences).toHaveBeenCalledWith({ theme: 'dark' });
    paletteRun(en.langToAr);
    expect(page.host.setPreferences).toHaveBeenCalledWith({ language: 'ar' });
    paletteRun(en.sinceYouLeft.replace('{range}', '').replace(/,\s*$/, ''));
    expect(page.container.querySelector('.chapter')).toBeTruthy();
    expect(page.server.calls.filter(c => c.name === 'resolveDecision')).toHaveLength(0);
  });
  it('uses palette mission creation/switch/pause and reports refused sign-out without removing workspace', async () => {
    const page = liveWorkspace();
    paletteRun(en.newMission);
    await waitFor(() => expect(page.host.selectMission).toHaveBeenCalled());
    paletteRun(en.pauseMission);
    await waitFor(() => expect(page.server.calls.some(c => c.name === 'setMissionStatus')).toBe(true));
    paletteRun(en.signOut);
    await screen.findByRole('alert');
    expect(page.host.signOut).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: en.retry }));
    await waitFor(() => expect(page.host.signOut).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: en.signOutStay }));
    expect(page.container.querySelector('.app')).toBeTruthy();
    paletteRun(en.del_open);
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('opens and closes system shortcuts, preserves field typing, and sends through the real command ledger', async () => {
    const page = liveWorkspace();
    (document.activeElement as HTMLElement)?.blur();
    for (const key of ['m', 'm', 'r', 'Escape', 'l', 'Escape']) {
      (document.activeElement as HTMLElement)?.blur();
      fireEvent.keyDown(document, { key });
    }
    fireEvent.keyDown(document, { key: '/' });
    const input = page.container.querySelector('[data-composer]') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'A precise new instruction' } });
    fireEvent.keyDown(input, { key: 'a' });
    expect(page.server.calls.filter(c => c.name === 'resolveDecision')).toHaveLength(0);
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(page.server.calls.some(c => c.name === 'sendMessage')).toBe(true));
    await waitFor(() => expect(input.value).toBe(''));
  });
  it('expands decision evidence, selects an option by number, and records only explicit approval', async () => {
    const page = liveWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /See all/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Why this?' }));
    (document.activeElement as HTMLElement)?.blur();
    fireEvent.keyDown(document, { key: '2' });
    expect(page.server.calls.filter(c => c.name === 'resolveDecision')).toHaveLength(0);
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(() => expect(page.server.calls.some(c => c.name === 'resolveDecision')).toBe(true));
    await waitFor(() => expect(page.container.querySelector('.done-line')).toBeTruthy());
    expect(page.server.calls.find(c => c.name === 'resolveDecision')?.input).toEqual(expect.objectContaining({ missionId: 'm1' }));
  });
  it('starts and leaves a decision moment without approving anything, then applies only server defaults on Just go', async () => {
    const page = liveWorkspace();
    paletteRun(en.startMoment);
    expect(page.container.querySelector('#ritual')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.leave }));
    expect(page.server.calls).toHaveLength(0);
    paletteRun(en.startMoment);
    fireEvent.click(screen.getByRole('button', { name: en.justGo }));
    await waitFor(() => expect(page.server.calls.some(c => c.name === 'justGo')).toBe(true));
    expect(page.server.calls.filter(c => c.name === 'resolveDecision')).toHaveLength(0);
  });
  it.each([closingScene, mandateScene, paymentScene])(
    'renders specialized decision/closing scenes through the same mounted workspace',
    make => {
      const page = liveWorkspace(make());
      expect(screen.getAllByRole('heading').length).toBeGreaterThan(1);
      for (const button of screen.queryAllByRole('button', { name: /Why this|See all/ })) fireEvent.click(button);
      expect(page.container.querySelector('.page')).toBeTruthy();
    },
  );
});

describe('pointer and modal boundaries', () => {
  it('supports drag and two-pointer pinch while keeping all business commands untouched', () => {
    const artifact = Object.values(perfumeMission().artifacts).find(a => a.content.kind === 'canvas');
    if (!artifact || artifact.content.kind !== 'canvas') throw new Error('Explicit canvas required');
    const page = context(createElement(CanvasEngine, { artifact, content: artifact.content }));
    const stage = screen.getByRole('region', { name: artifact.title });
    const world = page.container.querySelector('.world') as HTMLElement;
    const pointer = (type: string, id: number, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: 'touch' } });
      fireEvent(stage, event);
    };
    const initial = world.style.transform;
    pointer('pointerdown', 1, 10, 10);
    pointer('pointermove', 1, 60, 60);
    expect(world.style.transform).not.toBe(initial);
    pointer('pointerup', 1, 60, 60);
    pointer('pointerdown', 2, 10, 10);
    pointer('pointerdown', 3, 110, 110);
    pointer('pointermove', 3, 210, 210);
    pointer('pointerup', 3, 210, 210);
    pointer('pointercancel', 2, 10, 10);
    expect(world.style.transform).not.toContain('NaN');
    expect(api.run).not.toHaveBeenCalled();
  });
  it('traps modal tab focus, closes on Escape, and restores the opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const close = vi.fn();
    const page = render(
      createElement(Dialog, {
        labelledBy: 'modal-title',
        onClose: close,
        children: createElement(
          'div',
          {},
          createElement('h2', { id: 'modal-title' }, 'Scoped confirmation'),
          createElement('button', {}, 'First action'),
          createElement('input', { 'aria-label': 'Last field' }),
        ),
      }),
    );
    const first = screen.getByRole('button', { name: 'First action' }),
      last = screen.getByRole('textbox');
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    page.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it('does not start Shopify consent without valid domain and attestation and rejects unsafe redirect', async () => {
    const connectShopify = vi.fn(async () => ({ ok: true as const, authorizationUrl: 'https://foreign.invalid/' }));
    context(createElement(AccountsPeek), {
      host: { selectMission: vi.fn(), setPreferences: vi.fn(), loadAccounts: async () => ({ accounts: [] }), connectShopify },
    });
    const input = await screen.findByRole('textbox', { name: /Store address/ });
    const form = input.closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect(connectShopify).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'store.myshopify.com' } });
    fireEvent.submit(form);
    expect(connectShopify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I own this store/ }));
    fireEvent.submit(form);
    await waitFor(() => expect(connectShopify).toHaveBeenCalledOnce());
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(location.hostname).not.toBe('foreign.invalid');
  });
});
