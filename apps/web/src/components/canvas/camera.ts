/** Canvas camera and layout math (UX 5.6). Pure, so it is tested without a browser. */

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export interface Size {
  readonly w: number;
  readonly h: number;
}

export const GAP = 72;
export const ROW_GAP = GAP + 24;
export const LABEL_SPACE = 24;
export const MIN_Z = 0.15;
export const MAX_Z = 2.5;

/** Frames flow left to right in rows; later rows centre under the first. World space is direction-neutral. */
export function layoutFrames(
  frames: readonly { readonly id: string; readonly row: number; readonly w: number; readonly h: number }[],
): Record<string, Rect> {
  const rows = new Map<number, { id: string; w: number; h: number }[]>();
  for (const f of frames) {
    const list = rows.get(f.row) ?? [];
    list.push(f);
    rows.set(f.row, list);
  }
  const out: Record<string, Rect> = {};
  let y = 0;
  let firstWidth = 0;
  [...rows.keys()]
    .sort((a, b) => a - b)
    .forEach((key, ri) => {
      const list = rows.get(key) ?? [];
      const width = list.reduce((a, f) => a + f.w, 0) + GAP * Math.max(0, list.length - 1);
      if (ri === 0) firstWidth = width;
      const dx = ri ? Math.max(0, (firstWidth - width) / 2) : 0;
      let x = dx;
      let h = 0;
      for (const f of list) {
        out[f.id] = { x, y, w: f.w, h: f.h };
        x += f.w + GAP;
        h = Math.max(h, f.h);
      }
      y += h + ROW_GAP;
    });
  return out;
}

export function bounds(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map(r => r.x));
  const y = Math.min(...rects.map(r => r.y));
  return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
}

/** Fit a world rect into the view, leaving room for frame labels above. */
export function fitCamera(
  r: Rect,
  view: Size,
  opts: { readonly pad?: number; readonly maxZ?: number; readonly offsetX?: number } = {},
): Camera {
  const pad = opts.pad ?? 24;
  const maxZ = opts.maxZ ?? 1;
  const z = clampZ(Math.min((view.w - pad * 2) / r.w, (view.h - pad * 2 - LABEL_SPACE) / r.h, maxZ));
  const x = (view.w - r.w * z) / 2 - r.x * z + (opts.offsetX ?? 0);
  let y = Math.max(pad + LABEL_SPACE, (view.h - r.h * z) / 2) - r.y * z;
  if (r.h * z > view.h - pad * 2) y = pad + LABEL_SPACE - r.y * z;
  return { x, y, z };
}

export const clampZ = (z: number): number => Math.max(MIN_Z, Math.min(MAX_Z, Number.isFinite(z) && z > 0 ? z : 1));

/** Zoom by a factor around a screen point, keeping that point fixed. */
export function zoomAt(c: Camera, factor: number, sx: number, sy: number): Camera {
  const z = clampZ(c.z * factor);
  const wx = (sx - c.x) / c.z;
  const wy = (sy - c.y) / c.z;
  return { z, x: sx - wx * z, y: sy - wy * z };
}

export const pan = (c: Camera, dx: number, dy: number): Camera => ({ ...c, x: c.x + dx, y: c.y + dy });

/** Point inside a frame as 0..1 fractions, for positional comment pins. */
export function framePoint(frame: DOMRectReadOnly | Rect, px: number, py: number): { x: number; y: number } {
  const left = 'left' in frame ? frame.left : frame.x;
  const top = 'top' in frame ? frame.top : frame.y;
  const w = 'width' in frame ? frame.width : frame.w;
  const h = 'height' in frame ? frame.height : frame.h;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return { x: clamp((px - left) / w), y: clamp((py - top) / h) };
}
