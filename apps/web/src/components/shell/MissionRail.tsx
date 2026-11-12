'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { MarkGlyph } from '../plate/Plate';
import { useWorkspace } from '../workspace/context';

/**
 * Mission rail (UX 5.2), 48px: mission marks with a dot for pending decisions, and "+".
 * Hover or focus reveals the name; arrow keys move between marks; aria-current on the active one.
 */
export function MissionRail({ onNewMission }: { readonly onNewMission: () => void }) {
  const ws = useWorkspace();
  const { t } = useI18n();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const count = ws.missions.length + 1;
  const newState = ws.commandState('mission:new');
  const creating = newState?.phase === 'running';

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    refs.current[(i + step + count) % count]?.focus();
  };

  return (
    <nav className="rail" aria-label={t('missionsNav')}>
      {ws.missions.map((m, i) => {
        const name = m.untitled ? t('untitled') : m.name;
        const active = m.id === ws.view.missionId;
        const tip = m.pendingDecisions ? t('waitingOnYou', { name, n: m.pendingDecisions }) : name;
        return (
          <button
            key={m.id}
            ref={el => {
              refs.current[i] = el;
            }}
            type="button"
            className={`ms${m.status === 'paused' ? ' paused' : ''}`}
            aria-current={active ? 'page' : undefined}
            aria-label={tip}
            data-tip={tip}
            onClick={() => !active && ws.host.selectMission(m.id)}
            onKeyDown={e => onKey(e, i)}
          >
            {m.icon ? <MarkGlyph mark={m.icon} palette={[]} size={18} ink="currentColor" /> : <Icon name="doc" />}
            {m.pendingDecisions && !active ? <span className="pip" aria-hidden="true" /> : null}
          </button>
        );
      })}
      <button
        ref={el => {
          refs.current[ws.missions.length] = el;
        }}
        type="button"
        className={`ms${creating ? ' busy' : ''}`}
        aria-label={t('newMission')}
        data-tip={t('newMission')}
        aria-disabled={creating || undefined}
        onClick={() => !creating && onNewMission()}
        onKeyDown={e => onKey(e, ws.missions.length)}
      >
        {creating ? <span className="spin" aria-hidden="true" /> : <Icon name="plus" />}
      </button>
    </nav>
  );
}
