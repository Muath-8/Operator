import type { CommandBase, CommandError, CommandResult, ConnectionStatus } from '../../ui-contract';

/**
 * Command bookkeeping, framework-free so it can be tested directly.
 *
 * - One attempt per subject key at a time: a second approve while the first is pending is ignored.
 * - Retrying a failed attempt reuses its idempotency key, so a retry can never cause a second effect (I-4).
 * - Success is not shown until the ledger catches up: the subject stays "awaiting" until
 *   view.ledgerVersion reaches the version the server reported (no optimistic binding state).
 * - Offline: the command is not sent; the subject shows an offline error and inputs are kept.
 */
export type CommandPhase = 'running' | 'awaiting' | 'error';

export interface CommandState {
  readonly phase: CommandPhase;
  readonly error?: CommandError;
  readonly awaitVersion?: number;
}

export type CommandStates = Readonly<Record<string, CommandState>>;

export const OFFLINE_ERROR: CommandError = { code: 'offline', message: 'offline', retryable: true };

export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

export interface Attempt {
  readonly key: string;
  readonly idempotencyKey: string;
}

export class CommandLedger {
  private readonly inFlight = new Set<string>();
  private readonly retryKeys = new Map<string, string>();
  private states: Record<string, CommandState> = {};

  constructor(private readonly onChange: (s: CommandStates) => void) {}

  get snapshot(): CommandStates {
    return this.states;
  }

  isBusy(key: string): boolean {
    const s = this.states[key];
    return this.inFlight.has(key) || s?.phase === 'running' || s?.phase === 'awaiting';
  }

  private set(key: string, s: CommandState | null) {
    const next = { ...this.states };
    if (s) next[key] = s;
    else delete next[key];
    this.states = next;
    this.onChange(next);
  }

  clear(key: string) {
    this.retryKeys.delete(key);
    this.set(key, null);
  }

  /** Called whenever a new view arrives. */
  ledgerAdvanced(version: number) {
    let changed = false;
    const next: Record<string, CommandState> = {};
    for (const [k, s] of Object.entries(this.states)) {
      if (s.phase === 'awaiting' && (s.awaitVersion ?? 0) <= version) {
        changed = true;
        continue;
      }
      next[k] = s;
    }
    if (changed) {
      this.states = next;
      this.onChange(next);
    }
  }

  async run(
    key: string,
    ctx: {
      readonly missionId: string;
      readonly ledgerVersion: number;
      readonly connection: ConnectionStatus;
      /** The version currently rendered; the view may have advanced while the command ran. */
      readonly currentVersion: () => number;
    },
    exec: (base: CommandBase) => Promise<CommandResult>,
  ): Promise<CommandResult | null> {
    if (this.isBusy(key)) return null;
    if (ctx.connection === 'offline') {
      this.set(key, { phase: 'error', error: OFFLINE_ERROR });
      return { ok: false, error: OFFLINE_ERROR };
    }
    this.inFlight.add(key);
    const idempotencyKey = this.retryKeys.get(key) ?? newIdempotencyKey();
    this.retryKeys.set(key, idempotencyKey);
    this.set(key, { phase: 'running' });
    let result: CommandResult;
    try {
      result = await exec({ missionId: ctx.missionId, idempotencyKey, seenLedgerVersion: ctx.ledgerVersion });
    } catch (err) {
      result = { ok: false, error: { code: 'unknown', message: err instanceof Error ? err.message : 'unknown', retryable: true } };
    } finally {
      this.inFlight.delete(key);
    }
    if (result.ok) {
      this.retryKeys.delete(key);
      if (result.ledgerVersion > ctx.currentVersion() || result.redirectUrl)
        this.set(key, { phase: 'awaiting', awaitVersion: result.ledgerVersion });
      else this.set(key, null);
    } else {
      if (!result.error.retryable) this.retryKeys.delete(key);
      this.set(key, { phase: 'error', error: result.error });
    }
    return result;
  }
}
