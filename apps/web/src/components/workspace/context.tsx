'use client';

import { createContext, useContext, type Dispatch } from 'react';
import type {
  CommandBase,
  CommandResult,
  ConnectionView,
  MessageContext,
  MissionCommands,
  MissionSummary,
  MissionView,
  Target,
  Theme,
  UiLanguage,
  WorkspaceHost,
} from '../../ui-contract';
import type { CommandState, CommandStates } from './commandRunner';
import type { UiAction, UiState } from './uiState';

export type Layout = 'side' | 'overlay' | 'phone';

export interface WorkspaceApi {
  readonly view: MissionView;
  readonly missions: readonly MissionSummary[];
  readonly connection: ConnectionView;
  readonly commands: MissionCommands;
  readonly host: WorkspaceHost;
  readonly theme: Theme;
  readonly language: UiLanguage;
  readonly layout: Layout;
  readonly reducedMotion: boolean;
  readonly ui: UiState;
  readonly dispatch: Dispatch<UiAction>;
  /** Entries present at first render do not animate; newly arriving ones stream in. */
  readonly isNewEntry: (id: string) => boolean;
  /** Open a target: artifacts and system views in the peek; decisions and entries scroll and flash. */
  readonly open: (target: Target, opener?: Element | null) => void;
  readonly closePeek: () => void;
  readonly run: (key: string, exec: (base: CommandBase) => Promise<CommandResult>) => Promise<CommandResult | null>;
  readonly commandState: (key: string) => CommandState | undefined;
  readonly commandStates: CommandStates;
  readonly clearCommand: (key: string) => void;
  /** Send a founder message (composer, suggestions, inspector comments). Resolves true when accepted. */
  readonly send: (text: string, context?: MessageContext) => Promise<boolean>;
  readonly announce: (message: string) => void;
  /** Focus the composer with a context attached (comment on a draft, a frame, a decision). */
  readonly compose: (context: MessageContext | null, label?: string) => void;
  readonly canDecide: boolean;
  readonly canMessage: boolean;
  readonly openPalette: () => void;
  readonly startMoment: () => void;
}

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside MissionWorkspace');
  return ctx;
}

export type { Dispatch };
