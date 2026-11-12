'use client';

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { IconName, SystemPeek } from '../../ui-contract';
import { useI18n, type MessageKey } from '../../i18n';
import { CanvasEngine } from '../canvas/CanvasEngine';
import { Icon } from '../primitives/Icon';
import { useWorkspace } from '../workspace/context';
import { RENDERER } from '../workspace/derive';
import { sameTarget, targetKey, targetToPeek } from '../workspace/uiState';
import { DocumentSections } from './DocumentView';
import { LogPeek, MoneyPeek, NotificationsPeek, PlatesPeek, ReadinessPeek, RecordPeek } from './SystemViews';
import { ThreadView } from './ThreadView';
import { AccountsPeek } from '../account/AccountsPeek';

const SYSTEM: Readonly<Record<SystemPeek, { readonly icon: IconName; readonly label: MessageKey }>> = {
  readiness: { icon: 'ladder', label: 'readiness' },
  money: { icon: 'coins', label: 'money' },
  log: { icon: 'list', label: 'log' },
  notifications: { icon: 'bell', label: 'notifications' },
  plates: { icon: 'ruler', label: 'plates' },
  record: { icon: 'download', label: 'launchRecord' },
  accounts: { icon: 'lock', label: 'accounts' },
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The peek (UX 5.5): crumb, close, and nothing else in its header (widen appears on hover).
 * Side panel at >= 1280; overlay with scrim at 900-1279; bottom sheet on phones.
 * Focus moves in when the founder opens it, is trapped while it is modal or opened by the founder,
 * and returns to the opener on close. The agent's requested focus waits as a badge, never a switch.
 */
export function Peek({ onClose, restoreTo }: { readonly onClose: () => void; readonly restoreTo: () => void }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const ref = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const peek = ws.ui.peek;
  const target = peek?.target;
  const artifact = target?.kind === 'artifact' ? (ws.view.artifacts[target.artifactId] ?? null) : null;
  const modal = !!peek && !peek.auto && ws.layout !== 'side';
  const trapped = !!peek && !peek.auto;

  // Move focus in when opened by the founder; restore on unmount.
  const key = target ? JSON.stringify(target) : '';
  useEffect(() => {
    if (!trapped) return;
    const el = ref.current;
    if (!el) return;
    // Land on the content: the title if there is one, else the canvas, else the first control.
    const title = el.querySelector<HTMLElement>('.pb h2');
    if (title) {
      title.setAttribute('tabindex', '-1');
      title.focus({ preventScroll: true });
      return;
    }
    // Canvases: focus the peek itself; Tab then reaches the stage and its frames.
    el.focus({ preventScroll: true });
  }, [key, trapped]);
  useEffect(() => () => restoreTo(), [restoreTo]);

  useEffect(() => {
    if (bodyRef.current && !(artifact && RENDERER[artifact.type] === 'canvas')) bodyRef.current.scrollTop = 0;
  }, [key, artifact]);

  if (!peek || !target) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab' || !trapped) return;
    const el = ref.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => x.offsetParent !== null || x === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  let icon: IconName = 'doc';
  let crumb = '';
  let body: ReactNode = null;
  let canvas = false;
  if (target.kind === 'system') {
    icon = SYSTEM[target.view].icon;
    crumb = t(SYSTEM[target.view].label);
    body =
      target.view === 'money' ? (
        <MoneyPeek />
      ) : target.view === 'readiness' ? (
        <ReadinessPeek />
      ) : target.view === 'log' ? (
        <LogPeek />
      ) : target.view === 'notifications' ? (
        <NotificationsPeek />
      ) : target.view === 'plates' ? (
        <PlatesPeek />
      ) : target.view === 'accounts' ? (
        <AccountsPeek />
      ) : (
        <RecordPeek />
      );
  } else if (artifact) {
    icon = artifact.icon;
    crumb = artifact.title;
    const kind = RENDERER[artifact.type];
    const c = artifact.content;
    if (kind === 'canvas' && c.kind === 'canvas') {
      canvas = true;
      body = <CanvasEngine key={artifact.id} artifact={artifact} content={c} focusFrameId={target.frameId} />;
    } else if (kind === 'thread' && c.kind === 'thread') body = <ThreadView artifactId={artifact.id} title={artifact.title} content={c} />;
    else if (c.kind === 'document') body = <DocumentSections sections={c.sections} artifactId={artifact.id} />;
  }

  // The agent asked to look at something else: a badge, not a switch (FR-UX-03).
  const focus = ws.view.focus;
  const focusPeek = focus ? targetToPeek(focus.target) : null;
  const showFocusBadge =
    !!focus && !!focusPeek && !ws.ui.moment && !sameTarget(focusPeek, target) && ws.ui.dismissedFocusKey !== targetKey(focus.target);
  const focusTitle =
    focusPeek?.kind === 'artifact'
      ? (ws.view.artifacts[focusPeek.artifactId]?.title ?? '')
      : focusPeek?.kind === 'system'
        ? t(SYSTEM[focusPeek.view].label)
        : '';

  const missionName = ws.view.header.untitled ? t('untitled') : ws.view.header.name;
  const cls = ['peek', peek.wide ? 'wide' : '', peek.auto ? 'auto' : '', peek.half ? 'half' : ''].filter(Boolean).join(' ');
  return (
    <>
      {ws.layout !== 'side' && !peek.auto ? <div className="peek-scrim" aria-hidden="true" onClick={onClose} /> : null}
      <aside
        ref={ref}
        className={cls}
        aria-label={t('peekLabel', { title: crumb })}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        {...(modal ? { role: 'dialog', 'aria-modal': true } : {})}
      >
        <div className="ph">
          {ws.layout === 'phone' ? (
            <button
              type="button"
              className="ib grab"
              aria-label={peek.half ? t('sheetExpand') : t('sheetCollapse')}
              onClick={() => ws.dispatch({ type: 'half', half: !peek.half })}
            >
              <Icon name={peek.half ? 'expand' : 'shrink'} />
            </button>
          ) : null}
          {ws.ui.historyIndex > 0 ? (
            <button type="button" className="ib" aria-label={t('back')} onClick={() => ws.dispatch({ type: 'history', step: -1 })}>
              <Icon name="chev" className="back" />
            </button>
          ) : null}
          <div className="crumb">
            <Icon name={icon} />
            <span>
              {missionName} / <b>{crumb}</b>
            </span>
          </div>
          {ws.ui.historyIndex < ws.ui.history.length - 1 ? (
            <button type="button" className="ib" aria-label={t('forward')} onClick={() => ws.dispatch({ type: 'history', step: 1 })}>
              <Icon name="chev" />
            </button>
          ) : null}
          {ws.layout !== 'phone' ? (
            <button
              type="button"
              className="ib widen"
              aria-label={peek.wide ? t('narrow') : t('widen')}
              data-tip={peek.wide ? t('narrow') : t('widen')}
              onClick={() => ws.dispatch({ type: 'wide', wide: !peek.wide })}
            >
              <Icon name={peek.wide ? 'shrink' : 'expand'} />
            </button>
          ) : null}
          <button type="button" className="ib" aria-label={t('close')} data-tip={t('closeEsc')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {showFocusBadge && focus ? (
          <div className="focus-badge" role="status">
            <Icon name="pin" />
            <span>{t('focusRequest', { title: focusTitle })}</span>
            <button type="button" className="btn line sm" onClick={e => ws.open(focus.target, e.currentTarget)}>
              {t('focusOpen')}
            </button>
            <button
              type="button"
              className="ib"
              aria-label={t('close')}
              onClick={() => ws.dispatch({ type: 'dismissFocus', key: targetKey(focus.target) })}
            >
              <Icon name="close" />
            </button>
          </div>
        ) : null}
        {/* Document bodies scroll: keep them keyboard-reachable even without controls inside. */}
        <div
          ref={bodyRef}
          className={`pb${canvas ? ' canvas' : ''}`}
          key={key}
          {...(canvas ? {} : { tabIndex: 0, role: 'region', 'aria-label': crumb })}
        >
          {body}
        </div>
      </aside>
    </>
  );
}
