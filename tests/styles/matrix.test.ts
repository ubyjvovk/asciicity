/**
 * Unit tests for the pure matrix-style helpers (docs/architecture.md §4.11):
 * `hash3`, `matrixGlyph`, `rainIntensity`, `matrixBrightness`. Runs in node;
 * no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  hash3,
  matrixGlyph,
  rainIntensity,
  matrixBrightness,
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
  it('is in [0, count) and changes for a cell across a 0.5-s boundary and is constant within 0.1 s', () => {
    const count = 68;
    for (let i = 0; i < 50; i++) {
      const g = matrixGlyph(i, (i * 3) % 17, 0.37, count);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThan(count);
      expect(Number.isInteger(g)).toBe(true);
    }

    // Window = floor(time·2 + 7·hash). 0.1 s moves the argument by 0.2, so
    // stay inside a window whose fractional part is in (0.15, 0.35). 0.5 s
    // always increments the window index by 1.
    let foundConst = false;
    let foundChange = false;
    for (let i = 0; i < 50; i++) {
      const x = i;
      const y = (i * 3) % 17;
      const phase = 7 * hash3(x, y, 0);
      const frac = phase - Math.floor(phase);
      const t = (0.25 - frac) / 2;
      const tMid = t < 0 ? t + 0.5 : t;
      const a = matrixGlyph(x, y, tMid, count);
      const within = matrixGlyph(x, y, tMid + 0.1, count);
      const across = matrixGlyph(x, y, tMid + 0.5, count);
      expect(within).toBe(a);
      foundConst = true;
      if (across !== a) foundChange = true;
    }
    expect(foundConst).toBe(true);
    expect(foundChange).toBe(true);
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
  it('is in [0, 1], and for a fixed column the head position (argmax over y) moves downward (smaller y01; y01 = vUv.y, head moves toward 0) as time increases', () => {
    const colX = 7;
    for (let t = 0; t <= 4; t += 0.5) {
      for (let i = 0; i <= 20; i++) {
        const y = i / 20;
        const v = rainIntensity(colX, y, t);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }

    // §4.11: trail = fract(phase − time·speed·0.25 − y01). The argmax sits
    // just above fract(K) and, between fract-seams, travels toward smaller
    // y01 (vUv.y → 0, the bottom of the frame) as time increases.
    let found = false;
    for (let t0 = 0; t0 < 12 && !found; t0 += 0.2) {
      const t1 = t0 + 0.15;
      const y0 = headY(colX, t0);
      const y1 = headY(colX, t1);
      if (y1 > y0) continue; // wrapped past 0
      if (Math.abs(y1 - y0) < 1e-6) continue;
      expect(y1).toBeLessThan(y0);
      found = true;
    }
    expect(found).toBe(true);
  });
});

describe('matrixBrightness', () => {
  it('matrixBrightness(0, 0, false) is black', () => {
    const rgb = matrixBrightness(0, 0, false);
    expect(rgb[0]).toBeCloseTo(0);
    expect(rgb[1]).toBeCloseTo(0);
    expect(rgb[2]).toBeCloseTo(0);
  });

  it('matrixBrightness(0, 1, false) is dim green (g ≈ 0.12)', () => {
    const rgb = matrixBrightness(0, 1, false);
    expect(rgb[0]).toBeCloseTo(0.024);
    expect(rgb[1]).toBeCloseTo(0.12);
    expect(rgb[2]).toBeCloseTo(0.036);
  });

  it('matrixBrightness(1, 1, false) is full green', () => {
    const rgb = matrixBrightness(1, 1, false);
    // (0.2, 1.0, 0.3) · (1·1 + 0.12) = (0.224, 1.12, 0.336)
    expect(rgb[0]).toBeCloseTo(0.224);
    expect(rgb[1]).toBeCloseTo(1.12);
    expect(rgb[2]).toBeCloseTo(0.336);
    expect(rgb[1]).toBeGreaterThan(rgb[0]);
    expect(rgb[1]).toBeGreaterThan(rgb[2]);
  });

  it('head with S = 1 is near-white', () => {
    const rgb = matrixBrightness(1, 0, true);
    expect(rgb[0]).toBeCloseTo(0.9);
    expect(rgb[1]).toBeCloseTo(1.0);
    expect(rgb[2]).toBeCloseTo(0.9);
  });
});
