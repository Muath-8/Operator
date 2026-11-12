'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { sessionFetch, renewSession, tokenRefreshDelay } from './session-client';
import { consumeMessageStream } from './message-stream-client';
import type { MessageDraft } from '@lo/state/stream';
import validateMissionView from './mission-view-validator';
import { CommandResultSchema, MissionListSchema } from './client-contracts';
import type {
  CommandResult,
  ConnectionView,
  MissionCommands,
  MissionSummary,
  MissionView,
  Target,
  Theme,
  UiLanguage,
  WorkspaceHost,
} from '../ui-contract';

export interface ControllerOptions {
  initialView: MissionView;
  initialMissions: MissionSummary[];
  initialTheme?: Theme;
  initialLanguage?: UiLanguage;
  local: boolean;
  localBackend?: 'sqlite';
  localAi?: 'simulated' | 'codex';
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}
export function useMissionController(options: ControllerOptions) {
  const [drafts, setDrafts] = useState<MessageDraft[]>([]);
  const [view, setView] = useState(options.initialView);
  const [missions, setMissions] = useState(options.initialMissions);
  const [connection, setConnection] = useState<ConnectionView>({ status: 'connecting', lastSyncedAt: null });
  const [theme, setTheme] = useState<Theme>(options.initialTheme ?? 'light');
  const [language, setLanguage] = useState<UiLanguage>(options.initialLanguage ?? 'en');
  const [missionId, setMissionId] = useState(options.initialView.missionId);
  const targetMission = useRef(missionId);
  targetMission.current = missionId;
  const pending = useRef<Promise<void> | null>(null);
  const syncAgain = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) {
      syncAgain.current = true;
      return pending.current;
    }
    const requested = targetMission.current;
    const work = async () => {
      try {
        const response = await sessionFetch(`/api/missions/${encodeURIComponent(requested)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Snapshot unavailable');
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== 'object' ||
          !('view' in data) ||
          !validateMissionView(data.view) ||
          data.view.missionId !== requested ||
          !Number.isSafeInteger(data.view.ledgerVersion) ||
          data.view.ledgerVersion < 0
        )
          throw new Error('Invalid mission snapshot');
        const received = data.view;
        if (targetMission.current !== requested) return;
        // Late responses never roll the rendered ledger backwards.
        setView(current =>
          current.missionId !== requested
            ? received
            : received.ledgerVersion >= current.ledgerVersion
              ? { ...received, sinceYouLeft: received.sinceYouLeft ?? current.sinceYouLeft }
              : current,
        );
        setConnection({ status: 'live', lastSyncedAt: new Date().toISOString() });
      } catch {
        if (targetMission.current === requested)
          setConnection(previous => ({ ...previous, status: navigator.onLine ? 'reconnecting' : 'offline' }));
      }
    };
    pending.current = work();
    try {
      await pending.current;
    } finally {
      pending.current = null;
      if (syncAgain.current) {
        syncAgain.current = false;
        void refresh();
      }
    }
  }, []);
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('lo-preferences') ?? '{}') as { theme?: Theme; language?: UiLanguage };
      if (stored.theme === 'light' || stored.theme === 'dark') setTheme(stored.theme);
      if (stored.language === 'en' || stored.language === 'ar') setLanguage(stored.language);
    } catch {
      localStorage.removeItem('lo-preferences');
    }
  }, []);
  useEffect(() => {
    const online = () => {
      setConnection(previous => ({ ...previous, status: 'reconnecting' }));
      void refresh();
    };
    const offline = () => setConnection(previous => ({ ...previous, status: 'offline' }));
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [refresh]);
  useEffect(() => {
    if (options.localBackend === 'sqlite') return;
    let touched = Date.now();
    const touch = () => {
      touched = Date.now();
    };
    const ping = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus() || !navigator.onLine) return;
      void sessionFetch(`/api/missions/${encodeURIComponent(missionId)}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: Date.now() - touched < 60000 }),
      }).catch(() => {
        /* Optional effort measurement retries on the next heartbeat; no business state is inferred. */
      });
    };
    document.addEventListener('pointerdown', touch);
    document.addEventListener('keydown', touch);
    document.addEventListener('scroll', touch, true);
    const timer = setInterval(ping, 30000);
    ping();
    return () => {
      clearInterval(timer);
      document.removeEventListener('pointerdown', touch);
      document.removeEventListener('keydown', touch);
      document.removeEventListener('scroll', touch, true);
    };
  }, [missionId, options.localBackend]);
  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    setConnection(previous => ({ ...previous, status: 'connecting' }));
    void refresh();
    if (options.local) {
      // Local PostgreSQL has no Supabase transport. This explicit development
      // mode polls the same authenticated ledger projection, never fixture state.
      const timer = setInterval(() => {
        if (navigator.onLine) void refresh();
      }, 1000);
      cleanup = () => clearInterval(timer);
    } else if (options.supabaseUrl && options.supabaseAnonKey) {
      const client = createClient(options.supabaseUrl, options.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let channel: ReturnType<typeof client.channel> | undefined;
      cleanup = () => {
        if (timer) clearTimeout(timer);
        if (channel) void client.removeChannel(channel);
      };
      const connect = async (renew = false) => {
        try {
          if (renew && !(await renewSession())) throw new Error('Session renewal pending');
          const response = await sessionFetch('/api/realtime-token', { cache: 'no-store' });
          if (!response.ok) throw new Error('Realtime authentication expired');
          const data = (await response.json()) as { token: string };
          if (cancelled) return;
          await client.realtime.setAuth(data.token);
          if (cancelled) return;
          if (!channel)
            channel = client
              .channel(`mission:${missionId}`, { config: { private: true } })
              .on('broadcast', { event: 'ledger.changed' }, () => {
                void refresh();
              })
              .subscribe(status => {
                if (cancelled) return;
                if (status === 'SUBSCRIBED') void refresh();
                else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
                  setConnection(previous => ({ ...previous, status: 'reconnecting' }));
              });
          timer = setTimeout(() => {
            void connect(true);
          }, tokenRefreshDelay(data.token));
        } catch {
          if (!cancelled) {
            setConnection(previous => ({ ...previous, status: 'reconnecting' }));
            timer = setTimeout(() => {
              void connect();
            }, 10000);
          }
        }
      };
      void connect();
    } else setConnection(previous => ({ ...previous, status: 'offline' }));
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [missionId, options.local, options.supabaseUrl, options.supabaseAnonKey, refresh]);
  useEffect(() => {
    if (options.localBackend === 'sqlite') return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    setDrafts([]);
    const connect = async () => {
      try {
        const response = await sessionFetch(`/api/missions/${encodeURIComponent(missionId)}/stream`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        await consumeMessageStream(
          response,
          missionId,
          next => {
            if (!controller.signal.aborted && targetMission.current === missionId) setDrafts(next);
          },
          controller.signal,
        );
      } catch {
        if (!controller.signal.aborted && targetMission.current === missionId) setDrafts([]);
      }
      if (!controller.signal.aborted)
        retry = setTimeout(() => {
          void connect();
        }, 1000);
    };
    void connect();
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [missionId, options.localBackend]);
  const execute = useCallback(
    async (kind: keyof MissionCommands, input: unknown): Promise<CommandResult> => {
      if (!navigator.onLine)
        return { ok: false, error: { code: 'offline', message: 'Reconnect to submit this change. Your input is kept.', retryable: true } };
      try {
        const response = await sessionFetch(kind === 'createMission' ? '/api/missions/create' : '/api/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(input as object), kind }),
        });
        const result = CommandResultSchema.parse(await response.json());
        if (result.ok && !response.ok) throw new Error('Unexpected command success status');
        if (result.ok) {
          await refresh();
          const list = await sessionFetch('/api/missions', { cache: 'no-store' });
          if (list.ok) {
            const parsed = MissionListSchema.safeParse(await list.json());
            if (parsed.success) setMissions(parsed.data.missions);
          }
          if (result.downloadUrl) {
            const url = new URL(result.downloadUrl, window.location.origin);
            if (url.origin !== window.location.origin || url.username || url.password) throw new Error('Unexpected download destination');
            window.location.assign(url.href);
          }
          if (result.redirectUrl) {
            const url = new URL(result.redirectUrl, window.location.origin);
            if (
              !url.username &&
              !url.password &&
              (url.origin === window.location.origin ||
                (url.protocol === 'https:' && !url.port && ['www.paypal.com', 'www.sandbox.paypal.com'].includes(url.hostname)))
            )
              window.location.assign(url.href);
            else throw new Error('Unexpected approval destination');
          }
        }
        return result;
      } catch {
        return {
          ok: false,
          error: { code: 'unavailable', message: 'The connection was interrupted. Retry this same request.', retryable: true },
        };
      }
    },
    [refresh],
  );
  const commands = useMemo<MissionCommands>(
    () => ({
      resolveDecision: i => execute('resolveDecision', i),
      deferDecision: i => execute('deferDecision', i),
      requestChange: i => execute('requestChange', i),
      confirmChange: i => execute('confirmChange', i),
      keepDecision: i => execute('keepDecision', i),
      justGo: i => execute('justGo', i),
      completeMoment: i => execute('completeMoment', i),
      sendMessage: i => execute('sendMessage', i),
      answerQuestion: i => execute('answerQuestion', i),
      setHelpMode: i => execute('setHelpMode', i),
      approveDraft: i => execute('approveDraft', i),
      discardDraft: i => execute('discardDraft', i),
      retryStep: i => execute('retryStep', i),
      requestVariation: i => execute('requestVariation', i),
      runArtifactAction: i => execute('runArtifactAction', i),
      setMandateStatus: i => execute('setMandateStatus', i),
      setMissionStatus: i => execute('setMissionStatus', i),
      setTraceRetention: i => execute('setTraceRetention', i),
      keepRetainedContent: i => execute('keepRetainedContent', i),
      markNotificationsRead: i => execute('markNotificationsRead', i),
      updateNotificationSettings: i => execute('updateNotificationSettings', i),
      exportLaunchRecord: i => execute('exportLaunchRecord', i),
      createMission: i => execute('createMission', i),
    }),
    [execute],
  );
  const host = useMemo<WorkspaceHost>(
    () => ({
      selectMission: id => {
        targetMission.current = id;
        setMissionId(id);
        history.replaceState(null, '', `/?mission=${encodeURIComponent(id)}`);
      },
      setPreferences: prefs => {
        const next = { theme: prefs.theme ?? theme, language: prefs.language ?? language };
        setTheme(next.theme);
        setLanguage(next.language);
        localStorage.setItem('lo-preferences', JSON.stringify(next));
        document.cookie = `lo-theme=${next.theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
        document.cookie = `lo-lang=${next.language}; Path=/; Max-Age=31536000; SameSite=Lax`;
      },
      buildHref: (target: Target) => `/?mission=${missionId}&target=${encodeURIComponent(JSON.stringify(target))}`,
    }),
    [theme, language, missionId],
  );
  const streamedView = useMemo<MissionView>(
    () => ({
      ...view,
      entries: [
        ...view.entries,
        ...drafts
          .filter(d => d.text.length > 0)
          .map(d => ({
            id: `stream:${d.runId}`,
            author: 'agent' as const,
            at: d.at,
            streaming: true,
            staleNote: null,
            blocks: [{ k: 'prose' as const, paragraphs: [[{ t: 'text' as const, text: d.text }]] }],
          })),
      ],
    }),
    [view, drafts],
  );
  return { view: streamedView, missions, connection, commands, host, theme, language };
}
