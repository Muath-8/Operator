import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandBase, CommandResult, MissionCommands, MissionView } from '../../ui-contract';
import { translate } from '../../i18n';
import { perfumeMission } from '../../../tests/ui/fixtures/missions.fixture';
import { mandateNonRecommendedScene, mandateScene, mandateZeroScene } from '../../../tests/ui/fixtures/variants.fixture';
import type { WorkspaceApi } from './context';
import { decisionActionsFor, decisionKey } from './useDecisionActions';
import { initialUi, uiReducer, type UiAction, type UiState } from './uiState';

/**
 * Interaction logic behind the decision block, ritual and A / D / Enter keys, driven the way the
 * components drive it: through WorkspaceApi.run and dispatch. Fixtures come from the explicit test
 * harness only. Browser-level behaviour (focus, keys, axe) is covered in tests/ui.
 */
const t = (k: Parameters<typeof translate>[1], v?: Parameters<typeof translate>[2]) => translate('en', k, v);

function harness(view: MissionView, opts: { ui?: Partial<UiState>; canDecide?: boolean; result?: CommandResult | null } = {}) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const dispatched: UiAction[] = [];
  const announced: string[] = [];
  const commands = new Proxy({} as MissionCommands, {
    get: (_t, name: string) => async (input: Record<string, unknown>) => {
      sent.push({ name, input });
      return { ok: true, ledgerVersion: view.ledgerVersion + 1 } satisfies CommandResult;
    },
  });
  const ws = {
    view,
    ui: { ...initialUi(null), ...opts.ui },
    dispatch: (a: UiAction) => dispatched.push(a),
    commands,
    canDecide: opts.canDecide ?? true,
    announce: (m: string) => announced.push(m),
    run: async (key: string, exec: (base: CommandBase) => Promise<CommandResult>) => {
      if (opts.result === null) return null;
      const base: CommandBase = { missionId: view.missionId, idempotencyKey: `k:${key}`, seenLedgerVersion: view.ledgerVersion };
      const res = await exec(base);
      return opts.result ?? res;
    },
  } as unknown as WorkspaceApi;
  return { ws, sent, dispatched, announced, actions: decisionActionsFor(ws, t) };
}

afterEach(() => vi.unstubAllGlobals());

