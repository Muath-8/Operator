'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { useWorkspace } from '../workspace/context';
import { buildPaletteItems, filterItems, type PaletteItem } from './palette';

export function groups(items: readonly PaletteItem[]): { name: string; items: { it: PaletteItem; n: number }[] }[] {
  const out: { name: string; items: { it: PaletteItem; n: number }[] }[] = [];
  items.forEach((it, n) => {
    const last = out[out.length - 1];
    if (last && last.name === it.group) last.items.push({ it, n });
    else out.push({ name: it.group, items: [{ it, n }] });
  });
  return out;
}

/**
 * ⌘K palette (UX 5.4, 10): a modal dialog with a combobox and listbox. ↑ ↓ choose, Enter runs,
 * Esc closes and returns focus. Anything typed can be sent to the Mission Lead as a question.
 */
export function CommandPalette({ onRun, onClose }: { readonly onRun: (it: PaletteItem) => void; readonly onClose: () => void }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const all = useMemo(
    () => buildPaletteItems(ws.view, ws.missions, { t, date: i18n.date, theme: ws.theme, language: ws.language, canDecide: ws.canDecide }),
    [ws.view, ws.missions, t, i18n.date, ws.theme, ws.language, ws.canDecide],
  );
  const items = useMemo(() => {
    const f = filterItems(all, q);
    const text = q.trim();
    if (!text || !ws.canMessage) return f;
    return [
      ...f,
      {
        id: 'send',
        group: t('sendGroup'),
        label: t('sendAsMessage', { q: text }),
        icon: 'enter' as const,
        action: { k: 'say' as const, text },
      },
    ];
  }, [all, q, t, ws.canMessage]);
  const idx = Math.max(0, Math.min(i, items.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    document.getElementById(`${listId}-${idx}`)?.scrollIntoView({ block: 'nearest' });
  }, [idx, listId]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Keys typed in the palette belong to the palette: never let Enter or a letter reach the
    // workspace shortcuts (A / D / Enter resolve decisions).
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setI(Math.min(items.length - 1, idx + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setI(Math.max(0, idx - 1));
    } else if (e.key === 'Home') {
      setI(0);
    } else if (e.key === 'End') {
      setI(items.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[idx];
      if (it) onRun(it);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      // The dialog has one tab stop: keep focus inside (focus trap).
      e.preventDefault();
    }
  };

  return (
    <>
      <div className="scrim" aria-hidden="true" onClick={onClose} />
      <div className="pal" role="dialog" aria-modal="true" aria-label={t('paletteLabel')} ref={dialogRef}>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length ? `${listId}-${idx}` : undefined}
          aria-label={t('palettePlaceholder')}
          placeholder={t('palettePlaceholder')}
          value={q}
          onChange={e => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={onKey}
        />
        <ul id={listId} role="listbox" aria-label={t('paletteLabel')}>
          {items.length === 0 ? (
            <li className="empty-row" role="presentation">
              {t('paletteEmpty')}
            </li>
          ) : null}
          {groups(items).map(g => (
            <li key={g.name} role="group" aria-label={g.name}>
              <span className="grp" aria-hidden="true">
                {g.name}
              </span>
              <ul role="none">
                {g.items.map(({ it, n }) => (
                  <li
                    key={it.id}
                    id={`${listId}-${n}`}
                    className="it"
                    role="option"
                    aria-selected={n === idx}
                    onMouseMove={() => n !== idx && setI(n)}
                    onClick={() => onRun(it)}
                  >
                    <Icon name={it.icon} />
                    <span>{it.label}</span>
                    {it.key || it.hint ? <span className="hint">{it.key ? <kbd>{it.key}</kbd> : it.hint}</span> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
