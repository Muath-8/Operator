import type { Outcome, ReadinessLevel, StepLabel, SystemPeek, Target } from '../../ui-contract';

/**
 * Presentation state only: what is open, selected or expanded. Nothing here is binding;
 * decisions, money, mandates and readiness come from the MissionView alone.
 */
export type PeekTarget =
  | { readonly kind: 'artifact'; readonly artifactId: string; readonly frameId?: string }
  | { readonly kind: 'system'; readonly view: SystemPeek };

export interface PeekState {
  readonly target: PeekTarget;
  /** Opened by the agent's focus on load: shown only where there is room beside the page. */
  readonly auto: boolean;
  readonly wide: boolean;
  /** Bottom-sheet snap on phones. */
  readonly half: boolean;
}

export interface MomentState {
  readonly momentId: string;
  readonly ids: readonly string[];
  readonly index: number;
  readonly done: readonly { readonly id: string; readonly text: string }[];
}

export interface UiState {
  readonly peek: PeekState | null;
  readonly history: readonly PeekTarget[];
  readonly historyIndex: number;
  readonly inspector: { readonly artifactId: string; readonly frameId: string } | null;
  readonly selected: Readonly<Record<string, string>>;
  readonly showAll: Readonly<Record<string, boolean>>;
  readonly whyOpen: Readonly<Record<string, boolean>>;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly moment: MomentState | null;
  readonly palette: boolean;
  readonly flash: { readonly id: string; readonly n: number } | null;
  readonly readinessSel: { readonly outcome: Outcome; readonly level: ReadinessLevel } | null;
  readonly versionView: Readonly<Record<string, string>>;
  readonly logFilter: StepLabel | 'all';
  readonly dismissedFocusKey: string | null;
  readonly camera: { readonly artifactId: string; readonly frameId: string; readonly n: number } | null;
  /** Founder edits to a mandate scope before granting; sent with the approval, validated by the server. */
  readonly scopes: Readonly<Record<string, ScopeDraft>>;
  /** Deferred decisions the founder chose to decide now (display only). */
  readonly reopened: Readonly<Record<string, boolean>>;
}

export interface ScopeDraft {
  readonly ceilingMajor: string;
  readonly count: string;
  readonly expiresOn: string;
}

export const initialUi = (peek: PeekState | null): UiState => ({
  peek,
  history: peek ? [peek.target] : [],
  historyIndex: peek ? 0 : -1,
  inspector: null,
  selected: {},
  showAll: {},
  whyOpen: {},
  expanded: {},
  moment: null,
  palette: false,
  flash: null,
  readinessSel: null,
  versionView: {},
  logFilter: 'all',
  dismissedFocusKey: null,
  camera: null,
  scopes: {},
  reopened: {},
});

export type UiAction =
  | { readonly type: 'open'; readonly target: PeekTarget; readonly auto?: boolean; readonly wide?: boolean }
  | { readonly type: 'close' }
  | { readonly type: 'wide'; readonly wide: boolean }
  | { readonly type: 'half'; readonly half: boolean }
  | { readonly type: 'history'; readonly step: -1 | 1 }
  | { readonly type: 'inspect'; readonly artifactId: string; readonly frameId: string | null }
  | { readonly type: 'select'; readonly decisionId: string; readonly optionId: string }
  | { readonly type: 'showAll'; readonly decisionId: string; readonly value?: boolean }
  | { readonly type: 'why'; readonly decisionId: string }
  | { readonly type: 'toggle'; readonly key: string; readonly value?: boolean }
  | { readonly type: 'momentStart'; readonly momentId: string; readonly ids: readonly string[] }
  | { readonly type: 'momentAdvance'; readonly id: string; readonly text: string }
  | { readonly type: 'momentEnd' }
  | { readonly type: 'palette'; readonly open: boolean }
  | { readonly type: 'flash'; readonly id: string }
  | { readonly type: 'readinessSel'; readonly outcome: Outcome; readonly level: ReadinessLevel }
  | { readonly type: 'viewVersion'; readonly frameKey: string; readonly versionId: string }
  | { readonly type: 'logFilter'; readonly filter: StepLabel | 'all' }
  | { readonly type: 'dismissFocus'; readonly key: string }
  | { readonly type: 'camera'; readonly artifactId: string; readonly frameId: string }
  | { readonly type: 'scope'; readonly decisionId: string; readonly draft: ScopeDraft }
  | { readonly type: 'reopen'; readonly decisionId: string }
  | { readonly type: 'reset' };

