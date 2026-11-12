'use client';

import { useId, useRef, type KeyboardEvent } from 'react';
import type { HelpMode, HelpModeControl } from '../../ui-contract';
import { useI18n } from '../../i18n';
import { useWorkspace } from '../workspace/context';

const MODES: readonly HelpMode[] = ['guide', 'do', 'help'];

/**
 * Guide me / Do it for me / Help me do it (UX 6.4). A radiogroup with manual activation:
 * arrows move focus, Enter or Space applies. Switching can send a held draft, so selection
 * does not follow focus. The mode changes only when the ledger says so.
 */
export function Dial({
  control,
  small = false,
  label,
}: {
  readonly control: HelpModeControl;
  readonly small?: boolean;
  readonly label?: string;
}) {
  const { t } = useI18n();
  const ws = useWorkspace();
  const key = `mode:${control.targetKind}:${control.targetId}`;
  const state = ws.commandState(key);
  const busy = state?.phase === 'running' || state?.phase === 'awaiting';
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const descId = useId();
  const modes = MODES.filter(m => control.allowed.includes(m));

  const apply = (mode: HelpMode) => {
    if (busy || mode === control.mode || !ws.canMessage) return;
    void ws.run(key, base =>
      ws.commands.setHelpMode({ ...base, control: { targetId: control.targetId, targetKind: control.targetKind }, mode }),
    );
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const rtl = document.documentElement.dir === 'rtl';
    const next =
      e.key === 'ArrowRight'
        ? rtl
          ? -1
          : 1
        : e.key === 'ArrowLeft'
          ? rtl
            ? 1
            : -1
          : e.key === 'ArrowDown'
            ? 1
            : e.key === 'ArrowUp'
              ? -1
              : 0;
    if (next) {
      e.preventDefault();
      const j = (i + next + modes.length) % modes.length;
      refs.current[j]?.focus();
    }
  };

  return (
    <div className="dialbox">
      <div
        className={`dial${small ? ' sm' : ''}${busy ? ' busy' : ''}`}
        role="radiogroup"
        aria-label={label ?? t('helpDialLabel')}
        aria-describedby={descId}
        aria-busy={busy || undefined}
        data-tip={t('helpDialTip')}
      >
        {modes.map((m, i) => (
          <button
            key={m}
            ref={el => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={control.mode === m}
            tabIndex={control.mode === m ? 0 : -1}
            aria-disabled={busy || !ws.canMessage || undefined}
            onClick={() => apply(m)}
            onKeyDown={e => onKey(e, i)}
          >
            {t(`mode_${m}`)}
          </button>
        ))}
      </div>
      <span id={descId} className="sr">
        {t(`modeDesc_${control.mode}`)} {t('helpDialTip')}
      </span>
      {state?.phase === 'error' ? (
        <span className="cnote err" role="alert">
          {t('commandFailed', { reason: state.error?.code === 'offline' ? t('offlineAction') : (state.error?.message ?? '') })}
        </span>
      ) : null}
    </div>
  );
}
