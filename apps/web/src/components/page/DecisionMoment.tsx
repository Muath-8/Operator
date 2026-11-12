'use client';

import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { useWorkspace } from '../workspace/context';
import { momentDecisionIds } from '../workspace/derive';
import { DecisionBlock } from './DecisionBlock';

/**
 * The decision moment as a ritual (UX 5.3, J3): "Decision moment: 3 decisions, about 6 minutes"
 * starts a focused block with 1 of n and a progress line; the peek follows each decision.
 * Leaving does nothing destructive. "Just go" applies defaults to non-binding decisions only;
 * the server decides which, and binding ones stay open.
 */
export function DecisionMoment() {
  const ws = useWorkspace();
  const { t } = useI18n();
  const m = ws.ui.moment;
  const v = ws.view;

  if (m && v.moment && m.momentId === v.moment.id) {
    const cur = m.ids[m.index];
    const justGoState = ws.commandState(`justgo:${m.momentId}`);
    const closing = ws.commandState(`moment:${m.momentId}`);
    const busy = justGoState?.phase === 'running' || justGoState?.phase === 'awaiting';
    return (
      <section className="ritual fade-in" id="ritual" aria-labelledby="ritual-h">
        <div className="rh">
          <h3 id="ritual-h">{t('momentTitle')}</h3>
          <span className="num" aria-live="polite">
            {t('momentProgress', { i: Math.min(m.index + 1, m.ids.length), n: m.ids.length })}
          </span>
          <span className="prog" aria-hidden="true">
            {m.ids.map((x, i) => (
              <i key={x} className={i < m.index ? 'f' : i === m.index ? 'c' : ''} />
            ))}
          </span>
          <span className="grow" />
          <button
            type="button"
            className={`btn quiet sm${busy ? ' busy' : ''}`}
            data-tip={t('justGoTip')}
            aria-disabled={busy || !ws.canDecide || undefined}
            onClick={() => {
              if (busy || !ws.canDecide) return;
              void ws
                .run(`justgo:${m.momentId}`, base => ws.commands.justGo({ ...base, momentId: m.momentId }))
                .then(r => {
                  if (r?.ok) ws.dispatch({ type: 'momentEnd' });
                });
            }}
          >
            {t('justGo')}
          </button>
          <button
            type="button"
            className="btn quiet sm"
            onClick={() => {
              ws.dispatch({ type: 'momentEnd' });
              ws.announce(t('momentLeft'));
            }}
          >
            {t('leave')}
          </button>
        </div>
        {m.done.length ? (
          <ul className="past">
            {m.done.map(x => {
              const recorded = v.decisions[x.id]?.status !== 'pending';
              return (
                <li key={x.id}>
                  {recorded ? <Icon name="check" /> : <span className="spin" aria-hidden="true" />}
                  <span>{x.text}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {cur ? <DecisionBlock id={cur} inRitual /> : null}
        {!cur && closing ? (
          <p className="status" role="status">
            {closing.phase === 'error' ? t('commandFailed', { reason: closing.error?.message ?? '' }) : t('momentDone')}
          </p>
        ) : null}
        {justGoState?.phase === 'error' ? (
          <p className="cnote err" role="alert">
            {t('commandFailed', {
              reason: justGoState.error?.code === 'offline' ? t('offlineAction') : (justGoState.error?.message ?? ''),
            })}
          </p>
        ) : null}
      </section>
    );
  }

  const open = momentDecisionIds(v);
  if (open.length < 2 || !v.moment || !ws.canDecide) return null;
  return (
    <div className="mline">
      <button type="button" className="toggle" onClick={() => ws.startMoment()}>
        <Icon name="chev" className="chev" />
        <span>{t('momentLine', { n: open.length, m: v.moment.estimateMinutes })}</span>
      </button>
    </div>
  );
}
