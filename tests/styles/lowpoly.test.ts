/**
 * Unit tests for the pure parts of the `lowpoly` render style
 * (docs/architecture.md §4.11, wave 15): `LOWPOLY_HUES` order, `posterLevel`
 * band thresholds, `snapHue` chroma/hue snapping, and `lowpolyColour`
 * (whole non-edge path from an exposed RGB sample). Runs in node; no WebGL
 * is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  LOWPOLY_GREY,
  LOWPOLY_HUES,
  LOWPOLY_INK,
  LOWPOLY_LUM,
  LOWPOLY_PASTEL,
  LOWPOLY_SHINE,
  LOWPOLY_SKY,
  lowpolyColour,
  lowpolyPaletteSet,
  posterLevel,
  skyBand,
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

/** `a + (b − a)·t` — GLSL `mix`, per channel, on `[0, 1]` triples. */
function mixc(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
  it('lowpolyColour([0, 0, 0], 0.45) → every channel ≤ LOWPOLY_LUM[0]', () => {
    const [r, g, b] = lowpolyColour([0, 0, 0], 0.45);
    expect(r).toBeLessThanOrEqual(LOWPOLY_LUM[0]);
    expect(g).toBeLessThanOrEqual(LOWPOLY_LUM[0]);
    expect(b).toBeLessThanOrEqual(LOWPOLY_LUM[0]);
  });

  it('lowpolyColour([1, 1, 1], 0.45) → chrome grey mixed toward white (shine, v = 1)', () => {
    // v = 1 ≥ 0.92 so the top-band grey is the shine variant.
    const [r, g, b] = lowpolyColour([1, 1, 1], 0.45);
    const exp = LOWPOLY_GREY.map((v) => mixc(v, 1, LOWPOLY_SHINE));
    expect(r).toBeCloseTo(exp[0], 10);
    expect(g).toBeCloseTo(exp[1], 10);
    expect(b).toBeCloseTo(exp[2], 10);
  });

  it('lowpolyColour([1, 0.1, 0.1], 0.45) → pastel red × band-3 then shine', () => {
    const [r, g, b] = lowpolyColour([1, 0.1, 0.1], 0.45);
    const pastel = LOWPOLY_HUES[0].map((h) => mixc(h, 1, LOWPOLY_PASTEL));
    const exp = pastel.map((v) => mixc(v * LOWPOLY_LUM[3], 1, LOWPOLY_SHINE));
    expect(r).toBeCloseTo(exp[0], 10);
    expect(g).toBeCloseTo(exp[1], 10);
    expect(b).toBeCloseTo(exp[2], 10);
  });

  it('ADD lowpolyColour([0.5, 0.5, 0.5], 0.45) → grey branch: LOWPOLY_GREY · LOWPOLY_LUM[posterLevel(0.5^0.45)]', () => {
    const [r, g, b] = lowpolyColour([0.5, 0.5, 0.5], 0.45);
    const lum = LOWPOLY_LUM[posterLevel(0.5 ** 0.45)];
    expect(r).toBeCloseTo(LOWPOLY_GREY[0] * lum, 10);
    expect(g).toBeCloseTo(LOWPOLY_GREY[1] * lum, 10);
    expect(b).toBeCloseTo(LOWPOLY_GREY[2] * lum, 10);
  });

  it('ADD lowpolyColour([1, 0.1, 0.1], 0.45) → each channel equals mix(mix(HUES[0], 1, 0.12)·1.0, 1, 0.75)', () => {
    const [r, g, b] = lowpolyColour([1, 0.1, 0.1], 0.45);
    const exp = LOWPOLY_HUES[0].map((h) =>
      mixc(mixc(h, 1, LOWPOLY_PASTEL) * LOWPOLY_LUM[3], 1, LOWPOLY_SHINE),
    );
    expect(r).toBeCloseTo(exp[0], 10);
    expect(g).toBeCloseTo(exp[1], 10);
    expect(b).toBeCloseTo(exp[2], 10);
  });

  it('ADD lowpolyColour([0.8, 0.08, 0.08], 0.45) (v ≈ 0.905 < 0.92) → NO shine: mix(HUES[0], 1, 0.12)·LOWPOLY_LUM[3]', () => {
    const [r, g, b] = lowpolyColour([0.8, 0.08, 0.08], 0.45);
    const exp = LOWPOLY_HUES[0].map((h) => mixc(h, 1, LOWPOLY_PASTEL) * LOWPOLY_LUM[3]);
    expect(r).toBeCloseTo(exp[0], 10);
    expect(g).toBeCloseTo(exp[1], 10);
    expect(b).toBeCloseTo(exp[2], 10);
  });

  it('output is always one of the §4.11 v2 palette set on a random grid', () => {
    const gamma = 0.45;
    const rand = mulberry32(0x10f25);
    const palette = lowpolyPaletteSet();
    for (let i = 0; i < 256; i++) {
      const exposed: [number, number, number] = [
        rand() * 1.7 - 0.2,
        rand() * 1.7 - 0.2,
        rand() * 1.7 - 0.2,
      ];
      const out = lowpolyColour(exposed, gamma);
      const whole = palette.some(
        (h) =>
          Math.abs(out[0] - h[0]) < 1e-10 &&
          Math.abs(out[1] - h[1]) < 1e-10 &&
          Math.abs(out[2] - h[2]) < 1e-10,
      );
      expect(whole, `input ${JSON.stringify(exposed)}`).toBe(true);
    }
  });
});

