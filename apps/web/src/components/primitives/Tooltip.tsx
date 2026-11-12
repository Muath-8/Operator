'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * One tooltip for the whole workspace, driven by data attributes so any element can carry
 * a tip without nesting interactive wrappers: data-tip (text) and data-tip-title (bold lead).
 * Shows on hover and on keyboard focus; tapping a trust glyph toggles it (touch has no hover).
 * Text only: never HTML.
 */
interface TipState {
  readonly title: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

const TIP_ID = 'lo-tip';

function readTip(el: Element): { title: string; text: string } | null {
  const text = el.getAttribute('data-tip');
  if (!text) return null;
  return { title: el.getAttribute('data-tip-title') ?? '', text };
}

export function TooltipHost() {
  const [tip, setTip] = useState<TipState | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const forEl = useRef<Element | null>(null);

  useEffect(() => {
    const place = (el: Element) => {
      const data = readTip(el);
      if (!data) return;
      forEl.current = el;
      const r = el.getBoundingClientRect();
      setTip({ ...data, x: r.left + r.width / 2, y: r.top });
    };
    const hide = () => {
      forEl.current = null;
      setTip(null);
    };
    const over = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (el && el !== forEl.current) place(el);
      else if (!el && forEl.current) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (el) place(el);
      else hide();
    };
    const click = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest('[data-tip-toggle]') : null;
      if (el) {
        if (forEl.current === el) hide();
        else place(el);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && forEl.current) hide();
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('click', click);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('click', click);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);

  // Position after render, inside the viewport.
  useEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = tip.x - w / 2;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    let y = tip.y - h - 8;
    if (y < 8 && forEl.current) y = forEl.current.getBoundingClientRect().bottom + 8;
    el.style.insetInlineStart = '';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [tip]);

  return (
    <div id={TIP_ID} ref={ref} className={`tip${tip ? ' on' : ''}`} role="tooltip" aria-hidden={tip ? undefined : true}>
      {tip?.title ? <b>{tip.title} </b> : null}
      {tip?.text}
    </div>
  );
}
