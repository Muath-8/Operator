'use client';

import { useEffect, useState } from 'react';
import type { Outcome, OutcomeLevels, ReadinessLevel } from '../../ui-contract';
import { OUTCOMES } from '../../ui-contract';
import { useI18n, type MessageKey } from '../../i18n';
import { useWorkspace } from '../workspace/context';

const RUNGS: readonly Exclude<ReadinessLevel, 0>[] = [1, 2, 3, 4, 5];
export const outcomeKey = (o: Outcome): MessageKey => `outcome_${o}` as MessageKey;
export const levelKey = (l: ReadinessLevel): MessageKey => `level_${l}` as MessageKey;

/**
 * Readiness as a quiet object (UX 9.5): six five-rung ladders, rises in accent, drops in amber,
 * blockers as sentences, stale notes in amber. It renders levels the ledger derived (I-5);
 * it never computes one.
 */
export function ReadinessObject(props: {
  readonly to: OutcomeLevels;
  readonly from?: OutcomeLevels;
  readonly blockersFor: readonly Outcome[];
  readonly big?: boolean;
  /** Animate from `from` to `to` (new entries only). */
  readonly animate?: boolean;
}) {
  const { to, from, blockersFor, big = false, animate = false } = props;
  const ws = useWorkspace();
  const { t } = useI18n();
  const [settled, setSettled] = useState(!animate || ws.reducedMotion);

  useEffect(() => {
    if (settled) return;
    const timer = window.setTimeout(() => setSettled(true), 1300);
    return () => window.clearTimeout(timer);
  }, [settled]);

  const byOutcome = new Map(ws.view.readiness.outcomes.map(o => [o.outcome, o]));
  const sel = ws.ui.readinessSel;

  return (
    <div className="rqw">
      <ul className={`rq${big ? ' big' : ''}`} aria-label={t('readinessLabel')}>
        {OUTCOMES.map(k => {
          const target = to[k];
          const start = from ? from[k] : target;
          const moved = start !== target;
          const shown = settled ? target : start;
          const inScope = ws.view.readiness.inScope.includes(k);
          const name = t(outcomeKey(k));
          return (
            <li
              key={k}
              className={`o${moved ? ' moved' : ''}${moved && target < start ? ' down' : ''}${inScope ? '' : ' out'}`}
              aria-label={`${name}: R${target} ${t(levelKey(target))}${moved ? `, R${start} → R${target}` : ''}${inScope ? '' : `, ${t('outcomeNotInScope')}`}`}
            >
              <div className="lad" aria-hidden={big ? undefined : true}>
                {RUNGS.map(i => {
                  const c = i < shown ? 'p' : i === shown ? 'c' : '';
                  if (!big) return <i key={i} className={c} />;
                  const pressed = !!sel && sel.outcome === k && sel.level === i;
                  return (
                    <button
                      key={i}
                      type="button"
                      className={c}
                      aria-pressed={pressed}
                      aria-label={`${t('rungLabel', { outcome: name, level: i, name: t(levelKey(i)) })}${i === target ? t('rungCurrent') : ''}`}
                      onClick={() => ws.dispatch({ type: 'readinessSel', outcome: k, level: i })}
                    />
                  );
                })}
              </div>
              <div className="on" aria-hidden="true">
                <span className="nm">{name}</span>
                <b className="lv">R{shown}</b>
              </div>
            </li>
          );
        })}
      </ul>
      {blockersFor.length ? (
        <ul className="blk">
          {blockersFor.map(k => {
            const o = byOutcome.get(k);
            if (!o) return null;
            return (
              <li key={k}>
                <b>{t(outcomeKey(k))}</b>
                <span>
                  {o.blocker}
                  {o.staleNote ? <span className="stale"> {o.staleNote}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export const currentLevels = (outcomes: readonly { readonly outcome: Outcome; readonly level: ReadinessLevel }[]): OutcomeLevels => {
  const out: Record<Outcome, ReadinessLevel> = { brand: 0, product: 0, supply: 0, commerce: 0, compliance: 0, demand: 0 };
  for (const o of outcomes) out[o.outcome] = o.level;
  return out;
};
