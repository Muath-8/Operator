'use client';

import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from 'react';
import type { MessageContext, MissionView, MissionWorkspaceProps, Target } from '../ui-contract';
import { I18nProvider, translate } from '../i18n';
import { MissionPage } from './page/MissionPage';
import { Peek } from './peek/Peek';
import { TooltipHost } from './primitives/Tooltip';
import { Banners } from './shell/Banners';
import { CommandPalette } from './shell/CommandPalette';
import { Composer, type ComposeRequest } from './shell/Composer';
import { MissionRail } from './shell/MissionRail';
import { StatusStrip } from './shell/StatusStrip';
import type { PaletteItem } from './shell/palette';
import { CommandLedger, type CommandStates } from './workspace/commandRunner';
import { WorkspaceContext, type Layout, type WorkspaceApi } from './workspace/context';
import { activeDecisionId, momentDecisionIds } from './workspace/derive';
import { initialUi, targetKey, targetToPeek, uiReducer, type PeekTarget } from './workspace/uiState';
import { decisionActionsFor } from './workspace/useDecisionActions';
import { DeleteMissionDialog } from './account/DeleteMissionDialog';
import { endSession } from './account/accountApi';

/**
 * Launch Operator workspace. Renders a MissionView and reports intent through MissionCommands.
 * It never invents binding state: decisions, money, mandates and readiness change only when the
 * host passes a new view whose ledgerVersion covers the command (UX 8.3, Quality Bar 8).
 */
export function MissionWorkspace(props: MissionWorkspaceProps) {
  const { view, language } = props;
  useDocumentPreferences(props.theme, language);
  return (
    <I18nProvider lang={language} timeZone={view.timeZone}>
      <WorkspaceInner key={view.missionId} {...props} />
      <TooltipHost />
    </I18nProvider>
  );
}

function useDocumentPreferences(theme: MissionWorkspaceProps['theme'], language: MissionWorkspaceProps['language']) {
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = theme;
    el.lang = language;
    el.dir = language === 'ar' ? 'rtl' : 'ltr';
    // The layout reads these on the server so the next first paint has the right theme and direction.
    const year = 60 * 60 * 24 * 365;
    document.cookie = `lo-theme=${theme}; path=/; max-age=${year}; samesite=lax`;
    document.cookie = `lo-lang=${language}; path=/; max-age=${year}; samesite=lax`;
  }, [theme, language]);
}

function useLayout(): { layout: Layout; reducedMotion: boolean } {
  const [layout, setLayout] = useState<Layout>('side');
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const side = window.matchMedia('(min-width: 1280px)');
    const phone = window.matchMedia('(max-width: 899px)');
    const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setLayout(side.matches ? 'side' : phone.matches ? 'phone' : 'overlay');
      setReducedMotion(rm.matches);
    };
    update();
    side.addEventListener('change', update);
    phone.addEventListener('change', update);
    rm.addEventListener('change', update);
    return () => {
      side.removeEventListener('change', update);
      phone.removeEventListener('change', update);
      rm.removeEventListener('change', update);
    };
  }, []);
  return { layout, reducedMotion };
}

function initialPeek(view: MissionView, initialTarget: Target | null | undefined) {
  const t = initialTarget ? targetToPeek(initialTarget) : view.focus ? targetToPeek(view.focus.target) : null;
  if (!t) return null;
  if (t.kind === 'artifact' && !view.artifacts[t.artifactId]) return null;
  const a = t.kind === 'artifact' ? view.artifacts[t.artifactId] : null;
  return { target: t, auto: !initialTarget, wide: !!a?.preferWide, half: false };
}

