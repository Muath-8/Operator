'use client';

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ArtifactView, CanvasContent, FrameView } from '../../ui-contract';
import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { useWorkspace } from '../workspace/context';
import { bounds, clampZ, fitCamera, framePoint, layoutFrames, pan, zoomAt, type Camera, type Rect } from './camera';
import { FrameBody } from './FrameBody';
import { Inspector } from './Inspector';

/** Camera per artifact survives closing and reopening the peek. */
const CAMS = new Map<string, Camera>();
const INSPECTOR_SPACE = 276;

/**
 * The one canvas engine (UX 5.6), mounted in the peek for comparison and visual artifacts.
 * Dot-grid stage; frames whose labels keep their size at any zoom; fit, pan, wheel and pinch zoom;
 * select to inspect; decision and comment pins; camera-to-change after approvals. On phones frames
 * stack in one column fitted by width, with select-to-inspect and no free zoom (OD-U7).
 */
export function CanvasEngine({
  artifact,
  content,
  focusFrameId,
}: {
  readonly artifact: ArtifactView;
  readonly content: CanvasContent;
  readonly focusFrameId?: string | undefined;
}) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const phone = ws.layout === 'phone';
  const helpId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const cvRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const frameEls = useRef<Map<string, HTMLElement>>(new Map());
  const cam = useRef<Camera>(CAMS.get(artifact.id) ?? { x: 0, y: 0, z: 1 });
  const rects = useRef<Record<string, Rect>>({});
  const [pct, setPct] = useState(Math.round(cam.current.z * 100));
  const [touched, setTouched] = useState(false);
  const [pinning, setPinning] = useState<string | null>(null);
  const [laidOut, setLaidOut] = useState(false);
  // Frames wider than the stage reflow to it, so the first view opens near reading size.
  const [cap, setCap] = useState<number | null>(null);
  const selected = ws.ui.inspector && ws.ui.inspector.artifactId === artifact.id ? ws.ui.inspector.frameId : null;
  // Measured once per mount: later resizes keep the layout stable and refit the camera instead.
  const measureCap = useEffectEvent(() => {
    const w = cvRef.current?.clientWidth;
    if (!phone) setCap(w ? Math.max(360, w - 48 - (selected ? INSPECTOR_SPACE : 0)) : Number.POSITIVE_INFINITY);
  });
  useLayoutEffect(() => measureCap(), []);
  const frameWidth = useCallback((w: number) => (cap && Number.isFinite(cap) ? Math.min(w, cap) : w), [cap]);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const suppressClick = useRef(false);

  const rtl = i18n.dir === 'rtl';

  const viewSize = useCallback(() => {
    const el = cvRef.current;
    const w = el?.clientWidth ?? 600;
    const h = el?.clientHeight ?? 600;
    return { w: w - (selected && !phone ? INSPECTOR_SPACE : 0), h };
  }, [selected, phone]);

  const apply = useCallback(
    (c: Camera, anim: boolean) => {
      cam.current = c;
      CAMS.set(artifact.id, c);
      const w = worldRef.current;
      const cv = cvRef.current;
      if (!w || !cv || phone) return;
      w.classList.toggle('anim', anim && !ws.reducedMotion);
      w.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.z})`;
      w.style.setProperty('--iz', (1 / c.z).toFixed(4));
      cv.style.backgroundSize = `${24 * c.z}px ${24 * c.z}px`;
      cv.style.backgroundPosition = `${c.x}px ${c.y}px`;
      setPct(Math.round(c.z * 100));
      if (anim) window.setTimeout(() => w.classList.remove('anim'), 260);
    },
    [artifact.id, phone, ws.reducedMotion],
  );

  const fit = useCallback(
    (target: string | 'all', anim: boolean) => {
      const r = target === 'all' ? bounds(Object.values(rects.current)) : (rects.current[target] ?? bounds(Object.values(rects.current)));
      if (!r) return;
      apply(fitCamera(r, viewSize(), { offsetX: rtl && selected && !phone ? INSPECTOR_SPACE : 0 }), anim);
    },
    [apply, viewSize, rtl, selected, phone],
  );

  const flash = (id: string) => {
    const el = frameEls.current.get(id);
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  };

  // Lay frames out from their measured sizes, then place the camera.
  useLayoutEffect(() => {
    if (phone) {
      setLaidOut(true);
      return;
    }
    if (!cap) return; // wait for the stage width so frames are measured at their final size
    const sizes = content.frames.map(f => {
      const el = frameEls.current.get(f.id);
      return { id: f.id, row: f.row, w: el?.offsetWidth ?? frameWidth(f.width), h: el?.offsetHeight ?? 300 };
    });
    rects.current = layoutFrames(sizes);
    for (const f of content.frames) {
      const el = frameEls.current.get(f.id);
      const r = rects.current[f.id];
      if (el && r) el.style.transform = `translate(${r.x}px, ${r.y}px)`;
    }
    if (!laidOut) {
      const saved = CAMS.get(artifact.id);
      if (saved && !focusFrameId) apply(saved, false);
      else {
        const target = focusFrameId ?? content.focusFrameId;
        fit(target, false);
        // Fitting every row can shrink text below reading size; then open on the first frame instead.
        const first = content.frames[0];
        if (target === 'all' && cam.current.z < 0.75 && first && new Set(content.frames.map(f => f.row)).size > 1) fit(first.id, false);
      }
      setLaidOut(true);
    }
  }, [content.frames, phone, artifact.id, focusFrameId, content.focusFrameId, apply, fit, laidOut, cap, frameWidth]);

  // Camera-to-change after approvals (UX 11, sequence 1): fit all, then travel to the changed frame.
  // Each request (its counter) travels once; later camera or layout changes must not replay it.
  const cameraReq = ws.ui.camera;
  const followCamera = useEffectEvent(() => {
    if (!cameraReq || cameraReq.artifactId !== artifact.id || !laidOut) return;
    if (phone) {
      frameEls.current.get(cameraReq.frameId)?.scrollIntoView({ block: 'start', behavior: ws.reducedMotion ? 'auto' : 'smooth' });
      flash(cameraReq.frameId);
      return;
    }
    fit('all', false);
    const timer = window.setTimeout(
      () => {
        fit(cameraReq.frameId, true);
        flash(cameraReq.frameId);
      },
      ws.reducedMotion ? 0 : 180,
    );
    return () => window.clearTimeout(timer);
  });
  useEffect(() => followCamera(), [cameraReq?.n, laidOut]);

  // Keep the selected frame clear of the inspector when the selection changes (not on every pan).
  const keepClear = useEffectEvent(() => {
    if (!selected || phone || !laidOut) return;
    const el = frameEls.current.get(selected);
    const cv = cvRef.current;
    if (!el || !cv) return;
    const r = el.getBoundingClientRect();
    const c = cv.getBoundingClientRect();
    const hidden = rtl ? r.left < c.left + INSPECTOR_SPACE || r.right > c.right : r.right > c.right - INSPECTOR_SPACE || r.left < c.left;
    if (hidden) fit(selected, true);
  });
  useEffect(() => keepClear(), [selected]);

  // Refit on resize when the founder has not moved the camera.
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || phone || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!touched) fit(focusFrameId ?? content.focusFrameId, false);
    });
    ro.observe(cv);
    return () => ro.disconnect();
  }, [fit, touched, phone, focusFrameId, content.focusFrameId]);

  // Wheel: pan, or zoom with Ctrl / Cmd (and trackpad pinch). Non-passive so the page does not scroll.
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || phone) return;
    const onWheel = (e: WheelEvent) => {
      if (e.target instanceof Element && e.target.closest('.insp')) return;
      e.preventDefault();
      setTouched(true);
      const r = cv.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) apply(zoomAt(cam.current, Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top), false);
      else apply(pan(cam.current, -e.deltaX, -e.deltaY), false);
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, [apply, phone]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (phone) return;
    const target = e.target as Element;
    if (target.closest('.insp, .zchip')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      if (a && b) pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), z: cam.current.z };
      drag.current = null;
      return;
    }
    if (target.closest('button:not(.fsel), a, input, .tm, .term')) return;
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (phone) return;
    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cv = cvRef.current;
    if (!cv) return;
    if (pinch.current && pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      if (!a || !b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = cv.getBoundingClientRect();
      const nz = clampZ((pinch.current.z * d) / pinch.current.d);
      apply(zoomAt(cam.current, nz / cam.current.z, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top), false);
      setTouched(true);
      return;
    }
    const dr = drag.current;
    if (!dr) return;
    const dx = e.clientX - dr.x;
    const dy = e.clientY - dr.y;
    if (!dr.moved && Math.hypot(dx, dy) < 4) return;
    if (!dr.moved) {
      dr.moved = true;
      cv.classList.add('grabbing');
      setTouched(true);
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best effort */
      }
    }
    apply({ ...cam.current, x: dr.cx + dx, y: dr.cy + dy }, false);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
    const dr = drag.current;
    drag.current = null;
    cvRef.current?.classList.remove('grabbing');
    if (!dr) return;
    if (dr.moved) suppressClick.current = true;
    else if (!(e.target as Element).closest('.frame') && selected) ws.dispatch({ type: 'inspect', artifactId: artifact.id, frameId: null });
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (phone || e.target !== cvRef.current) return;
    const cv = cvRef.current;
    const cx = cv.clientWidth / 2;
    const cy = cv.clientHeight / 2;
    const k = e.key;
    let handled = true;
    if (k === '+' || k === '=') apply(zoomAt(cam.current, 1.25, cx, cy), true);
    else if (k === '-' || k === '_') apply(zoomAt(cam.current, 0.8, cx, cy), true);
    else if (k === '0') fit('all', true);
    else if (k === 'ArrowLeft') apply(pan(cam.current, 40, 0), false);
    else if (k === 'ArrowRight') apply(pan(cam.current, -40, 0), false);
    else if (k === 'ArrowUp') apply(pan(cam.current, 0, 40), false);
    else if (k === 'ArrowDown') apply(pan(cam.current, 0, -40), false);
    else handled = false;
    if (handled) {
      e.preventDefault();
      setTouched(true);
    }
  };

  const selectFrame = (f: FrameView, e: ReactMouseEvent<HTMLButtonElement>) => {
    if (pinning === f.id) {
      const el = frameEls.current.get(f.id);
      if (!el) return;
      const point = framePoint(el.getBoundingClientRect(), e.clientX, e.clientY);
      setPinning(null);
      ws.compose({ artifactId: artifact.id, frameId: f.id, versionId: viewingVersion(f), point }, t('pinComment'));
      return;
    }
    ws.dispatch({ type: 'inspect', artifactId: artifact.id, frameId: f.id });
  };

  const viewingVersion = (f: FrameView) => ws.ui.versionView[`${artifact.id}:${f.id}`] ?? f.inspector.currentVersionId;
  const selFrame = content.frames.find(f => f.id === selected) ?? null;

  return (
    <div className="cvwrap" ref={wrapRef}>
      <div
        ref={cvRef}
        className={`cv${phone ? ' phone' : ''}${touched ? ' touched' : ''}${pinning ? ' pinning' : ''}`}
        role="region"
        aria-label={artifact.title}
        aria-describedby={helpId}
        tabIndex={phone ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
        onKeyDown={onKeyDown}
      >
        {/* Hidden until measured and placed: server HTML and the first paint never show frames piled at the origin. */}
        <div className={`world${laidOut || phone ? '' : ' pending'}`} ref={worldRef}>
          {content.frames.map(f => {
            const vId = viewingVersion(f);
            const body = vId !== f.inspector.currentVersionId ? (f.versionBodies?.[vId] ?? f.body) : f.body;
            const pinD = f.pinDecisionId ? ws.view.decisions[f.pinDecisionId] : null;
            const decided = pinD && pinD.status !== 'pending';
            return (
              <section
                key={f.id}
                ref={el => {
                  if (el) frameEls.current.set(f.id, el);
                  else frameEls.current.delete(f.id);
                }}
                className={`frame${f.stale ? ' stale' : ''}${selected === f.id ? ' sel' : ''}`}
                style={{ inlineSize: phone ? undefined : frameWidth(f.width) }}
                aria-labelledby={`fl-${f.id}`}
                onDoubleClick={e => {
                  if (!phone && !(e.target as Element).closest('button:not(.fsel)')) fit(f.id, true);
                }}
              >
                <div className="fin" dir={i18n.dir}>
                  <div className="flabel" id={`fl-${f.id}`}>
                    <b>{f.title}</b> <span>{f.meta}</span>
                    {f.statusNote ? <span className="st"> {f.statusNote}</span> : null}
                  </div>
                  <button
                    type="button"
                    className="fsel"
                    aria-label={t('frame', { title: f.title })}
                    aria-pressed={selected === f.id}
                    onClick={e => selectFrame(f, e)}
                  />
                  {pinD ? (
                    <button
                      type="button"
                      className={`pin${decided ? ' done' : ''}`}
                      data-tip={pinD.question}
                      onClick={e => ws.open({ kind: 'decision', decisionId: pinD.id }, e.currentTarget)}
                    >
                      {decided ? <Icon name="check" /> : '1'}
                      <span className="sr">
                        {' '}
                        {decided ? t('decisionPinDone', { topic: pinD.topic }) : t('decisionPin', { topic: pinD.topic })}
                      </span>
                    </button>
                  ) : null}
                  <div className="cpins" dir="ltr">
                    {f.pins.map((p, i) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`cpin${p.resolved ? ' resolved' : ''}`}
                        style={{ insetInlineStart: `${p.x * 100}%`, insetBlockStart: `${p.y * 100}%` }}
                        data-tip={`${p.author}: ${p.text}`}
                        onClick={() => ws.dispatch({ type: 'inspect', artifactId: artifact.id, frameId: f.id })}
                      >
                        {i + 1}
                        <span className="sr"> {t('pinLabel', { author: p.author, text: p.text })}</span>
                      </button>
                    ))}
                  </div>
                  <div className="fbody">
                    <FrameBody body={body} phone={phone} title={f.title} />
                  </div>
                </div>
              </section>
            );
          })}
        </div>
        <div className="sr" id={helpId}>
          {t('framesList')}: {content.frames.map(f => `${f.title}, ${f.meta}. ${f.summary}`).join(' ')} {phone ? '' : t('keyHelp')}
        </div>
      </div>
      {!phone ? (
        <div className="zchip" role="toolbar" aria-label={t('zoom')}>
          <button
            type="button"
            aria-label={t('zoomOut')}
            onClick={() =>
              apply(zoomAt(cam.current, 0.8, (cvRef.current?.clientWidth ?? 0) / 2, (cvRef.current?.clientHeight ?? 0) / 2), true)
            }
          >
            <Icon name="minus" />
          </button>
          <span className="pct" aria-live="polite">
            {pct}%
          </span>
          <button
            type="button"
            aria-label={t('zoomIn')}
            onClick={() =>
              apply(zoomAt(cam.current, 1.25, (cvRef.current?.clientWidth ?? 0) / 2, (cvRef.current?.clientHeight ?? 0) / 2), true)
            }
          >
            <Icon name="plus" />
          </button>
          <button type="button" aria-label={t('fit')} data-tip={t('fit')} onClick={() => fit('all', true)}>
            <Icon name="fit" />
          </button>
        </div>
      ) : null}
      {selFrame ? (
        <Inspector
          artifact={artifact}
          frame={selFrame}
          viewingVersionId={viewingVersion(selFrame)}
          pinning={pinning === selFrame.id}
          onPin={() => setPinning(p => (p === selFrame.id ? null : selFrame.id))}
        />
      ) : null}
    </div>
  );
}
