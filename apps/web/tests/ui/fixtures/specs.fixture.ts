import type { MarkGlyph, PlateExhibit, PlateSpec, PlateTint } from '../../../src/ui-contract';

/**
 * TEST FIXTURE. Seed product specs, the same ones the combined prototype draws.
 * Category vocabulary lives here and in other *.fixture.ts files only (I-15).
 */
export const BOTTLE = (code: string, bw: number, bh: number, r: number, nw: number, cw: number, ch: number): PlateSpec => ({
  kind: 'vessel',
  code,
  dims_mm: { w: bw, h: bh + 8 + ch, d: bw * 0.55 },
  parts: [
    { t: 'rect', x: -bw / 2, y: 0, w: bw, h: bh, r, m: 'glass', role: 'body' },
    { t: 'line', x1: -bw / 2 + 5, y1: bh * 0.72, x2: bw / 2 - 5, y2: bh * 0.72, m: 'hint' },
    { t: 'line', x1: -bw / 2 + 5, y1: 5, x2: bw / 2 - 5, y2: 5, m: 'hint' },
    { t: 'rect', x: -nw / 2, y: bh, w: nw, h: 8, r: 0, m: 'glass', role: 'neck' },
    { t: 'rect', x: -cw / 2, y: bh + 8, w: cw, h: ch, r: 2, m: 'ghost', role: 'closure', finish: true, note: 'ordered separately' },
  ],
});

export const STRAP = (code: string, lug: number, tip: number): PlateSpec => ({
  kind: 'strap',
  code,
  dims_mm: { w: lug * 2 + 14, h: 120, d: 4 },
  parts: [
    {
      t: 'poly',
      pts: [
        [-lug - 7, 120],
        [-7, 120],
        [-7 - (lug - tip) / 2, 45],
        [-lug - 7 + (lug - tip) / 2, 45],
      ],
      m: 'leather',
      role: 'body',
    },
    { t: 'rect', x: -lug - 9, y: 30, w: lug + 4, h: 15, r: 2, m: 'metal', role: 'hardware' },
    { t: 'rect', x: -lug - 6, y: 33, w: lug - 2, h: 9, r: 1, m: 'void' },
    {
      t: 'poly',
      pts: [
        [7, 120],
        [7 + lug, 120],
        [7 + lug - (lug - tip) / 2, 12],
        [7 + lug / 2, 0],
        [7 + (lug - tip) / 2, 12],
      ],
      m: 'leather',
      role: 'body',
    },
    { t: 'holes', x: 7 + lug / 2, y0: 24, n: 6, step: 7, r: 1.3 },
    { t: 'rect', x: 7 - 1, y: 96, w: lug + 2, h: 5, r: 1, m: 'leather', role: 'body' },
  ],
});

export const JAR: PlateSpec = {
  kind: 'jar',
  code: 'J-200',
  dims_mm: { w: 84, h: 104, d: 84 },
  parts: [
    { t: 'rect', x: -40, y: 0, w: 80, h: 90, r: 6, m: 'glass', role: 'body' },
    { t: 'rect', x: -35, y: 5, w: 70, h: 58, r: 3, m: 'wax', role: 'fill' },
    { t: 'line', x1: 0, y1: 63, x2: 0, y2: 72, m: 'solid' },
    { t: 'rect', x: -42, y: 90, w: 84, h: 14, r: 3, m: 'wood', role: 'closure' },
  ],
};

export const TABLE: PlateSpec = {
  kind: 'table',
  code: 'T-1200',
  dims_mm: { w: 1200, h: 750, d: 700 },
  parts: [
    { t: 'rect', x: -600, y: 710, w: 1200, h: 40, r: 6, m: 'wood', role: 'top' },
    { t: 'rect', x: -560, y: 0, w: 50, h: 710, r: 2, m: 'wood', role: 'leg' },
    { t: 'rect', x: 510, y: 0, w: 50, h: 710, r: 2, m: 'wood', role: 'leg' },
    { t: 'line', x1: -510, y1: 640, x2: 510, y2: 640, m: 'hint' },
  ],
};