function WorkspaceInner(props: MissionWorkspaceProps) {
  const { view, missions, connection, commands, host, theme, language } = props;
  const { layout, reducedMotion } = useLayout();
  const [ui, dispatch] = useReducer(uiReducer, undefined, () => initialUi(initialPeek(view, props.initialTarget)));
  const [states, setStates] = useState<CommandStates>({});
  const ledger = useRef<CommandLedger | null>(null);
  if (!ledger.current) ledger.current = new CommandLedger(setStates);
  const versionRef = useRef(view.ledgerVersion);
  versionRef.current = view.ledgerVersion;
  const [announcement, setAnnouncement] = useState('');
  const [compose, setCompose] = useState<ComposeRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [signOut, setSignOut] = useState<{ phase: 'idle' | 'busy' | 'failed'; reason: string }>({ phase: 'idle', reason: '' });
  const signOutBusy = useRef(false);
  const opener = useRef<Element | null>(null);
  const paletteReturn = useRef<Element | null>(null);
  const initialEntries = useRef<Set<string>>(new Set(view.entries.map(e => e.id)));
  const mainRef = useRef<HTMLElement>(null);
  const t = useCallback((k: Parameters<typeof translate>[1], v?: Parameters<typeof translate>[2]) => translate(language, k, v), [language]);

  useEffect(() => {
    ledger.current?.ledgerAdvanced(view.ledgerVersion);
  }, [view.ledgerVersion]);

  const announce = useCallback((m: string) => {
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(m), 30);
  }, []);

  const run = useCallback<WorkspaceApi['run']>(
    (key, exec) =>
      ledger.current
        ? ledger.current.run(
            key,
            {
              missionId: view.missionId,
              ledgerVersion: view.ledgerVersion,
              connection: connection.status,
              currentVersion: () => versionRef.current,
            },
            exec,
          )
        : Promise.resolve(null),
    [view.missionId, view.ledgerVersion, connection.status],
  );

  const canDecide = view.access.canDecide && view.status !== 'ended';
  const canMessage = view.access.canMessage;

  const openPeek = useCallback(
    (target: PeekTarget, el: Element | null | undefined, auto = false) => {
      if (target.kind === 'artifact' && !view.artifacts[target.artifactId]) return;
      if (!auto) opener.current = el ?? document.activeElement;
      const a = target.kind === 'artifact' ? view.artifacts[target.artifactId] : null;
      dispatch({ type: 'open', target, auto, wide: !!a?.preferWide && layout !== 'phone' });
      if (target.kind === 'artifact' && target.frameId)
        dispatch({ type: 'camera', artifactId: target.artifactId, frameId: target.frameId });
    },
    [view.artifacts, layout],
  );

  const open = useCallback<WorkspaceApi['open']>(
    (target, el) => {
      switch (target.kind) {
        case 'decision': {
          if (layout !== 'side' && ui.peek && !ui.peek.auto) dispatch({ type: 'close' });
          if (ui.moment && ui.moment.ids.includes(target.decisionId)) {
            document.getElementById('ritual')?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
            return;
          }
          dispatch({ type: 'flash', id: target.decisionId });
          return;
        }
        case 'entry': {
          const node = document.querySelector(`[data-e="${CSS.escape(target.entryId)}"]`);
          node?.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
          return;
        }
        case 'readiness':
          openPeek({ kind: 'system', view: 'readiness' }, el);
          if (target.level) dispatch({ type: 'readinessSel', outcome: target.outcome, level: target.level });
          return;
        default: {
          const p = targetToPeek(target);
          if (p) openPeek(p, el);
        }
      }
    },
    [layout, ui.peek, ui.moment, reducedMotion, openPeek],
  );

  const closePeek = useCallback(() => dispatch({ type: 'close' }), []);
  const restoreFocus = useCallback(() => {
    const el = opener.current;
    opener.current = null;
    if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
  }, []);

  const send = useCallback<WorkspaceApi['send']>(
    async (text: string, context?: MessageContext) => {
      const r = await run('message', base => commands.sendMessage({ ...base, text, ...(context ? { context } : {}) }));
      return !!r?.ok;
    },
    [run, commands],
  );

  const openPalette = useCallback(() => {
    paletteReturn.current = document.activeElement;
    dispatch({ type: 'palette', open: true });
  }, []);
  const closePalette = useCallback(() => {
    dispatch({ type: 'palette', open: false });
    // Restore focus immediately so it is never left on a removed element.
    const el = paletteReturn.current;
    paletteReturn.current = null;
    if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
    else document.querySelector<HTMLElement>('[data-composer]')?.focus({ preventScroll: true });
  }, []);

  const startMoment = useCallback(() => {
    if (!view.moment) return;
    const ids = momentDecisionIds(view);
    if (!ids.length) return;
    dispatch({ type: 'momentStart', momentId: view.moment.id, ids });
    window.requestAnimationFrame(() =>
      document.getElementById('ritual')?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' }),
    );
  }, [view, reducedMotion]);

  const api: WorkspaceApi = useMemo(
    () => ({
      view,
      missions,
      connection,
      commands,
      host,
      theme,
      language,
      layout,
      reducedMotion,
      ui,
      dispatch,
      isNewEntry: (id: string) => !initialEntries.current.has(id),
      open,
      closePeek,
      run,
      commandState: (key: string) => states[key],
      commandStates: states,
      clearCommand: (key: string) => ledger.current?.clear(key),
      send,
      announce,
      compose: (context, label) => setCompose(c => ({ context, label: label ?? null, n: (c?.n ?? 0) + 1 })),
      canDecide,
      canMessage,
      openPalette,
      startMoment,
    }),
    [
      view,
      missions,
      connection,
      commands,
      host,
      theme,
      language,
      layout,
      reducedMotion,
      ui,
      open,
      closePeek,
      run,
      states,
      send,
      announce,
      canDecide,
      canMessage,
      openPalette,
      startMoment,
    ],
  );

  // OD-U4: open the decision moment on return when two or more decisions wait.
  // Judged once against the view the founder returned to, not re-run as the ledger moves.
  const autoMomentDone = useRef(false);
  useEffect(() => {
    if (autoMomentDone.current) return;
    autoMomentDone.current = true;
    if (view.moment?.autoOpen && momentDecisionIds(view).length >= 2) startMoment();
  }, [view, startMoment]);

  // The peek follows the ritual: quotes, then money, then the next canvas (J3). Wide screens only.
  // Keyed on the ritual step only: ledger updates mid-step must not pull the peek back from where the founder moved it.
  const momentIdx = ui.moment ? `${ui.moment.momentId}:${ui.moment.index}` : '';
  const showMomentEvidence = useEffectEvent(() => {
    if (!ui.moment || layout !== 'side') return;
    const id = ui.moment.ids[ui.moment.index];
    const d = id ? view.decisions[id] : null;
    const ev = d?.evidence;
    if (!ev) return;
    if ('system' in ev) openPeek({ kind: 'system', view: ev.system }, null, true);
    else openPeek({ kind: 'artifact', artifactId: ev.artifactId, ...(ev.frameId ? { frameId: ev.frameId } : {}) }, null, true);
  });
  useEffect(() => {
    if (momentIdx) showMomentEvidence();
  }, [momentIdx, layout]);

  // Camera-to-change: when the agent requests a new focus, follow it if the founder is not
  // looking at something else; otherwise the peek shows a badge (FR-UX-03).
  const focusKey = view.focus ? targetKey(view.focus.target) : '';
  const firstFocus = useRef(true);
  // Reads the current peek and layout when the focus target changes; those changing alone is not a new request.
  const followFocus = useEffectEvent(() => {
    if (!view.focus || layout !== 'side' || ui.moment) return;
    const p = targetToPeek(view.focus.target);
    if (!p) return;
    if (ui.peek && !ui.peek.auto) return;
    openPeek(p, null, true);
  });
  useEffect(() => {
    if (firstFocus.current) {
      firstFocus.current = false;
      return;
    }
    followFocus();
  }, [focusKey]);

  // Announce decision resolutions from the ledger (live region, UX 12.3).
  const prevStatus = useRef<Record<string, string>>(Object.fromEntries(Object.values(view.decisions).map(d => [d.id, d.status])));
  useEffect(() => {
    const prev = prevStatus.current;
    for (const d of Object.values(view.decisions)) {
      const was = prev[d.id];
      if (was === 'pending' && d.status !== 'pending') {
        const o = d.options.find(x => x.id === d.resolution?.optionId);
        announce(
          d.status === 'deferred'
            ? `${t('deferredLabel')}: ${d.question}`
            : `${d.resolution?.how === 'default' ? t('defaultApplied') : t('youChose')}: ${o?.shortLabel ?? d.topic}`,
        );
      }
    }
    prevStatus.current = Object.fromEntries(Object.values(view.decisions).map(d => [d.id, d.status]));
  }, [view.decisions, announce, t]);

  // New entries: bring them into view when the founder is near the end or just acted.
  const entryCount = view.entries.length;
  const prevCount = useRef(entryCount);
  // Only a growing entry count scrolls; edits to existing entries and command-state churn do not.
  const revealNewest = useEffectEvent(() => {
    const main = mainRef.current;
    if (!main) return;
    const nearEnd = main.scrollHeight - main.scrollTop - main.clientHeight < 400;
    const acted = Object.keys(states).length > 0;
    if (nearEnd || acted) {
      const last = view.entries[view.entries.length - 1];
      const node = last ? main.querySelector(`[data-e="${CSS.escape(last.id)}"]`) : null;
      node?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
    }
  });
  useEffect(() => {
    const grew = entryCount > prevCount.current;
    prevCount.current = entryCount;
    if (grew) revealNewest();
  }, [entryCount]);

  const actions = useMemo(() => decisionActionsFor(api, t), [api, t]);

  // Keyboard (UX 10): ⌘K anywhere; Esc closes the innermost layer; R / M / L peeks; A / D / Enter / 1-4 on the active decision.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      // Anything a control already handled (palette, composer, dial, canvas) is not a shortcut.
      if (e.defaultPrevented || e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'k') {
        e.preventDefault();
        if (ui.palette) closePalette();
        else openPalette();
        return;
      }
      if (ui.palette) return;
      const active = document.activeElement;
      const inField = !!active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || (active as HTMLElement).isContentEditable);
      if (k === 'Escape') {
        if (inField && active?.hasAttribute('data-composer')) return;
        if (ui.inspector) {
          dispatch({ type: 'inspect', artifactId: ui.inspector.artifactId, frameId: null });
          return;
        }
        if (ui.peek && !(ui.peek.auto && layout !== 'side')) {
          dispatch({ type: 'close' });
          return;
        }
        if (ui.moment) {
          dispatch({ type: 'momentEnd' });
          announce(t('momentLeft'));
        }
        return;
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
      if (k === '/') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[data-composer]')?.focus();
        return;
      }
      const lk = k.toLowerCase();
      const sys = lk === 'r' ? 'readiness' : lk === 'm' ? 'money' : lk === 'l' ? 'log' : null;
      if (sys) {
        e.preventDefault();
        const isOpen = ui.peek?.target.kind === 'system' && ui.peek.target.view === sys && !ui.peek.auto;
        if (isOpen) dispatch({ type: 'close' });
        else openPeek({ kind: 'system', view: sys }, active);
        return;
      }
      const modalPeek = !!ui.peek && !ui.peek.auto && layout !== 'side';
      if (modalPeek || (active && active.closest('.peek'))) return;
      const id = activeDecisionId(view, ui.moment);
      if (!id) return;
      const d = view.decisions[id];
      if (!d) return;
      if (lk === 'a') {
        e.preventDefault();
        void actions.approve(id, d.recommendedOptionId);
      } else if (lk === 'd') {
        e.preventDefault();
        void actions.defer(id);
      } else if (k === 'Enter' && !(active && active.closest('button, a, input, select, textarea, [role="radio"]'))) {
        e.preventDefault();
        void actions.approve(id);
      } else if (/^[1-4]$/.test(k)) {
        const o = d.options[Number(k) - 1];
        if (o) {
          dispatch({ type: 'select', decisionId: id, optionId: o.id });
          dispatch({ type: 'showAll', decisionId: id, value: true });
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ui, view, layout, actions, openPalette, closePalette, openPeek, announce, t]);

  /**
   * Sign out only counts when the server confirms the session cookie is gone. On any failure the
   * workspace stays, says the session is still active, and offers a retry; it never shows /login falsely.
   */
  const signOutNow = useCallback(async () => {
    if (signOutBusy.current) return;
    if (connection.status === 'offline') {
      setSignOut({ phase: 'failed', reason: t('offlineAction') });
      return;
    }
    signOutBusy.current = true;
    setSignOut({ phase: 'busy', reason: '' });
    announce(t('signingOut'));
    try {
      await (host.signOut ?? endSession)();
    } catch (e) {
      signOutBusy.current = false;
      setSignOut({ phase: 'failed', reason: e instanceof Error ? e.message : '' });
      announce(t('signOutFailed', { reason: '' }));
      return;
    }
    window.location.assign('/login');
  }, [connection.status, host, announce, t]);

  const runItem = useCallback(
    (it: PaletteItem) => {
      const a = it.action;
      switch (a.k) {
        case 'say':
          void send(a.text);
          return;
        case 'open':
          open(a.target, null);
          return;
        case 'mission':
          host.selectMission(a.id);
          return;
        case 'newMission':
          void run('mission:new', base => commands.createMission({ idempotencyKey: base.idempotencyKey })).then(r => {
            if (r?.ok && r.missionId) host.selectMission(r.missionId);
          });
          return;
        case 'moment':
          startMoment();
          return;
        case 'change':
          void actions.change(a.decisionId);
          return;
        case 'theme':
          host.setPreferences({ theme: a.theme });
          return;
        case 'lang':
          host.setPreferences({ language: a.lang });
          return;
        case 'chapter':
          dispatch({ type: 'toggle', key: 'chapter', value: true });
          window.requestAnimationFrame(() =>
            document.querySelector('.chapter')?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' }),
          );
          return;
        case 'status':
          void run('mission:status', base => commands.setMissionStatus({ ...base, status: a.status }));
          return;
        case 'deleteMission':
          setDeleting(true);
          return;
        case 'signOut':
          void signOutNow();
          return;
      }
    },
    [send, open, host, run, commands, startMoment, actions, reducedMotion, signOutNow],
  );

  const showPeek = !!ui.peek && !(ui.peek.auto && layout !== 'side');
  const peeking = !!ui.peek && (!ui.peek.wide || layout !== 'side');
  return (
    <WorkspaceContext.Provider value={api}>
      <div className={`app${peeking ? ' peeking' : ''}`}>
        <a className="skip" href="#page">
          {t('skipToPage')}
        </a>
        <StatusStrip />
        <Banners />
        {signOut.phase !== 'idle' ? (
          <div className="banner warn signout" role={signOut.phase === 'failed' ? 'alert' : 'status'}>
            {signOut.phase === 'busy' ? <span className="spin" aria-hidden="true" /> : null}
            <span className="grow">{signOut.phase === 'busy' ? t('signingOut') : t('signOutFailed', { reason: signOut.reason })}</span>
            {signOut.phase === 'failed' ? (
              <>
                <button type="button" className="btn line sm" onClick={() => void signOutNow()}>
                  {t('retry')}
                </button>
                <button type="button" className="btn quiet sm" onClick={() => setSignOut({ phase: 'idle', reason: '' })}>
                  {t('signOutStay')}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="below">
          <MissionRail
            onNewMission={() =>
              void run('mission:new', base => commands.createMission({ idempotencyKey: base.idempotencyKey })).then(r => {
                if (r?.ok && r.missionId) host.selectMission(r.missionId);
              })
            }
          />
          <main className="main" id="main" ref={mainRef}>
            <MissionPage />
          </main>
          {showPeek ? (
            <Peek
              onClose={() => {
                dispatch({ type: 'close' });
              }}
              restoreTo={restoreFocus}
            />
          ) : null}
        </div>
        <Composer request={compose} onRun={runItem} />
        {ui.palette ? (
          <CommandPalette
            onRun={it => {
              closePalette();
              runItem(it);
            }}
            onClose={closePalette}
          />
        ) : null}
        {deleting ? <DeleteMissionDialog onClose={() => setDeleting(false)} /> : null}
        <div className="live" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
