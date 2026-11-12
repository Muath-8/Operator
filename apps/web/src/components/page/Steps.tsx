'use client';

import type { ActivityStep } from '../../ui-contract';
import { useI18n, type MessageKey } from '../../i18n';
import { Dial } from '../primitives/Dial';
import { Icon } from '../primitives/Icon';
import { RichText } from '../primitives/RichText';
import { EvidenceGlyph } from '../primitives/TrustGlyph';
import { useWorkspace } from '../workspace/context';

const stepKey = (l: ActivityStep['label']): MessageKey => `step_${l}` as MessageKey;

/**
 * Live steps (UX 5.3, 8.1): collapsible agent steps with outcome labels. Status is text, not colour
 * alone. Failed steps offer Retry; the label changes only when the ledger records the retry.
 */
export function Steps({ ids, scope }: { readonly ids: readonly string[]; readonly scope: string }) {
  const ws = useWorkspace();
  const steps = ids.map(id => ws.view.activity[id]).filter((s): s is ActivityStep => !!s);
  if (!steps.length) return null;
  return (
    <ul className="steps">
      {steps.map(s => (
        <Step key={s.id} s={s} scope={scope} />
      ))}
    </ul>
  );
}

function Step({ s, scope }: { readonly s: ActivityStep; readonly scope: string }) {
  const ws = useWorkspace();
  const { t } = useI18n();
  const key = `step-${scope}-${s.id}`;
  const open = !!ws.ui.expanded[key];
  const retryKey = `step:${s.id}`;
  const retry = ws.commandState(retryKey);
  const retrying = retry?.phase === 'running' || retry?.phase === 'awaiting';
  const running = s.label === 'running' || s.label === 'retrying';
  const panelId = `${key}-panel`;
  return (
    <li className="step">
      <button
        type="button"
        className="sh"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => ws.dispatch({ type: 'toggle', key })}
      >
        {running ? <i className="spin" aria-hidden="true" /> : <i className={`sdot ${s.label}`} aria-hidden="true" />}
        <span>
          <RichText value={s.title} interactive={false} />
        </span>
        <span className={`lab ${s.label}`}>
          {t(stepKey(s.label))}
          {s.sandbox ? ` · ${t('money_sandbox').toLowerCase()}` : ''}
        </span>
      </button>
      {open ? (
        <div id={panelId} className="fade-in">
          <ul className="kids">
            {s.details.map((d, i) => (
              <li key={i}>
                <RichText value={d} />
              </li>
            ))}
            {s.receipts?.map(r => (
              <li key={r.id}>
                <EvidenceGlyph item={r} /> <span className="rid">{r.text}</span>
              </li>
            ))}
            {s.retry && (s.label === 'failed' || retry) ? (
              <li>
                <button
                  type="button"
                  className={`btn line sm${retrying ? ' busy' : ''}`}
                  aria-disabled={retrying || !ws.canMessage || undefined}
                  onClick={() => {
                    if (retrying) return;
                    void ws.run(retryKey, base => ws.commands.retryStep({ ...base, stepId: s.id }));
                  }}
                >
                  {retrying ? <span className="spin" aria-hidden="true" /> : <Icon name="retry" />}
                  {retrying ? t('retrying') : s.retry.label}
                </button>
                {retry?.phase === 'error' ? (
                  <span className="cnote err" role="alert">
                    {t('commandFailed', { reason: retry.error?.code === 'offline' ? t('offlineAction') : (retry.error?.message ?? '') })}
                  </span>
                ) : null}
              </li>
            ) : null}
          </ul>
          {s.help ? (
            <div className="dialwrap">
              <span>{t('howIHandle')}</span>
              <Dial control={s.help} small />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