export const BOX = (code: string, w: number, h: number, word: string, wordAr: string, line: string): PlateSpec => ({
  kind: 'box',
  code,
  dims_mm: { w, h, d: w },
  parts: [
    { t: 'rect', x: -w / 2, y: 0, w, h, r: 0, m: 'solid', role: 'box' },
    { t: 'mark', cx: 0, cy: h * 0.66, size: w * 0.42, role: 'mark' },
    { t: 'text', x: 0, y: h * 0.4, s: word, size: 9, role: 'ink', track: 2.4 },
    { t: 'text', x: 0, y: h * 0.28, s: wordAr, size: 11, role: 'mark', lang: 'ar' },
    { t: 'text', x: 0, y: 8, s: line, size: 5, role: 'ink' },
  ],
});

export const CLOSURE: PlateSpec = {
  kind: 'part',
  code: 'closure',
  dims_mm: { w: 30, h: 32 },
  parts: [{ t: 'rect', x: -14, y: 0, w: 28, h: 30, r: 2, m: 'metal', role: 'closure', finish: true }],
};

/** Original marks, as paths with palette indices. */
export const MARK_CLOUD: MarkGlyph = {
  viewBox: '0 0 64 64',
  paths: [
    { d: 'M32 5a27 27 0 1 1 0 54a27 27 0 0 1 0-54z', stroke: 3, width: 1.6 },
    { d: 'M19 39h26a7 7 0 0 0 .9-13.9A10 10 0 0 0 26.6 24 7.6 7.6 0 0 0 19 39z', fill: 2, stroke: 3, width: 1.8 },
  ],
};
export const MARK_ARCH: MarkGlyph = {
  viewBox: '0 0 64 64',
  paths: [
    { d: 'M16 54V30a16 16 0 0 1 32 0v24', stroke: 1, width: 3 },
    { d: 'M32 46c-5-4-5-9 0-15 5 6 5 11 0 15z', fill: 1 },
    { d: 'M10 54h44', stroke: 1, width: 3 },
  ],
};
export const MARK_DUNES: MarkGlyph = {
  viewBox: '0 0 64 64',
  paths: [
    { d: 'M6 40c10-10 18-10 26 0s16 10 26 0', stroke: 0, width: 2.6 },
    { d: 'M6 48c10-8 18-8 26 0s16 8 26 0', stroke: 3, width: 2.6 },
    { d: 'M44 15a5 5 0 1 1 0 10a5 5 0 0 1 0-10z', fill: 3 },
  ],
};
/** 16px mission icons for the rail, drawn with currentColor. */
export const ICON_CLOUD: MarkGlyph = {
  viewBox: '0 0 16 16',
  paths: [{ d: 'M4.5 11.5h7a2.5 2.5 0 0 0 .3-5A3.5 3.5 0 0 0 5 6.2a2.7 2.7 0 0 0-.5 5.3z', stroke: 'current', width: 1.5 }],
};
export const ICON_STRAP: MarkGlyph = {
  viewBox: '0 0 16 16',
  paths: [
    { d: 'M6 1.5h4v4H6zM6 10.5h4v4H6z', stroke: 'current', width: 1.5 },
    { d: 'M6.5 5h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', stroke: 'current', width: 1.5 },
    { d: 'M8 7v1.5l1 .8', stroke: 'current', width: 1.5 },
  ],
};
export const ICON_DOC: MarkGlyph = {
  viewBox: '0 0 16 16',
  paths: [{ d: 'M4.5 2.5h5l2.5 2.5v8.5h-7.5zM9.5 2.5V5H12', stroke: 'current', width: 1.5 }],
};

export const exhibit = (spec: PlateSpec, summary: string, extra: { tint?: PlateTint; finish?: 'matte' | 'gloss' } = {}): PlateExhibit => ({
  spec,
  summary,
  ...extra,
});