describe('decision actions', () => {
  it('approving the recommended option grants the mandate with the frozen scope', async () => {
    const h = harness(mandateScene());
    await h.actions.approve('d-samples');
    expect(h.sent).toHaveLength(1);
    const call = h.sent[0];
    expect(call?.name).toBe('resolveDecision');
    expect(call?.input).toMatchObject({
      decisionId: 'd-samples',
      response: 'approve',
      optionId: 'grant',
      mandateScope: { ceiling: { amountMinor: 250000, currency: 'SAR' }, count: 4, expiresOn: '2026-11-30' },
    });
  });

  it('a narrowed draft is sent as narrowed; a widened one is refused locally and flagged', async () => {
    const narrowed = harness(mandateScene(), {
      ui: { scopes: { 'd-samples': { ceilingMajor: '1500', count: '2', expiresOn: '2026-11-20' } } },
    });
    await narrowed.actions.approve('d-samples');
    expect(narrowed.sent[0]?.input.mandateScope).toEqual({
      ceiling: { amountMinor: 150000, currency: 'SAR' },
      count: 2,
      expiresOn: '2026-11-20',
    });

    const widened = harness(mandateScene(), {
      ui: { scopes: { 'd-samples': { ceilingMajor: '99999', count: '4', expiresOn: '2026-11-30' } } },
    });
    await widened.actions.approve('d-samples');
    expect(widened.sent).toEqual([]);
    expect(widened.dispatched).toContainEqual({ type: 'flash', id: 'd-samples' });
  });

  it('choosing another option sends no mandate unless that option owns it', async () => {
    const h = harness(mandateScene());
    await h.actions.approve('d-samples', 'tight');
    expect(h.sent[0]?.input).toMatchObject({ response: 'choose', optionId: 'tight' });
    expect(h.sent[0]?.input).not.toHaveProperty('mandateScope');

    const owner = harness(mandateNonRecommendedScene());
    await owner.actions.approve('d-samples');
    expect(owner.sent[0]?.input).not.toHaveProperty('mandateScope');
    await owner.actions.approve('d-samples', 'tight');
    expect(owner.sent[1]?.input).toMatchObject({ optionId: 'tight', mandateScope: { ceiling: { amountMinor: 120000 }, count: 2 } });
  });

  it('a frozen zero-money mandate is granted with a zero ceiling', async () => {
    const h = harness(mandateZeroScene());
    await h.actions.approve('d-samples');
    expect(h.sent[0]?.input.mandateScope).toMatchObject({ ceiling: { amountMinor: 0, currency: 'SAR' }, count: 4 });
  });

  it('does nothing for viewers, unknown options or settled decisions', async () => {
    const viewer = harness(mandateScene(), { canDecide: false });
    await viewer.actions.approve('d-samples');
    await viewer.actions.defer('d-samples');
    await viewer.actions.change('d-samples');
    expect(viewer.sent).toEqual([]);

    const unknown = harness(mandateScene());
    await unknown.actions.approve('d-samples', 'no-such-option');
    await unknown.actions.approve('no-such-decision');
    expect(unknown.sent).toEqual([]);

    const v = mandateScene();
    const settled = harness({ ...v, decisions: { ...v.decisions, 'd-samples': { ...v.decisions['d-samples']!, status: 'approved' } } }); // fixture key asserted by mandateScene
    await settled.actions.approve('d-samples');
    await settled.actions.defer('d-samples');
    expect(settled.sent).toEqual([]);
  });

  it('defers only pending decisions, through the decision key', async () => {
    const h = harness(mandateScene());
    await h.actions.defer('d-samples');
    expect(h.sent).toEqual([
      {
        name: 'deferDecision',
        input: expect.objectContaining({ decisionId: 'd-samples', idempotencyKey: `k:${decisionKey('d-samples')}` }),
      },
    ]);
  });

  it('a refused command neither advances the decision moment nor redirects', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const v = perfumeMission();
    const moment = { momentId: 'mo-1', ids: ['d-supplier', 'd-samples'], index: 0, done: [] };
    const h = harness(v, { ui: { moment }, result: { ok: false, error: { code: 'conflict', message: 'Conflict', retryable: false } } });
    await h.actions.approve('d-supplier');
    expect(h.dispatched).toEqual([]);
    expect(assign).not.toHaveBeenCalled();
  });

  it('a provider redirect leaves the page for approval instead of advancing', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const v = perfumeMission();
    const h = harness(v, {
      result: { ok: true, ledgerVersion: v.ledgerVersion + 1, redirectUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=T' },
    });
    await h.actions.approve('d-supplier');
    expect(assign).toHaveBeenCalledWith('https://www.sandbox.paypal.com/checkoutnow?token=T');
    expect(h.dispatched).toEqual([]);
  });

  it('the last decision of a moment completes it and announces the end', async () => {
    const v = perfumeMission();
    const moment = { momentId: 'mo-1', ids: ['d-supplier', 'd-samples'], index: 1, done: [{ id: 'd-supplier', text: 'supplier: B' }] };
    const h = harness(v, { ui: { moment } });
    await h.actions.defer('d-samples');
    await vi.waitFor(() => expect(h.announced).toEqual([t('momentDone')]));
    expect(h.sent.map(s => s.name)).toEqual(['deferDecision', 'completeMoment']);
    expect(h.sent[1]?.input).toMatchObject({ momentId: 'mo-1', resolvedDecisionIds: ['d-supplier', 'd-samples'] });
    expect(h.dispatched).toEqual([
      { type: 'momentAdvance', id: 'd-samples', text: `sample mandate: ${t('deferredLabel').toLowerCase()}` },
      { type: 'momentEnd' },
    ]);
  });
});

