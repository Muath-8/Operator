import { describe, expect, it } from 'vitest';
import type { CommandBase, CommandResult } from '../../ui-contract';
import { CommandLedger, type CommandStates } from './commandRunner';

const ctx = (version = 10, connection: 'live' | 'offline' = 'live') => ({
  missionId: 'm1',
  ledgerVersion: version,
  connection,
  currentVersion: () => version,
});
const deferred = () => {
  let resolve!: (r: CommandResult) => void;
  const promise = new Promise<CommandResult>(r => (resolve = r));
  return { promise, resolve };
};

describe('CommandLedger (no faked success, no double effects)', () => {
  it('ignores a second approval while the first is pending', async () => {
    const states: CommandStates[] = [];
    const ledger = new CommandLedger(s => states.push(s));
    const calls: CommandBase[] = [];
    const d = deferred();
    const first = ledger.run('decision:d1', ctx(), base => (calls.push(base), d.promise));
    const second = await ledger.run('decision:d1', ctx(), base => (calls.push(base), d.promise));
    expect(second).toBeNull();
    expect(calls).toHaveLength(1);
    d.resolve({ ok: true, ledgerVersion: 11 });
    await first;
    // Still busy until the ledger reaches version 11.
    expect(ledger.isBusy('decision:d1')).toBe(true);
    expect(await ledger.run('decision:d1', ctx(), base => (calls.push(base), d.promise))).toBeNull();
    ledger.ledgerAdvanced(11);
    expect(ledger.isBusy('decision:d1')).toBe(false);
  });

  it('does not report success before the ledger shows it', async () => {
    let snapshot: CommandStates = {};
    const ledger = new CommandLedger(s => (snapshot = s));
    await ledger.run('decision:d1', ctx(10), async () => ({ ok: true, ledgerVersion: 12 }));
    expect(snapshot['decision:d1']?.phase).toBe('awaiting');
    ledger.ledgerAdvanced(11);
    expect(snapshot['decision:d1']?.phase).toBe('awaiting');
    ledger.ledgerAdvanced(12);
    expect(snapshot['decision:d1']).toBeUndefined();
  });

  it('clears immediately when the view already caught up while the command ran', async () => {
    let snapshot: CommandStates = {};
    let version = 10;
    const ledger = new CommandLedger(s => (snapshot = s));
    await ledger.run('m', { ...ctx(10), currentVersion: () => version }, async () => {
      version = 11;
      return { ok: true, ledgerVersion: 11 };
    });
    expect(snapshot['m']).toBeUndefined();
  });

  it('reuses the idempotency key when retrying a failed attempt (I-4)', async () => {
    const ledger = new CommandLedger(() => undefined);
    const keys: string[] = [];
    await ledger.run(
      'decision:d1',
      ctx(),
      async b => (keys.push(b.idempotencyKey), { ok: false, error: { code: 'unavailable', message: 'timeout', retryable: true } }),
    );
    await ledger.run('decision:d1', ctx(), async b => (keys.push(b.idempotencyKey), { ok: true, ledgerVersion: 10 }));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await ledger.run('decision:d1', ctx(), async b => (keys.push(b.idempotencyKey), { ok: true, ledgerVersion: 10 }));
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('treats a thrown transport error as a retryable failure', async () => {
    let snapshot: CommandStates = {};
    const ledger = new CommandLedger(s => (snapshot = s));
    const r = await ledger.run('message', ctx(), async () => {
      throw new Error('network');
    });
    expect(r?.ok).toBe(false);
    expect(snapshot['message']?.phase).toBe('error');
    expect(snapshot['message']?.error?.retryable).toBe(true);
  });

  it('never sends while offline and reports it, so inputs are kept', async () => {
    let snapshot: CommandStates = {};
    const ledger = new CommandLedger(s => (snapshot = s));
    let called = false;
    const r = await ledger.run('message', ctx(10, 'offline'), async () => ((called = true), { ok: true, ledgerVersion: 11 }));
    expect(called).toBe(false);
    expect(r).toEqual({ ok: false, error: { code: 'offline', message: 'offline', retryable: true } });
    expect(snapshot['message']?.error?.code).toBe('offline');
  });

  it('passes the version the founder saw, for conflict detection', async () => {
    const ledger = new CommandLedger(() => undefined);
    let seen = -1;
    await ledger.run('k', ctx(42), async b => ((seen = b.seenLedgerVersion), { ok: true, ledgerVersion: 42 }));
    expect(seen).toBe(42);
  });
});
