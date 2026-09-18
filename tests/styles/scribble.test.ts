/**
 * Unit tests for the pure parts of the `scribble` render style
 * (docs/architecture.md §4.11, wave 17, T-0134): the surface-class split,
 * far-depth fade, stroke-density and tangle coverage growth, the neutral vs
 * coloured ink/wash colours, and the deterministic hash. Runs in node; no
 * WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  INK,
  PAPER,
  SCRIBBLE_LAYERS,
  SKY_INK,
  SLOPE_K,
  depthFade,
  hash2,
  inkColour,
  strokeInk,
  surfaceClass,
  tangleInk,
  washColour,
} from '../../src/render/styles/scribble';

/** A 64 × 64 grid of `(u, along)` at `step` intervals over `[0, 64·step)`. */
function grid64(step: number): { u: number; along: number }[] {
  const pts: { u: number; along: number }[] = [];
  for (let i = 0; i < 64; i++) {
    for (let j = 0; j < 64; j++) {
      pts.push({ u: i * step, along: j * step });
    }
  }
  return pts;
}

/** Mean of `f` over the given points. */
function mean(pts: { u: number; along: number }[], f: (u: number, a: number) => number): number {
  let s = 0;
  for (const { u, along } of pts) s += f(u, along);
  return s / pts.length;
}

describe('hash2', () => {
  it('is deterministic and in [0, 1) for 200 integer pairs', () => {
    for (let a = -50; a < 150; a++) {
      for (let b = -50; b < 150; b++) {
        const h = hash2(a, b);
        expect(h, `hash2(${a}, ${b}) in [0, 1)`).toBeGreaterThanOrEqual(0);
        expect(h, `hash2(${a}, ${b}) in [0, 1)`).toBeLessThan(1);
      }
    }
    // 200 distinct pairs, same input twice → same output.
    for (let i = 0; i < 200; i++) {
      const a = i * 7 + 3;
      const b = i * 13 + 5;
      expect(hash2(a, b)).toBe(hash2(a, b));
    }
  });
});

describe('surfaceClass', () => {
  it('sky, ground and wall per §4.11', () => {
    // dC ≥ 0.98·far → sky (0).
    expect(surfaceClass(1960, 1970, 1950, 2000)).toBe(0);
    // slope 0.015 > SLOPE_K → ground (1).
    expect(surfaceClass(20, 20.3, 19.7, 2000)).toBe(1);
    // slope 0.0005 ≤ SLOPE_K → wall (2).
    expect(surfaceClass(20, 20.01, 19.99, 2000)).toBe(2);
    // flat → wall (2).
    expect(surfaceClass(50, 50, 50, 2000)).toBe(2);
  });
});

describe('depthFade', () => {
  it('1 up to 120, 0.55 from 900', () => {
    expect(depthFade(0)).toBe(1);
    expect(depthFade(120)).toBe(1);
    expect(depthFade(900)).toBeCloseTo(0.55, 6);
    expect(depthFade(2000)).toBeCloseTo(0.55, 6);
  });
});

describe('strokeInk', () => {
  it('tone 0 draws nothing across the 64×64 grid', () => {
    for (const { u, along } of grid64(0.5)) {
      expect(strokeInk(u, along, 0)).toBe(0);
    }
  });

  it('every value at tone 0.5 and 1 lies in [0, 1]', () => {
    for (const tone of [0.5, 1]) {
      for (const { u, along } of grid64(0.5)) {
        const ink = strokeInk(u, along, tone);
        expect(ink, `strokeInk(${u}, ${along}, ${tone}) in [0, 1]`).toBeGreaterThanOrEqual(0);
        expect(ink, `strokeInk(${u}, ${along}, ${tone}) in [0, 1]`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('density strictly grows with tone and is ≥ 0.25 at tone 1', () => {
    const pts = grid64(0.5);
    const tones = [0, 0.2, 0.5, 0.8, 1.0];
    const means = tones.map((t) => mean(pts, (u, a) => strokeInk(u, a, t)));
    for (let i = 1; i < means.length; i++) {
      expect(means[i], `mean at tone ${tones[i]} > tone ${tones[i - 1]}`).toBeGreaterThan(
        means[i - 1],
      );
    }
    expect(means[means.length - 1]).toBeGreaterThanOrEqual(0.25);
  });
});

describe('tangleInk', () => {
  it('density 0 draws nothing across the 64×64 grid', () => {
    for (let px = 0; px < 64; px++) {
      for (let py = 0; py < 64; py++) {
        expect(tangleInk(px, py, 0)).toBe(0);
      }
    }
  });

  it('coverage strictly grows with density', () => {
    const densities = [0, 0.25, 0.55, 1.0];
    const pts: { u: number; along: number }[] = [];
    for (let px = 0; px < 64; px++) {
      for (let py = 0; py < 64; py++) pts.push({ u: px, along: py });
    }
    const means = densities.map((d) =>
      mean(pts, (px, py) => tangleInk(px, py, d)),
    );
    for (let i = 1; i < means.length; i++) {
      expect(means[i], `mean at density ${densities[i]}`).toBeGreaterThan(means[i - 1]);
    }
  });
});

describe('inkColour', () => {
  it('neutral grey ink is INK', () => {
    const c = inkColour([0.8, 0.8, 0.8]);
    expect(c[0]).toBeCloseTo(INK[0], 6);
    expect(c[1]).toBeCloseTo(INK[1], 6);
    expect(c[2]).toBeCloseTo(INK[2], 6);
  });

  it('red tint yields reddish ink with r ≈ 0.55', () => {
    const c = inkColour([1, 0.2, 0.2]);
    expect(c[0]).toBeGreaterThan(c[1]);
    expect(c[0]).toBeGreaterThan(c[2]);
    expect(c[0]).toBeCloseTo(0.55, 6);
  });
});

describe('washColour', () => {
  it('tone 0 is PAPER; tone 1 is a red-leaning wash', () => {
    const flat = washColour([1, 0.2, 0.2], 0);
    expect(flat[0]).toBeCloseTo(PAPER[0], 6);
    expect(flat[1]).toBeCloseTo(PAPER[1], 6);
    expect(flat[2]).toBeCloseTo(PAPER[2], 6);
    const inked = washColour([1, 0.2, 0.2], 1);
    expect(inked[0]).toBeGreaterThan(inked[2]);
  });
});
