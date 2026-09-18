/**
 * Unit tests for the pure parts of the `scribble` render style
 * (docs/architecture.md §4.11, wave 17 T-0134 / v2 T-0136 / v3 T-0137): the
 * view-space-normal surface class, far-depth fade, world-anchored nested-LOD
 * strokes, sky-dome coordinates, tangle coverage growth, the neutral vs
 * coloured ink/wash colours, and the v3 precision-safe hash. Runs in node;
 * no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  INK,
  PAPER,
  UP_K,
  depthFade,
  hash2,
  inkColour,
  lodOf,
  nestedStrokeInk,
  skyCoords,
  skyDensity,
  strokeCoords,
  surfaceClass,
  tangleInk,
  viewNormal,
  viewPos,
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

/** Mulberry32 — deterministic [0, 1) stream from `seed`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('hash2', () => {
  it('is deterministic and in [0, 1) for 200 pairs including world-sized values', () => {
    const pairs: [number, number][] = [
      [5123.7, 61],
      [1e5, -1e4],
      [-4096.25, 8192.5],
    ];
    for (let i = 0; i < 197; i++) {
      pairs.push([i * 37.1 - 80, ((i * 19) % 200) + i * 0.17]);
    }
    expect(pairs.length).toBe(200);
    for (const [a, b] of pairs) {
      const h = hash2(a, b);
      expect(h, `hash2(${a}, ${b}) in [0, 1)`).toBeGreaterThanOrEqual(0);
      expect(h, `hash2(${a}, ${b}) in [0, 1)`).toBeLessThan(1);
      expect(hash2(a, b)).toBe(h);
    }
  });
});

describe('viewPos', () => {
  it('screen centre maps to (0, 0, −d)', () => {
    const p = viewPos([0.5, 0.5], 10, 0.7002, 16 / 9);
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(-10, 6);
  });

  it('right edge x ≈ tanHalfFov·aspect·d, z = −d', () => {
    const p = viewPos([1, 0.5], 10, 0.7002, 16 / 9);
    expect(p[0]).toBeCloseTo(12.448, 3);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(-10, 6);
  });
});

describe('viewNormal', () => {
  // Taps one texel-ish apart around a centre uv, all on the same plane.
  const DELTA = 0.002;
  const uv = (cx: number, cy: number): [number, number] => [cx, cy];
  const tapUvs = {
    L: uv(0.5 - DELTA, 0.3),
    R: uv(0.5 + DELTA, 0.3),
    U: uv(0.5, 0.3 + DELTA),
    D: uv(0.5, 0.3 - DELTA),
  };
  const TAN = 0.7002;
  const ASPECT = 16 / 9;

  it('a floor has up normal (|n.y| > 0.95)', () => {
    // Camera 1.7 m above a level ground plane: view-space floor height is
    // −1.7, so the analytic depth of a texel is d(uv) = 1.7 / ((0.5 − uv.y)·
    // 2·tanHalfFov). All four taps lie on that plane.
    const d = (u: [number, number]): number =>
      1.7 / ((0.5 - u[1]) * 2 * TAN);
    const n = viewNormal(tapUvs, { L: d(tapUvs.L), R: d(tapUvs.R), U: d(tapUvs.U), D: d(tapUvs.D) }, TAN, ASPECT);
    expect(Math.abs(n[1])).toBeGreaterThan(0.95);
    // ...and it points up (matching a level camera's viewUp = +y).
    expect(n[1]).toBeGreaterThan(0);
  });

  it('a frontal wall has normal toward the camera (|n.z| > 0.99)', () => {
    // Every tap at the same depth 30 → a plane facing the viewer.
    const n = viewNormal(tapUvs, { L: 30, R: 30, U: 30, D: 30 }, TAN, ASPECT);
    expect(Math.abs(n[2])).toBeGreaterThan(0.99);
  });
});

describe('surfaceClass', () => {
  it('sky, ground and wall per §4.11 v2', () => {
    // dC ≥ 0.98·far → sky (0).
    expect(surfaceClass(1970, 2000, 1)).toBe(0);
    // up ≈ 1 (a floor) → ground (1).
    expect(surfaceClass(30, 2000, 0.98)).toBe(1);
    // up ≈ 0 (a wall) → wall (2).
    expect(surfaceClass(30, 2000, 0.05)).toBe(2);
    // up exactly UP_K is NOT ground (strictly greater) → wall (2).
    expect(surfaceClass(30, 2000, UP_K)).toBe(2);
  });
});

describe('skyDensity', () => {
  it('mix(0.60, 0.30, daylight) — night denser, noon sparse', () => {
    expect(skyDensity(0)).toBeCloseTo(0.6, 6);
    expect(skyDensity(1)).toBeCloseTo(0.3, 6);
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

describe('strokeCoords', () => {
  it('wall with world normal [1, 0, 0] at W = [3, 7, 11]: u = ±11, along = 7; ground: u = 20, along = 14', () => {
    const W: [number, number, number] = [3, 7, 11];
    const nW: [number, number, number] = [1, 0, 0];
    const wall = strokeCoords(W, nW, 20, 0);
    expect(Math.abs(wall.u)).toBeCloseTo(11, 6);
    expect(wall.along).toBeCloseTo(7, 6);
    const ground = strokeCoords(W, nW, 20, 1);
    expect(ground.u).toBeCloseTo(20, 6);
    expect(ground.along).toBeCloseTo(14, 6);
  });
});

describe('lodOf', () => {
  it('lodOf(0.125) → { L: 0, f: 0 }; lodOf(0.25) → { L: 1, f: 0 }; lodOf(0.1875) → L: 0, f ≈ 0.585', () => {
    const a = lodOf(0.125);
    expect(a.L).toBe(0);
    expect(a.f).toBeCloseTo(0, 6);
    const b = lodOf(0.25);
    expect(b.L).toBe(1);
    expect(b.f).toBeCloseTo(0, 6);
    const c = lodOf(0.1875);
    expect(c.L).toBe(0);
    expect(c.f).toBeCloseTo(0.585, 3);
  });
});

describe('nestedStrokeInk', () => {
  it('tone 0 draws nothing on a 64 × 64 grid', () => {
    for (const { u, along } of grid64(0.05)) {
      expect(nestedStrokeInk(u, along, 0, 0.02)).toBe(0);
    }
  });

  it('every value at tone 1 lies in [0, 1]', () => {
    for (const { u, along } of grid64(0.05)) {
      const ink = nestedStrokeInk(u, along, 1, 0.02);
      expect(ink, `nestedStrokeInk(${u}, ${along}, 1, 0.02) in [0, 1]`).toBeGreaterThanOrEqual(0);
      expect(ink, `nestedStrokeInk(${u}, ${along}, 1, 0.02) in [0, 1]`).toBeLessThanOrEqual(1);
    }
  });

  it('density grows with tone', () => {
    const pts = grid64(0.05);
    const tones = [0, 0.2, 0.5, 0.8, 1];
    const means = tones.map((t) => mean(pts, (u, a) => nestedStrokeInk(u, a, t, 0.02)));
    for (let i = 1; i < means.length; i++) {
      expect(means[i], `mean at tone ${tones[i]} > tone ${tones[i - 1]}`).toBeGreaterThan(
        means[i - 1],
      );
    }
  });

  it('no pop across LOD boundaries', () => {
    const rng = mulberry32(20260918);
    for (let n = 0; n < 200; n++) {
      const u = rng() * 8;
      const along = rng() * 8;
      for (const j of [-3, -2]) {
        const mLo = 2 ** j * (1 - 1e-4);
        const mHi = 2 ** j * (1 + 1e-4);
        const a = nestedStrokeInk(u, along, 1, mLo);
        const b = nestedStrokeInk(u, along, 1, mHi);
        expect(
          Math.abs(a - b),
          `no pop at (${u}, ${along}) j=${j}: ${a} vs ${b}`,
        ).toBeLessThan(0.05);
      }
    }
  });

  it('depth-independent density', () => {
    const ms = [0.01, 0.02, 0.05];
    const means = ms.map((m) => mean(grid64(m), (u, a) => nestedStrokeInk(u, a, 1, m)));
    const avg = (means[0] + means[1] + means[2]) / 3;
    for (let i = 0; i < ms.length; i++) {
      expect(means[i], `mean at m=${ms[i]} within ±35 % of ${avg}`).toBeGreaterThanOrEqual(avg * 0.65);
      expect(means[i], `mean at m=${ms[i]} within ±35 % of ${avg}`).toBeLessThanOrEqual(avg * 1.35);
    }
  });
});

describe('skyCoords', () => {
  it('skyCoords([0, 0, −1], 100) → [0, 0]; zenith y ≈ 157.08; east x ≈ 157.08', () => {
    const north = skyCoords([0, 0, -1], 100);
    expect(north[0]).toBeCloseTo(0, 6);
    expect(north[1]).toBeCloseTo(0, 6);
    const zenith = skyCoords([0, 1, 0], 100);
    expect(zenith[1]).toBeCloseTo(157.08, 2);
    const east = skyCoords([1, 0, 0], 100);
    expect(east[0]).toBeCloseTo(157.08, 2);
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

  it('red tint yields reddish ink with r ≈ 0.50·0.85 + 0.12·0.15 = 0.443', () => {
    const c = inkColour([1, 0.2, 0.2]);
    expect(c[0]).toBeGreaterThan(c[1]);
    expect(c[0]).toBeGreaterThan(c[2]);
    expect(c[0]).toBeCloseTo(0.443, 3);
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
