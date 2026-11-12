'use client';

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: scrim, focus moves in on open, Tab is trapped, Esc closes, focus returns to the opener.
 * Keys typed inside never reach workspace shortcuts.
 */
export function Dialog({
  labelledBy,
  onClose,
  children,
  busy = false,
}: {
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('h2');
    if (first) {
      first.setAttribute('tabindex', '-1');
      first.focus({ preventScroll: true });
    }
    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[data-composer]')?.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy) onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !ref.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !ref.current?.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div className="scrim" aria-hidden="true" onClick={() => !busy && onClose()} />
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-busy={busy || undefined}
        ref={ref}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </>
  );
}
