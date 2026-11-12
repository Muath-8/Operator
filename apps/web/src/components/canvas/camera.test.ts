import { describe, expect, it } from 'vitest';
import { GAP, bounds, clampZ, fitCamera, framePoint, layoutFrames, zoomAt } from './camera';

describe('canvas camera', () => {
  it('lays frames out in rows with a fixed gap and centres later rows', () => {
    const r = layoutFrames([
      { id: 'a', row: 0, w: 200, h: 100 },
      { id: 'b', row: 0, w: 300, h: 150 },
      { id: 'c', row: 1, w: 100, h: 50 },
    ]);
    expect(r.a).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(r.b?.x).toBe(200 + GAP);
    expect(r.c?.y).toBeGreaterThan(150);
    expect(r.c?.x).toBeCloseTo((200 + GAP + 300 - 100) / 2);
  });

  it('fits a rect inside the view and never zooms past 100% by default', () => {
    const c = fitCamera({ x: 0, y: 0, w: 100, h: 100 }, { w: 1000, h: 800 });
    expect(c.z).toBe(1);
    const big = fitCamera({ x: 0, y: 0, w: 4000, h: 1000 }, { w: 1000, h: 800 });
    expect(big.z).toBeLessThan(1);
    expect(4000 * big.z).toBeLessThanOrEqual(1000);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const c = { x: 10, y: 20, z: 1 };
    const n = zoomAt(c, 2, 300, 200);
    const before = { x: (300 - c.x) / c.z, y: (200 - c.y) / c.z };
    const after = { x: (300 - n.x) / n.z, y: (200 - n.y) / n.z };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps zoom and rejects nonsense', () => {
    expect(clampZ(100)).toBe(2.5);
    expect(clampZ(0)).toBe(1);
    expect(clampZ(Number.NaN)).toBe(1);
    expect(clampZ(0.01)).toBe(0.15);
  });

  it('computes bounds and pin points', () => {
    expect(bounds([])).toBeNull();
    expect(
      bounds([
        { x: 10, y: 10, w: 10, h: 10 },
        { x: 0, y: 30, w: 5, h: 5 },
      ]),
    ).toEqual({ x: 0, y: 10, w: 20, h: 25 });
    expect(framePoint({ x: 100, y: 100, w: 200, h: 100 }, 200, 150)).toEqual({ x: 0.5, y: 0.5 });
    expect(framePoint({ x: 100, y: 100, w: 200, h: 100 }, 0, 999)).toEqual({ x: 0, y: 1 });
  });
});
