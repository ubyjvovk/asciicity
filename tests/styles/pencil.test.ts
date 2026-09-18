/**
 * Unit tests for the pure parts of the `pencil` render style
 * (docs/architecture.md §4.11, wave 18 "sketch family"): the smudged
 * tone wash, the 45° cross-hatch stroke-space rotation, and the
 * ground-tune mirrors `groundTone` / `crossGate`. The shared
 * stroke machinery (hash, viewPos/viewNormal, depthFade, stroke
 * coordinates/scale/LOD, wobble/lifts, nestedStrokeInk, sky coordinates,
 * hair) is unit-tested in `tests/styles/strokes.test.ts`. Runs in node;
 * no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  G,
  PAPER_P,
  crossCoords,
  crossGate,
  groundTone,
  pencilWash,
} from '../../src/render/styles/pencil';

describe('pencilWash', () => {
  it('paper at tone 0 — wash 0 leaves base = PAPER_P (3 tooth values)', () => {
    // wash = 0 at tone 0 for every tooth g, so mix(PAPER_P, G, 0) = PAPER_P.
    for (const g of [0.8, 1.0, 1.2]) {
      expect(pencilWash(0, g)).toBe(0);
    }
    const baseR = PAPER_P[0] + (G[0] - PAPER_P[0]) * pencilWash(0, 1.2);
    expect(baseR).toBeCloseTo(PAPER_P[0], 6);
  });

  it('monotone in tone at three points', () => {
    const g = 1.1;
    const w0 = pencilWash(0.2, g);
    const w1 = pencilWash(0.5, g);
    const w2 = pencilWash(0.9, g);
    expect(w0).toBeGreaterThan(0);
    expect(w1).toBeGreaterThan(w0);
    expect(w2).toBeGreaterThan(w1);
    expect(w2).toBeLessThan(1);
  });

  it('formula tone · 0.55 · g at three points', () => {
    expect(pencilWash(1, 1)).toBeCloseTo(0.55, 6);
    expect(pencilWash(0.5, 1.0)).toBeCloseTo(0.275, 6);
    expect(pencilWash(0.25, 1.1)).toBeCloseTo(0.15125, 6);
  });
});

describe('groundTone', () => {
  it('groundTone(1) → 0.55', () => {
    expect(groundTone(1)).toBeCloseTo(0.55, 6);
  });
});

describe('crossGate', () => {
  it('0 at 0.5, 1 at 0.7, monotone', () => {
    expect(crossGate(0.5)).toBe(0);
    expect(crossGate(0.7)).toBe(1);
    const a = crossGate(0.55);
    const b = crossGate(0.6);
    const c = crossGate(0.65);
    const d = crossGate(0.7);
    expect(a).toBe(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(c);
    expect(d).toBe(1);
  });
});

describe('crossCoords', () => {
  it('rotates the stroke space 45° at three points', () => {
    const s = Math.SQRT2;
    const a = crossCoords(1, 0, 0.5, 0.7);
    expect(a.u).toBeCloseTo(1 / s, 6);
    expect(a.along).toBeCloseTo(0 / s - 1 / s, 6);
    const b = crossCoords(0, 2, 1.0, 1.0);
    expect(b.u).toBeCloseTo(2 / s, 6);
    expect(b.along).toBeCloseTo(2 / s, 6);
    const c = crossCoords(-3, 4, 0.4, 1.2);
    expect(c.u).toBeCloseTo((-3 + 4) / s, 6);
    expect(c.along).toBeCloseTo((4 - -3) / s, 6);
  });

  it('mu2 = ma2 = (mu + ma)/2 — the rotated family shares one scale', () => {
    expect(crossCoords(1, 0, 0.5, 0.7).mu).toBeCloseTo(0.6, 6);
    expect(crossCoords(1, 0, 0.5, 0.7).ma).toBeCloseTo(0.6, 6);
    expect(crossCoords(0, 2, 1.0, 1.0).mu).toBeCloseTo(1.0, 6);
    expect(crossCoords(0, 2, 1.0, 1.0).ma).toBeCloseTo(1.0, 6);
    expect(crossCoords(-3, 4, 0.4, 1.2).mu).toBeCloseTo(0.8, 6);
    expect(crossCoords(-3, 4, 0.4, 1.2).ma).toBeCloseTo(0.8, 6);
  });

  it('orthogonal rotation — u² + along² is preserved at three points', () => {
    for (const [u, along] of [
      [1, 0],
      [0, 2],
      [-3, 4],
    ] as const) {
      const r = crossCoords(u, along, 0.5, 0.7);
      expect(r.u * r.u + r.along * r.along).toBeCloseTo(u * u + along * along, 6);
    }
  });
});
