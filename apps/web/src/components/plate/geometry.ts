import type { PlatePart, PlateSpec } from '../../ui-contract';

/**
 * Spec-driven technical plates (UX 7.1, 9.6). Pure geometry: any product is drawn to scale
 * from { kind, dims_mm, parts[] }. The renderer never branches on what the product is;
 * it extends the part vocabulary instead.
 */
export interface PlateFrame {
  readonly width: number;
  readonly height: number;
  readonly padL: number;
  readonly padB: number;
  readonly padT: number;
  readonly X: (x: number) => number;
  readonly Y: (y: number) => number;
  readonly s: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function plateFrame(spec: PlateSpec, s: number, dims: boolean): PlateFrame {
  const D = spec.dims_mm;
  const padL = dims ? 30 : 4;
  const padB = dims ? 30 : 4;
  const padT = 6;
  const padR = 8;
  return {
    width: Math.ceil(D.w * s + padL + padR),
    height: Math.ceil(D.h * s + padT + padB),
    padL,
    padB,
    padT,
    s,
    X: x => r2(padL + (x + D.w / 2) * s),
    Y: y => r2(padT + (D.h - y) * s),
  };
}

/** One scale for a row of specs, so their sizes compare honestly (shared mm grid per row). */
export function rowScale(specs: readonly PlateSpec[], maxH: number, maxW: number): number {
  if (!specs.length) return 1;
  const h = Math.max(...specs.map(x => x.dims_mm.h));
  const w = Math.max(...specs.map(x => x.dims_mm.w));
  return Math.min(maxH / h, maxW / w);
}

export function polyPoints(p: Extract<PlatePart, { t: 'poly' }>, f: PlateFrame): string {
  return p.pts.map(([x, y]) => `${f.X(x)},${f.Y(y)}`).join(' ');
}

export function holeCenters(p: Extract<PlatePart, { t: 'holes' }>, f: PlateFrame): { cx: number; cy: number; r: number }[] {
  return Array.from({ length: p.n }, (_, i) => ({ cx: f.X(p.x), cy: f.Y(p.y0 + i * p.step), r: r2(Math.max(1.2, p.r * f.s)) }));
}

/** Dimension lines: height on the inline-start, width under the floor. Labels in millimetres. */
export function dimensionPath(
  spec: PlateSpec,
  f: PlateFrame,
): { path: string; hLabel: { x: number; y: number }; wLabel: { x: number; y: number } } {
  const D = spec.dims_mm;
  const hx = f.padL - 14;
  const wy = f.Y(0) + 14;
  const path = [
    `M${hx - 4} ${f.Y(D.h)}h8`,
    `M${hx} ${f.Y(D.h)}V${f.Y(0)}`,
    `M${hx - 4} ${f.Y(0)}h8`,
    `M${f.X(-D.w / 2)} ${wy - 4}v8`,
    `M${f.X(-D.w / 2)} ${wy}H${f.X(D.w / 2)}`,
    `M${f.X(D.w / 2)} ${wy - 4}v8`,
  ].join('');
  return { path, hLabel: { x: hx - 4, y: r2((f.Y(D.h) + f.Y(0)) / 2) }, wLabel: { x: f.X(0), y: wy + 13 } };
}

/** Text alternative for a plate: kind/code and dimensions (UX 10, Plate). */
export function plateDims(spec: PlateSpec): string {
  return `${spec.dims_mm.w} × ${spec.dims_mm.h} mm`;
}