describe('LOWPOLY constants', () => {
  it('LOWPOLY_LUM is the §4.11 v2 ramp and LOWPOLY_INK is near-black', () => {
    expect(LOWPOLY_LUM).toEqual([0.45, 0.65, 0.85, 1]);
    for (const c of LOWPOLY_INK) {
      expect(c).toBeLessThanOrEqual(0.05);
    }
  });

  it('LOWPOLY_SHINE / LOWPOLY_PASTEL / LOWPOLY_GREY are the §4.11 v2 values', () => {
    expect(LOWPOLY_SHINE).toBe(0.75);
    expect(LOWPOLY_PASTEL).toBe(0.12);
    expect(LOWPOLY_GREY[0]).toBeCloseTo(0.88, 10);
    expect(LOWPOLY_GREY[1]).toBeCloseTo(0.92, 10);
    expect(LOWPOLY_GREY[2]).toBeCloseTo(0.97, 10);
  });
});

describe('LOWPOLY_SKY', () => {
  it('has the three §4.11 v2 sky colours in order (#1A2060 #FF6FA8 #4FA8FF)', () => {
    const hexes = ['1A2060', 'FF6FA8', '4FA8FF'];
    expect(LOWPOLY_SKY.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      const n = parseInt(hexes[i], 16);
      const r = ((n >> 16) & 0xff) / 255;
      const g = ((n >> 8) & 0xff) / 255;
      const b = (n & 0xff) / 255;
      const [sr, sg, sb] = LOWPOLY_SKY[i];
      expect(sr, `entry ${i} r`).toBeCloseTo(r, 6);
      expect(sg, `entry ${i} g`).toBeCloseTo(g, 6);
      expect(sb, `entry ${i} b`).toBeCloseTo(b, 6);
    }
  });
});

describe('skyBand', () => {
  it('0 → 0, 0.32 → 0, 0.33 → 1, 0.5 → 1, 0.65 → 1, 0.66 → 2, 1 → 2', () => {
    expect(skyBand(0)).toBe(0);
    expect(skyBand(0.32)).toBe(0);
    expect(skyBand(0.33)).toBe(1);
    expect(skyBand(0.5)).toBe(1);
    expect(skyBand(0.65)).toBe(1);
    expect(skyBand(0.66)).toBe(2);
    expect(skyBand(1)).toBe(2);
  });
});