export const sameTarget = (a: PeekTarget | null | undefined, b: PeekTarget | null | undefined): boolean => {
  if (!a || !b) return false;
  if (a.kind === 'system' && b.kind === 'system') return a.view === b.view;
  if (a.kind === 'artifact' && b.kind === 'artifact') return a.artifactId === b.artifactId;
  return false;
};

export function uiReducer(s: UiState, a: UiAction): UiState {
  switch (a.type) {
    case 'open': {
      const same = s.peek && sameTarget(s.peek.target, a.target);
      const history = same ? s.history : [...s.history.slice(0, s.historyIndex + 1), a.target].slice(-20);
      return {
        ...s,
        peek: { target: a.target, auto: a.auto ?? false, wide: a.wide ?? (same && s.peek ? s.peek.wide : false), half: false },
        history,
        historyIndex: same ? s.historyIndex : history.length - 1,
        inspector: same ? s.inspector : null,
      };
    }
    case 'close':
      return { ...s, peek: null, inspector: null };
    case 'wide':
      return s.peek ? { ...s, peek: { ...s.peek, wide: a.wide } } : s;
    case 'half':
      return s.peek ? { ...s, peek: { ...s.peek, half: a.half } } : s;
    case 'history': {
      const i = s.historyIndex + a.step;
      const target = s.history[i];
      if (!target) return s;
      return { ...s, historyIndex: i, peek: { target, auto: false, wide: s.peek?.wide ?? false, half: false }, inspector: null };
    }
    case 'inspect':
      return { ...s, inspector: a.frameId ? { artifactId: a.artifactId, frameId: a.frameId } : null };
    case 'select':
      return { ...s, selected: { ...s.selected, [a.decisionId]: a.optionId } };
    case 'showAll':
      return { ...s, showAll: { ...s.showAll, [a.decisionId]: a.value ?? !s.showAll[a.decisionId] } };
    case 'why':
      return { ...s, whyOpen: { ...s.whyOpen, [a.decisionId]: !s.whyOpen[a.decisionId] } };
    case 'toggle':
      return { ...s, expanded: { ...s.expanded, [a.key]: a.value ?? !s.expanded[a.key] } };
    case 'momentStart':
      return { ...s, moment: { momentId: a.momentId, ids: a.ids, index: 0, done: [] } };
    case 'momentAdvance':
      if (!s.moment) return s;
      return { ...s, moment: { ...s.moment, index: s.moment.index + 1, done: [...s.moment.done, { id: a.id, text: a.text }] } };
    case 'momentEnd':
      return { ...s, moment: null };
    case 'palette':
      return { ...s, palette: a.open };
    case 'flash':
      return { ...s, flash: { id: a.id, n: (s.flash?.n ?? 0) + 1 } };
    case 'readinessSel':
      return {
        ...s,
        readinessSel:
          s.readinessSel && s.readinessSel.outcome === a.outcome && s.readinessSel.level === a.level
            ? null
            : { outcome: a.outcome, level: a.level },
      };
    case 'viewVersion':
      return { ...s, versionView: { ...s.versionView, [a.frameKey]: a.versionId } };
    case 'logFilter':
      return { ...s, logFilter: a.filter };
    case 'dismissFocus':
      return { ...s, dismissedFocusKey: a.key };
    case 'camera':
      return { ...s, camera: { artifactId: a.artifactId, frameId: a.frameId, n: (s.camera?.n ?? 0) + 1 } };
    case 'scope':
      return { ...s, scopes: { ...s.scopes, [a.decisionId]: a.draft } };
    case 'reopen':
      return { ...s, reopened: { ...s.reopened, [a.decisionId]: true } };
    case 'reset':
      return initialUi(null);
  }
}

export function targetToPeek(t: Target): PeekTarget | null {
  switch (t.kind) {
    case 'artifact':
      return { kind: 'artifact', artifactId: t.artifactId, ...(t.frameId ? { frameId: t.frameId } : {}) };
    case 'system':
      return { kind: 'system', view: t.view };
    case 'readiness':
      return { kind: 'system', view: 'readiness' };
    default:
      return null;
  }
}

export const targetKey = (t: Target): string => JSON.stringify(t);
