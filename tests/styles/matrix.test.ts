/**
 * Unit tests for the pure matrix-style helpers (docs/architecture.md §4.11):
 * `hash3`, `matrixGlyph`, `rainIntensity`. Runs in node; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  hash3,
  matrixGlyph,
  rainIntensity,
  STYLES,
} from '../../src/render/styles/matrix';

describe('STYLES', () => {
  it('exports id matrix at cell 6×12, sub 1×1, no depth', () => {
    expect(STYLES).toHaveLength(1);
    const s = STYLES[0];
    expect(s.id).toBe('matrix');
    expect(s.label).toBe('MATRIX');
    expect(s.cellW).toBe(6);
    expect(s.cellH).toBe(12);
    expect(s.subX).toBe(1);
    expect(s.subY).toBe(1);
    expect(s.needsDepth).toBe(false);
    expect(s.update).toBeUndefined();
  });
});

describe('hash3', () => {
  it('is deterministic, in [0, 1), and differs for (1,2,3) vs (2,1,3)', () => {
    const a = hash3(1, 2, 3);
    const b = hash3(1, 2, 3);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    const swapped = hash3(2, 1, 3);
    expect(swapped).toBeGreaterThanOrEqual(0);
    expect(swapped).toBeLessThan(1);
    expect(swapped).not.toBe(a);
    // A few extra points stay in range.
    for (const [x, y, z] of [
      [0, 0, 0],
      [7, 1, 0],
      [7, 2, 0],
      [12, 4, 9],
    ] as const) {
      const h = hash3(x, y, z);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});

describe('matrixGlyph', () => {
  it('is in [0, count) and constant within one 1/8-s window but changes across windows for at least one of 50 cells', () => {
    const count = 68;
    const withinA = 0.0;
    const withinB = 0.12; // still floor(t·8) = 0
    const nextWindow = 0.125; // floor(t·8) = 1

    let changed = 0;
    for (let i = 0; i < 50; i++) {
      const x = i;
      const y = (i * 3) % 17;
      const a = matrixGlyph(x, y, withinA, count);
      const b = matrixGlyph(x, y, withinB, count);
      const c = matrixGlyph(x, y, nextWindow, count);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(count);
      expect(Number.isInteger(a)).toBe(true);
      expect(b).toBe(a);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(count);
      if (c !== a) changed += 1;
    }
    expect(changed).toBeGreaterThanOrEqual(1);
  });
});

/** y in [0, 1) that maximises `rainIntensity` for a column at time `t`. */
function headY(colX: number, t: number): number {
  let bestY = 0;
  let best = -Infinity;
  const n = 800;
  for (let i = 0; i < n; i++) {
    const y = i / n;
    const v = rainIntensity(colX, y, t);
    if (v > best) {
      best = v;
      bestY = y;
    }
  }
  return bestY;
}

describe('rainIntensity', () => {
  it('is in [0, 1], and for a fixed column the head position (argmax over y) moves downward as time increases (y01 = vUv.y; §4.11 +time term → larger y01 between wraps, then toward 0 at the seam)', () => {
    const colX = 7;
    for (let t = 0; t <= 4; t += 0.5) {
      for (let i = 0; i <= 20; i++) {
        const y = i / 20;
        const v = rainIntensity(colX, y, t);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }

    // §4.11: trail = fract(phase + time·speed·0.25 − y01). The argmax sits
    // just above fract(K), so between fract-seams it travels toward larger
    // y01 (vUv.y → 1, the top of the frame) and then wraps to 0.
    let found = false;
    for (let t0 = 0; t0 < 12 && !found; t0 += 0.2) {
      const t1 = t0 + 0.15;
      const y0 = headY(colX, t0);
      const y1 = headY(colX, t1);
      if (Math.abs(y1 - y0) > 0.4) continue; // wrapped
      expect(y1).toBeGreaterThan(y0);
      found = true;
    }
    expect(found).toBe(true);
  });
});
