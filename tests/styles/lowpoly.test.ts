/**
 * Unit tests for the pure parts of the `lowpoly` render style
 * (docs/architecture.md §4.11, wave 15): `LOWPOLY_HUES` order, `posterLevel`
 * band thresholds, `snapHue` chroma/hue snapping, and `lowpolyColour`
 * (whole non-edge path from an exposed RGB sample). Runs in node; no WebGL
 * is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  LOWPOLY_HUES,
  LOWPOLY_INK,
  LOWPOLY_LUM,
  lowpolyColour,
  posterLevel,
  snapHue,
} from '../../src/render/styles/lowpoly';

const HEX_ORDER: readonly string[] = [
  'FF3030', 'FF7A20', 'FFE040', '70E040',
  '30E0E0', '3060FF', '9040FF', 'FF40C0',
];

/** Deterministic PRNG so case 9's "grid of random inputs" is reproducible. */
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

describe('LOWPOLY_HUES', () => {
  it('has 8 entries matching the §4.11 hex list in order', () => {
    expect(LOWPOLY_HUES.length).toBe(8);
    for (let i = 0; i < 8; i++) {
      const n = parseInt(HEX_ORDER[i], 16);
      const r = ((n >> 16) & 0xff) / 255;
      const g = ((n >> 8) & 0xff) / 255;
      const b = (n & 0xff) / 255;
      const [hr, hg, hb] = LOWPOLY_HUES[i];
      expect(hr, `entry ${i} r`).toBeCloseTo(r, 6);
      expect(hg, `entry ${i} g`).toBeCloseTo(g, 6);
      expect(hb, `entry ${i} b`).toBeCloseTo(b, 6);
    }
  });
});

describe('posterLevel', () => {
  it('0 → 0, 0.249 → 0, 0.25 → 1, 0.5 → 2, 0.75 → 3, 1 → 3', () => {
    expect(posterLevel(0)).toBe(0);
    expect(posterLevel(0.249)).toBe(0);
    expect(posterLevel(0.25)).toBe(1);
    expect(posterLevel(0.5)).toBe(2);
    expect(posterLevel(0.75)).toBe(3);
    expect(posterLevel(1)).toBe(3);
  });
});

describe('snapHue', () => {
  it('of each hue returns its own index', () => {
    for (let i = 0; i < LOWPOLY_HUES.length; i++) {
      const [r, g, b] = LOWPOLY_HUES[i];
      expect(snapHue([r, g, b]), `hue ${i}`).toBe(i);
    }
  });

  it('snapHue([1, 1, 1]) and snapHue([1, 0.9, 0.85]) return -1 (grey)', () => {
    expect(snapHue([1, 1, 1])).toBe(-1);
    expect(snapHue([1, 0.9, 0.85])).toBe(-1);
  });

  it('snapHue([1, 0.2, 0.2]) → 0 (red), snapHue([0.2, 0.2, 1]) → 5 (blue)', () => {
    expect(snapHue([1, 0.2, 0.2])).toBe(0);
    expect(snapHue([0.2, 0.2, 1])).toBe(5);
  });
});

describe('lowpolyColour', () => {
  it('lowpolyColour([0, 0, 0], 0.45) → every channel ≤ 0.22', () => {
    const [r, g, b] = lowpolyColour([0, 0, 0], 0.45);
    expect(r).toBeLessThanOrEqual(LOWPOLY_LUM[0]);
    expect(g).toBeLessThanOrEqual(LOWPOLY_LUM[0]);
    expect(b).toBeLessThanOrEqual(LOWPOLY_LUM[0]);
  });

  it('lowpolyColour([1, 1, 1], 0.45) → [1, 1, 1] (grey, top band)', () => {
    const [r, g, b] = lowpolyColour([1, 1, 1], 0.45);
    expect(r).toBeCloseTo(1, 10);
    expect(g).toBeCloseTo(1, 10);
    expect(b).toBeCloseTo(1, 10);
  });

  it('lowpolyColour([1, 0.1, 0.1], 0.45) → LOWPOLY_HUES[0] · LOWPOLY_LUM[3]', () => {
    const [r, g, b] = lowpolyColour([1, 0.1, 0.1], 0.45);
    const [hr, hg, hb] = LOWPOLY_HUES[0];
    expect(r).toBeCloseTo(hr * LOWPOLY_LUM[3], 10);
    expect(g).toBeCloseTo(hg * LOWPOLY_LUM[3], 10);
    expect(b).toBeCloseTo(hb * LOWPOLY_LUM[3], 10);
  });

  it('output is always one of the 4 × 9 (hue or grey × band) combinations on a random grid', () => {
    const gamma = 0.45;
    const rand = mulberry32(0x10f25);
    for (let i = 0; i < 256; i++) {
      const exposed: [number, number, number] = [
        rand() * 1.7 - 0.2,
        rand() * 1.7 - 0.2,
        rand() * 1.7 - 0.2,
      ];
      const out = lowpolyColour(exposed, gamma);
      const c = exposed.map((e) => Math.min(1, Math.max(0, e)));
      const bright = Math.max(c[0], c[1], c[2]);
      const lum = LOWPOLY_LUM[posterLevel(bright ** gamma)];
      // out / lum must be one of the 8 hues or [1, 1, 1] — the whole vector,
      // never a per-channel mix.
      const candidates: readonly (readonly [number, number, number])[] = [...LOWPOLY_HUES, [1, 1, 1] as const];
      const whole = candidates.some(
        (h) =>
          Math.abs(out[0] - h[0] * lum) < 1e-10 &&
          Math.abs(out[1] - h[1] * lum) < 1e-10 &&
          Math.abs(out[2] - h[2] * lum) < 1e-10,
      );
      expect(whole, `input ${JSON.stringify(exposed)}`).toBe(true);
    }
  });
});

describe('LOWPOLY constants', () => {
  it('LOWPOLY_LUM is the §4.11 ramp and LOWPOLY_INK is near-black', () => {
    expect(LOWPOLY_LUM).toEqual([0.22, 0.5, 0.78, 1]);
    for (const c of LOWPOLY_INK) {
      expect(c).toBeLessThanOrEqual(0.05);
    }
  });
});