describe('presentation state', () => {
  const brand = { kind: 'artifact' as const, artifactId: 'brand' };
  const money = { kind: 'system' as const, view: 'money' as const };

  it('opening a new target records history and drops the inspector; reopening the same keeps both', () => {
    let s = uiReducer(initialUi(null), { type: 'open', target: brand });
    s = uiReducer(s, { type: 'inspect', artifactId: 'brand', frameId: 'f1' });
    const same = uiReducer(s, { type: 'open', target: { ...brand, frameId: 'f2' } });
    expect(same.history).toHaveLength(1);
    expect(same.inspector).toEqual({ artifactId: 'brand', frameId: 'f1' });
    const other = uiReducer(s, { type: 'open', target: money });
    expect(other.history).toEqual([brand, money]);
    expect(other.inspector).toBeNull();
  });

  it('an agent-opened peek is marked auto; the founder opening it makes it theirs', () => {
    const auto = uiReducer(initialUi(null), { type: 'open', target: money, auto: true });
    expect(auto.peek?.auto).toBe(true);
    expect(uiReducer(auto, { type: 'open', target: money }).peek?.auto).toBe(false);
  });

  it('back and forward walk the history and stop at its ends', () => {
    let s = uiReducer(initialUi(null), { type: 'open', target: brand });
    s = uiReducer(s, { type: 'open', target: money });
    const back = uiReducer(s, { type: 'history', step: -1 });
    expect(back.peek?.target).toEqual(brand);
    expect(uiReducer(back, { type: 'history', step: -1 })).toBe(back);
    expect(uiReducer(back, { type: 'history', step: 1 }).peek?.target).toEqual(money);
  });

  it('closing clears the inspector; width and sheet snap only apply to an open peek', () => {
    const closed = uiReducer(uiReducer(initialUi(null), { type: 'open', target: brand }), { type: 'close' });
    expect(closed.peek).toBeNull();
    expect(uiReducer(closed, { type: 'wide', wide: true })).toBe(closed);
    expect(uiReducer(closed, { type: 'half', half: true })).toBe(closed);
  });

  it('a decision moment advances one decision at a time and ends cleanly', () => {
    let s = uiReducer(initialUi(null), { type: 'momentStart', momentId: 'mo', ids: ['a', 'b'] });
    s = uiReducer(s, { type: 'momentAdvance', id: 'a', text: 'a: yes' });
    expect(s.moment).toMatchObject({ index: 1, done: [{ id: 'a', text: 'a: yes' }] });
    expect(uiReducer(s, { type: 'momentEnd' }).moment).toBeNull();
    expect(uiReducer(initialUi(null), { type: 'momentAdvance', id: 'a', text: '' }).moment).toBeNull();
  });

  it('selecting the same readiness level twice clears it; flashes and camera requests count up', () => {
    const once = uiReducer(initialUi(null), { type: 'readinessSel', outcome: 'product', level: 2 } as UiAction);
    expect(once.readinessSel).not.toBeNull();
    expect(uiReducer(once, { type: 'readinessSel', outcome: 'product', level: 2 } as UiAction).readinessSel).toBeNull();
    const f = uiReducer(uiReducer(initialUi(null), { type: 'flash', id: 'd' }), { type: 'flash', id: 'd' });
    expect(f.flash).toEqual({ id: 'd', n: 2 });
    const c = uiReducer(uiReducer(initialUi(null), { type: 'camera', artifactId: 'a', frameId: 'x' }), {
      type: 'camera',
      artifactId: 'a',
      frameId: 'y',
    });
    expect(c.camera).toEqual({ artifactId: 'a', frameId: 'y', n: 2 });
  });

  it('toggles, selections and reset touch presentation only', () => {
    let s = uiReducer(initialUi(null), { type: 'toggle', key: 'chapter' });
    s = uiReducer(s, { type: 'select', decisionId: 'd', optionId: 'o' });
    s = uiReducer(s, { type: 'showAll', decisionId: 'd' });
    s = uiReducer(s, { type: 'why', decisionId: 'd' });
    s = uiReducer(s, { type: 'reopen', decisionId: 'd' });
    s = uiReducer(s, { type: 'logFilter', filter: 'all' });
    expect(s).toMatchObject({
      expanded: { chapter: true },
      selected: { d: 'o' },
      showAll: { d: true },
      whyOpen: { d: true },
      reopened: { d: true },
    });
    expect(uiReducer(s, { type: 'reset' })).toEqual(initialUi(null));
  });
});
