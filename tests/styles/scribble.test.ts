/**
 * Unit tests for the pure parts of the `scribble` render style
 * (docs/architecture.md §4.11, wave 17 T-0134 / v2 T-0136 / v3 T-0137 /
 * v4 T-0138): the view-space-normal surface class, far-depth fade,
 * world-anchored nested-LOD strokes (screen-gradient scale, world-metre
 * wobble/lifts), stereographic sky-dome coordinates, hair coverage, the
 * neutral vs coloured ink/wash colours, and the v3 precision-safe hash.
 * Runs in node; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  INK,
  PAPER,
  UP_K,
  depthFade,
  hairDir,
  hairInk,
  hash2,
  inkColour,
  lifted,
  lodOf,
  nestedStrokeInk,
  skyCoords,
  skyDensity,
  strokeCoords,
  strokeScale,
  surfaceClass,
  viewNormal,
  viewPos,
  washColour,
  wobble,
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
  it('mix(0.75, 0.45, daylight) — night denser, noon sparse', () => {
    expect(skyDensity(0)).toBeCloseTo(0.75, 6);
    expect(skyDensity(1)).toBeCloseTo(0.45, 6);
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

describe('strokeScale', () => {
  it('wall taps {L:1,R:3}/{U:7,D:5} → {mu:1, ma:1}; ground {U:25,D:20}/{L:0,R:4} → {mu:2.5, ma:2}; degenerate u L=R=5 → mu = 1e−4', () => {
    const wall = strokeScale(
      { L: 1, R: 3, U: 0, D: 0 },
      { L: 0, R: 0, U: 7, D: 5 },
      0,
    );
    expect(wall.mu).toBeCloseTo(1, 6);
    expect(wall.ma).toBeCloseTo(1, 6);
    const ground = strokeScale(
      { L: 0, R: 0, U: 25, D: 20 },
      { L: 0, R: 4, U: 0, D: 0 },
      1,
    );
    expect(ground.mu).toBeCloseTo(2.5, 6);
    expect(ground.ma).toBeCloseTo(2, 6);
    const degenerate = strokeScale(
      { L: 5, R: 5, U: 0, D: 0 },
      { L: 0, R: 0, U: 0, D: 0 },
      0,
    );
    expect(degenerate.mu).toBeCloseTo(1e-4, 12);
  });
});

describe('nestedStrokeInk', () => {
  it('tone 0 draws nothing on a 64 × 64 grid', () => {
    for (const { u, along } of grid64(0.05)) {
      expect(nestedStrokeInk(u, along, 0, 0.02, 0.02)).toBe(0);
    }
  });

  it('every value at tone 1 lies in [0, 1]', () => {
    for (const { u, along } of grid64(0.05)) {
      const ink = nestedStrokeInk(u, along, 1, 0.02, 0.02);
      expect(ink, `nestedStrokeInk(${u}, ${along}, 1, 0.02, 0.02) in [0, 1]`).toBeGreaterThanOrEqual(0);
      expect(ink, `nestedStrokeInk(${u}, ${along}, 1, 0.02, 0.02) in [0, 1]`).toBeLessThanOrEqual(1);
    }
  });

  it('density grows with tone', () => {
    const pts = grid64(0.05);
    const tones = [0, 0.2, 0.5, 0.8, 1];
    const means = tones.map((t) => mean(pts, (u, a) => nestedStrokeInk(u, a, t, 0.02, 0.02)));
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
        const a = nestedStrokeInk(u, along, 1, mLo, mLo);
        const b = nestedStrokeInk(u, along, 1, mHi, mHi);
        expect(
          Math.abs(a - b),
          `no pop at (${u}, ${along}) j=${j}: ${a} vs ${b}`,
        ).toBeLessThan(0.05);
      }
    }
  });

  it('depth-independent density', () => {
    const ms = [0.01, 0.02, 0.05];
    const means = ms.map((m) => mean(grid64(m), (u, a) => nestedStrokeInk(u, a, 1, m, m)));
    const avg = (means[0] + means[1] + means[2]) / 3;
    for (let i = 0; i < ms.length; i++) {
      expect(means[i], `mean at m=${ms[i]} within ±35 % of ${avg}`).toBeGreaterThanOrEqual(avg * 0.65);
      expect(means[i], `mean at m=${ms[i]} within ±35 % of ${avg}`).toBeLessThanOrEqual(avg * 1.35);
    }
  });
});

describe('skyCoords', () => {
  it('skyCoords([0, 0, −1], 100) → [0, −100]; zenith [0, 0]; east [100, 0]', () => {
    const north = skyCoords([0, 0, -1], 100);
    expect(north[0]).toBeCloseTo(0, 6);
    expect(north[1]).toBeCloseTo(-100, 6);
    const zenith = skyCoords([0, 1, 0], 100);
    expect(zenith[0]).toBeCloseTo(0, 6);
    expect(zenith[1]).toBeCloseTo(0, 6);
    const east = skyCoords([1, 0, 0], 100);
    expect(east[0]).toBeCloseTo(100, 6);
    expect(east[1]).toBeCloseTo(0, 6);
  });
});

describe('wobble', () => {
  it('wobble stability', () => {
    const rng = mulberry32(138);
    for (let n = 0; n < 50; n++) {
      const along = rng() * 200 - 50;
      const ph = rng() * 6.2832;
      const mu = 0.01 + rng() * 0.4;
      expect(wobble(along, ph, mu, 0.05)).toBeCloseTo(wobble(along, ph, mu, 0.1), 9);
    }
  });

  it('wobble fades', () => {
    const rng = mulberry32(1381);
    for (let n = 0; n < 40; n++) {
      const along = rng() * 200 - 50;
      const ph = rng() * 6.2832;
      const mu = 0.01 + rng() * 0.4;
      expect(wobble(along, ph, mu, 5)).toBe(0);
      expect(wobble(along, ph, mu, 1.2)).toBeCloseTo(
        mu * 0.3 * Math.sin((2 * Math.PI * along) / 14 + 3 * ph),
        6,
      );
    }
  });
});

describe('lifted', () => {
  it('lifted', () => {
    const rng = mulberry32(1382);
    for (let n = 0; n < 200; n++) {
      const key = rng() * 200;
      const along = rng() * 1000;
      expect(lifted(key, along, 10)).toBe(false);
    }
    const key = 8;
    let nLift = 0;
    const n = 1000;
    for (let along = 0; along < n; along++) {
      if (lifted(key, along, 0.05)) nLift++;
    }
    const frac = nLift / n;
    expect(frac, `lifted fraction ${frac}`).toBeGreaterThan(0.05);
    expect(frac, `lifted fraction ${frac}`).toBeLessThan(0.25);
  });
});

describe('hairInk', () => {
  it('hairInk([x, y], 0) → 0 on a 64 × 64 grid at 1-cell steps', () => {
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        expect(hairInk([x, y], 0)).toBe(0);
      }
    }
  });

  it('every value at density 1 lies in [0, 1]', () => {
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        const ink = hairInk([x, y], 1);
        expect(ink, `hairInk([${x}, ${y}], 1) in [0, 1]`).toBeGreaterThanOrEqual(0);
        expect(ink, `hairInk([${x}, ${y}], 1) in [0, 1]`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('grid mean is strictly increasing across densities [0, 0.45, 0.75, 1]', () => {
    const densities = [0, 0.45, 0.75, 1];
    const pts: { u: number; along: number }[] = [];
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) pts.push({ u: x, along: y });
    }
    const means = densities.map((d) => mean(pts, (x, y) => hairInk([x, y], d)));
    for (let i = 1; i < means.length; i++) {
      expect(means[i], `mean at density ${densities[i]} > ${densities[i - 1]}`).toBeGreaterThan(
        means[i - 1],
      );
    }
    expect(means[2], `mean at density 0.75 is ${means[2]}`).toBeGreaterThan(0.05);
    expect(means[2], `mean at density 0.75 is ${means[2]}`).toBeLessThan(0.3);
  });

  it('hair points up', () => {
    const rng = mulberry32(1383);
    let n = 0;
    while (n < 200) {
      const x = (rng() - 0.5) * 400;
      const y = (rng() - 0.5) * 400;
      const mag = Math.hypot(x, y);
      if (mag <= 20) continue;
      const c: [number, number] = [Math.floor(x / 8), Math.floor(y / 8)];
      const dir = hairDir(c, 0);
      const nx = -x / mag;
      const ny = -y / mag;
      const d = dir[0] * nx + dir[1] * ny;
      expect(d, `dot at ps=[${x}, ${y}] dir=[${dir[0]}, ${dir[1]}]`).toBeGreaterThan(0.8);
      n++;
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
