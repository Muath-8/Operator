'use client';

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { MessageContext } from '../../ui-contract';
import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { useWorkspace } from '../workspace/context';
import { buildPaletteItems, filterItems, type PaletteItem } from './palette';

const draftKey = (missionId: string) => `lo-draft:${missionId}`;

export interface ComposeRequest {
  readonly context: MessageContext | null;
  readonly label: string | null;
  readonly n: number;
}

/**
 * One input at the bottom of the page (UX 5.4): "Write to your Mission Lead, or press ⌘K".
 * Typing shows the palette's matches above the field; Enter sends or runs. The send button appears
 * only with text. Nothing written is lost: the draft survives reloads, failures and offline, and
 * clears only when the server accepts the message.
 */
export function Composer({ request, onRun }: { readonly request: ComposeRequest | null; readonly onRun: (it: PaletteItem) => void }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const missionId = ws.view.missionId;
  const [text, setText] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [sel, setSel] = useState(-1);
  const [matchesOpen, setMatchesOpen] = useState(false);
  const [context, setContext] = useState<MessageContext | null>(null);
  const [contextLabel, setContextLabel] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const noteId = useId();

  // Restore the draft for this mission.
  useEffect(() => {
    try {
      setText(window.sessionStorage.getItem(draftKey(missionId)) ?? '');
    } catch {
      setText('');
    }
    setHydrated(true);
  }, [missionId]);
  useEffect(() => {
    if (!hydrated) return;
    try {
      if (text) window.sessionStorage.setItem(draftKey(missionId), text);
      else window.sessionStorage.removeItem(draftKey(missionId));
    } catch {
      /* storage unavailable: the draft still lives in the field */
    }
  }, [text, missionId, hydrated]);

  // Requests to compose with context (inspector pins, draft edits).
  useEffect(() => {
    if (!request) return;
    setContext(request.context);
    setContextLabel(request.label);
    inputRef.current?.focus();
  }, [request]);

  const openQuestion = useMemo(() => Object.values(ws.view.questions).find(q => q.status === 'open') ?? null, [ws.view.questions]);
  const all = useMemo(
    () => buildPaletteItems(ws.view, ws.missions, { t, date: i18n.date, theme: ws.theme, language: ws.language, canDecide: ws.canDecide }),
    [ws.view, ws.missions, t, i18n.date, ws.theme, ws.language, ws.canDecide],
  );
  const matches = useMemo(
    () => (text.trim().length >= 2 && !openQuestion ? filterItems(all, text).slice(0, 5) : []),
    [all, text, openQuestion],
  );
  const showMatches = matchesOpen && matches.length > 0;

  const key = openQuestion ? `question:${openQuestion.id}` : 'message';
  const st = ws.commandState(key);
  const sending = st?.phase === 'running';

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (showMatches && sel >= 0 && matches[sel]) {
      const it = matches[sel];
      setText('');
      setSel(-1);
      setMatchesOpen(false);
      onRun(it);
      return;
    }
    const value = text.trim();
    if (!value || sending || !ws.canMessage) return;
    let ok = false;
    if (openQuestion) {
      const r = await ws.run(key, base =>
        ws.commands.answerQuestion({ ...base, questionId: openQuestion.id, answer: value, skipped: false }),
      );
      ok = !!r?.ok;
    } else {
      ok = await ws.send(value, context ?? undefined);
    }
    if (ok) {
      setText('');
      setContext(null);
      setContextLabel(null);
      setMatchesOpen(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!showMatches) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(s => Math.min(matches.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(s => Math.max(-1, s - 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setMatchesOpen(false);
    }
  };

  const placeholder = openQuestion ? t('answerPlaceholder') : (contextLabel ?? (ws.layout === 'phone' ? t('writeShort') : t('write')));
  const err = st?.phase === 'error' ? st.error : null;

  return (
    <div className="composer">
      <div className="inner">
        {showMatches ? (
          <ul className="power" id={listId} role="listbox" aria-label={t('matches')}>
            <li className="grp" role="presentation">
              {t('matches')}
            </li>
            {matches.map((it, n) => (
              <li
                key={it.id}
                id={`${listId}-${n}`}
                className="it"
                role="option"
                aria-selected={n === sel}
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  setText('');
                  setMatchesOpen(false);
                  onRun(it);
                }}
              >
                <Icon name={it.icon} />
                <span>{it.label}</span>
                {it.key ? (
                  <span className="hint">
                    <kbd>{it.key}</kbd>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <form className="cbox" autoComplete="off" onSubmit={e => void submit(e)} aria-busy={sending || undefined}>
          <label className="sr" htmlFor={`${listId}-in`}>
            {openQuestion ? t('answerPlaceholder') : t('writeShort')}
          </label>
          <input
            ref={inputRef}
            id={`${listId}-in`}
            data-composer=""
            enterKeyHint="send"
            role="combobox"
            aria-controls={showMatches ? listId : undefined}
            aria-expanded={showMatches}
            aria-autocomplete="list"
            aria-activedescendant={showMatches && sel >= 0 ? `${listId}-${sel}` : undefined}
            aria-describedby={err || contextLabel ? noteId : undefined}
            placeholder={placeholder}
            value={text}
            readOnly={!ws.canMessage}
            onChange={e => {
              setText(e.target.value);
              setSel(-1);
              setMatchesOpen(true);
            }}
            onFocus={() => setMatchesOpen(true)}
            onBlur={() => window.setTimeout(() => setMatchesOpen(false), 150)}
            onKeyDown={onKey}
          />
          {text.trim() ? (
            <button
              className="send"
              type="submit"
              aria-label={sending ? t('sending') : t('send')}
              aria-disabled={sending || !ws.canMessage || undefined}
            >
              {sending ? <span className="spin" aria-hidden="true" /> : <Icon name="send" />}
            </button>
          ) : null}
        </form>
        {err ? (
          <p className="cnote err" id={noteId} role="alert">
            {err.code === 'offline' ? t('offlineAction') : t('commandFailed', { reason: err.message })} {t('messageNotSent')}
          </p>
        ) : contextLabel ? (
          <p className="cnote" id={noteId}>
            <Icon name="pin" />
            {contextLabel}
            <button
              type="button"
              className="btn quiet sm"
              onClick={() => {
                setContext(null);
                setContextLabel(null);
              }}
            >
              {t('pinCancel')}
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
