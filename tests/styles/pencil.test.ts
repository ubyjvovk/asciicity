/**
 * Unit tests for the pure parts of the `pencil` render style
 * (docs/architecture.md §4.11, wave 18c "Pencil / crayon v2"): the
 * smudge / wall-wash / hatch-gate / facade-direction mirrors, plus the
 * kept `pencilWash` and `crossCoords`. The shared stroke machinery is
 * unit-tested in `tests/styles/strokes.test.ts`. Runs in node; no
 * WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  G,
  PAPER_P,
  crossCoords,
  facadeDir,
  hatchGate,
  pencilWash,
  smudgeOf,
  wallWash,
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

describe('smudgeOf', () => {
  it('smudgeOf(0.5, 1) → 0', () => {
    expect(smudgeOf(0.5, 1)).toBe(0);
  });

  it('smudgeOf(1, 1) → 0.30', () => {
    expect(smudgeOf(1, 1)).toBeCloseTo(0.3, 6);
  });
});

describe('wallWash', () => {
  it('0 at toneS 0.20, 0.35 at toneS 0.90 with g = 1', () => {
    expect(wallWash(0.2, 1)).toBe(0);
    expect(wallWash(0.9, 1)).toBeCloseTo(0.35, 6);
  });
});

describe('hatchGate', () => {
  it('hatchGate(1, 0) → 1', () => {
    expect(hatchGate(1, 0)).toBe(1);
  });

  it('hatchGate(1, 400) → 0', () => {
    expect(hatchGate(1, 400)).toBe(0);
  });

  it('hatchGate(0.5, 0) → 0', () => {
    expect(hatchGate(0.5, 0)).toBe(0);
  });
});

describe('facadeDir', () => {
  it('facadeDir is deterministic and takes both values over 100 random inputs', () => {
    const seen = new Set<0 | 1>();
    for (let i = 0; i < 100; i++) {
      const nW: readonly [number, number, number] = [
        Math.sin(i * 0.37),
        0,
        Math.cos(i * 0.53),
      ];
      const W: readonly [number, number, number] = [i * 17.3 - 40, 12, i * -11.9];
      const a = facadeDir(nW, W);
      expect(a === 0 || a === 1).toBe(true);
      expect(facadeDir(nW, W)).toBe(a);
      seen.add(a);
    }
    expect(seen.has(0)).toBe(true);
    expect(seen.has(1)).toBe(true);
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
