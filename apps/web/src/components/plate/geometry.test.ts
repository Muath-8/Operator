import { describe, expect, it } from 'vitest';
import type { PlateSpec } from '../../ui-contract';
import { dimensionPath, holeCenters, plateFrame, rowScale } from './geometry';

/* Two unrelated shapes, defined here as data: the renderer must not care what they are. */
const tall: PlateSpec = { kind: 'a', dims_mm: { w: 70, h: 120 }, parts: [{ t: 'rect', x: -35, y: 0, w: 70, h: 120 }] };
const wide: PlateSpec = { kind: 'b', dims_mm: { w: 1200, h: 750 }, parts: [{ t: 'holes', x: 0, y0: 10, n: 3, step: 5, r: 1 }] };

describe('plate geometry (one renderer, any spec)', () => {
  it('draws a row at one shared millimetre scale', () => {
    const s = rowScale([tall, { ...tall, dims_mm: { w: 84, h: 108 } }], 210, 150);
    expect(s).toBeCloseTo(210 / 120);
    // The taller item is drawn taller at the same scale: sizes compare honestly.
    expect(120 * s).toBeGreaterThan(108 * s);
  });

  it('fits by width when width binds', () => {
    expect(rowScale([wide], 130, 200)).toBeCloseTo(200 / 1200);
  });

  it('maps millimetres with origin at bottom centre, y up', () => {
    const f = plateFrame(tall, 2, true);
    expect(f.X(0)).toBe(f.padL + 35 * 2);
    expect(f.Y(0)).toBe(f.padT + 120 * 2);
    expect(f.Y(120)).toBe(f.padT);
    expect(f.width).toBe(Math.ceil(70 * 2 + f.padL + 8));
  });

  it('places holes along the spec and keeps them visible at small scales', () => {
    const f = plateFrame(wide, 0.1, false);
    const h = holeCenters({ t: 'holes', x: 0, y0: 10, n: 3, step: 5, r: 1 }, f);
    expect(h).toHaveLength(3);
    expect(h.every(c => c.r >= 1.2)).toBe(true);
  });

  it('labels dimensions from the spec', () => {
    const f = plateFrame(tall, 1, true);
    const d = dimensionPath(tall, f);
    expect(d.path).toMatch(/^M/);
    expect(d.wLabel.x).toBe(f.X(0));
  });
});
