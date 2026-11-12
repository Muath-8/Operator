'use client';

import { useMemo } from 'react';
import { useI18n, type Vars } from '../../i18n';
import type { MessageKey } from '../../i18n/en';
import { useWorkspace, type WorkspaceApi } from './context';
import { checkScope, draftFromScope, ownsScope } from './scope';

export const decisionKey = (id: string) => `decision:${id}`;

export interface DecisionActions {
  readonly approve: (id: string, optionId?: string) => Promise<void>;
  readonly defer: (id: string) => Promise<void>;
  readonly change: (id: string) => Promise<void>;
}

/**
 * Approve, choose, defer and change, shared by the decision block, the ritual and the
 * A / D / Enter keys. Each call is a ledger command; the block changes only when the view does.
 * A second call while one is pending is ignored by the command ledger (no double approval).
 */
export function decisionActionsFor(ws: WorkspaceApi, t: (k: MessageKey, v?: Vars) => string): DecisionActions {
  const { view, ui, dispatch } = ws;

  const advanceMoment = (id: string, text: string) => {
    const m = ui.moment;
    if (!m || !m.ids.includes(id)) return;
    dispatch({ type: 'momentAdvance', id, text });
    if (m.index + 1 >= m.ids.length) {
      const resolved = [...m.done.map(d => d.id), id];
      void ws
        .run(`moment:${m.momentId}`, base => ws.commands.completeMoment({ ...base, momentId: m.momentId, resolvedDecisionIds: resolved }))
        .then(r => {
          if (r?.ok) {
            dispatch({ type: 'momentEnd' });
            ws.announce(t('momentDone'));
          }
        });
    }
  };

  const approve = async (id: string, optionId?: string) => {
    const d = view.decisions[id];
    if (!d || d.status === 'superseded' || d.status === 'approved' || d.status === 'rejected' || !ws.canDecide) return;
    const opt = optionId ?? ui.selected[id] ?? d.recommendedOptionId;
    const option = d.options.find(o => o.id === opt);
    if (!option) return;
    let mandateScope: { ceiling: { amountMinor: number; currency: string }; count: number; expiresOn: string } | undefined;
    if (d.mandateScope && ownsScope(d, opt)) {
      const check = checkScope(ui.scopes[id] ?? draftFromScope(d.mandateScope), d.mandateScope);
      if (!check.ok) {
        dispatch({ type: 'flash', id });
        return;
      }
      mandateScope = check.value;
    }
    const res = await ws.run(decisionKey(id), base =>
      ws.commands.resolveDecision({
        ...base,
        decisionId: id,
        response: opt === d.recommendedOptionId ? 'approve' : 'choose',
        optionId: opt,
        ...(mandateScope ? { mandateScope } : {}),
      }),
    );
    if (!res?.ok) return;
    if (res.redirectUrl) {
      window.location.assign(res.redirectUrl);
      return;
    }
    advanceMoment(id, `${d.topic}: ${option.shortLabel}`);
  };

  const defer = async (id: string) => {
    const d = view.decisions[id];
    if (!d || d.status !== 'pending' || !ws.canDecide) return;
    const res = await ws.run(decisionKey(id), base => ws.commands.deferDecision({ ...base, decisionId: id }));
    if (res?.ok) advanceMoment(id, `${d.topic}: ${t('deferredLabel').toLowerCase()}`);
  };

  const change = async (id: string) => {
    const d = view.decisions[id];
    if (!d || !d.canChange || !ws.canDecide) {
      const rec = view.decisionRecord.find(r => r.decisionId === id);
      if (!rec?.canChange || !ws.canDecide) return;
    }
    await ws.run(`change:${id}`, base => ws.commands.requestChange({ ...base, decisionId: id }));
  };

  return { approve, defer, change };
}

export function useDecisionActions(): DecisionActions {
  const ws = useWorkspace();
  const { t } = useI18n();
  return useMemo(() => decisionActionsFor(ws, t), [ws, t]);
}
