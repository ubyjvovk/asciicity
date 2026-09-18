/**
 * Unit tests for the pure parts of the `watercolor` render style
 * (docs/architecture.md §4.11, wave 18 "sketch family", "watercolor",
 * v2 formula): the transparent pigment, the wash density / mix strength,
 * and the full surface wash colour.
 * Granulation (`blotchA` / `bloomA` / `vnoiseA`) lives in the shared
 * `strokes.ts` chunk — its tests live in `tests/styles/strokes.test.ts`.
 * Runs in node; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  GREY_WASH,
  PAPER_W,
  pigmentOf,
  watercolorWash,
  washDensity,
  washStrength,
} from '../../src/render/styles/watercolor';

describe('pigmentOf', () => {
  it('formula at 3 points: mix(1, tint, 0.8·satF) per channel', () => {
    // Point 1: satF 0 — grey things are pure white pigment.
    const grey = pigmentOf([0.4, 0.4, 0.4], 0);
    expect(grey[0]).toBeCloseTo(1, 6);
    expect(grey[1]).toBeCloseTo(1, 6);
    expect(grey[2]).toBeCloseTo(1, 6);
    // Point 2: saturated red at full satF — f = 0.8:
    // r = 1 − 0.8·(1 − 1) = 1, g = 1 − 0.8·0.8 = 0.36, b = 0.36.
    const red = pigmentOf([1, 0.2, 0.2], 1);
    expect(red[0]).toBeCloseTo(1, 6);
    expect(red[1]).toBeCloseTo(0.36, 6);
    expect(red[2]).toBeCloseTo(0.36, 6);
    // Point 3: half saturation — f = 0.4: r = 1 − 0.4·(1−0.9),
    // g = b = 1 − 0.4·(1−0.5).
    const half = pigmentOf([0.9, 0.5, 0.5], 0.5);
    expect(half[0]).toBeCloseTo(1 - 0.4 * (1 - 0.9), 6);
    expect(half[1]).toBeCloseTo(1 - 0.4 * (1 - 0.5), 6);
    expect(half[2]).toBeCloseTo(1 - 0.4 * (1 - 0.5), 6);
  });

  it('a saturated red tint gives r > g, r > b where colour applies', () => {
    for (const satF of [0.25, 0.5, 1]) {
      const c = pigmentOf([1, 0.2, 0.2], satF);
      expect(c[0]).toBeGreaterThan(c[1]);
      expect(c[0]).toBeGreaterThan(c[2]);
    }
  });
});

describe('washDensity', () => {
  it('paper at tone 0: the density floor is 0.25 and mixF ≤ 0.325 at most', () => {
    // dens(0) = 0.25 (the floor), so the mix factor at tone 0 is
    // 0.25·gran·(0.35 + 0.65·satF) — its maximum (gran 1.3, satF 1)
    // is 0.25·1.3·1.0 = 0.325: even the lightest wash barely leaves
    // the paper.
    expect(washDensity(0)).toBeCloseTo(0.25, 6);
    expect(washStrength(0, 1, 1.3)).toBeCloseTo(0.25 * 1.3 * 1.0, 6);
    expect(washStrength(0, 0, 1)).toBeCloseTo(0.25 * 0.35, 6);
    // A tone-0 grey wash sits within 0.02 of bare paper in every
    // channel (the grey term is 0 at tone 0).
    const col = watercolorWash([0.5, 0.5, 0.5], 0, 0, 1);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(col[i] - PAPER_W[i])).toBeLessThan(0.02);
    }
  });

  it('monotone in tone: more shade, more pigment', () => {
    for (const satF of [0, 0.3, 1]) {
      const a = washDensity(0.2);
      const b = washDensity(0.5);
      const c = washDensity(0.9);
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
      expect(washStrength(0.2, satF, 1)).toBeLessThan(washStrength(0.5, satF, 1));
      expect(washStrength(0.5, satF, 1)).toBeLessThan(washStrength(0.9, satF, 1));
    }
  });

  it('formula at 3 points: 0.25 + 0.55·tone^0.6', () => {
    expect(washDensity(1)).toBeCloseTo(0.80, 6);
    expect(washDensity(0.5)).toBeCloseTo(0.25 + 0.55 * Math.pow(0.5, 0.6), 6);
    expect(washDensity(0.25)).toBeCloseTo(0.25 + 0.55 * Math.pow(0.25, 0.6), 6);
  });

  it('never a full-strength wash: dens ≤ 0.8 and mixF capped at 0.9', () => {
    for (const tone of [0, 0.25, 0.5, 0.9, 1]) {
      expect(washDensity(tone)).toBeLessThanOrEqual(0.8 + 1e-12);
    }
    // dens(1) = 0.8, gran 1.3, satF 1 → 0.8·1.3 = 1.04 → clamped 0.9.
    expect(washStrength(1, 1, 1.3)).toBeCloseTo(0.9, 6);
  });
});

describe('watercolorWash', () => {
  it('paper at tone 0: a tone-0 wash barely leaves the paper', () => {
    // Saturated red at gran 1: mixF = 0.25·1·(0.35 + 0.65) = 0.25 →
    // r = 0.99 + (1 − 0.99)·0.25 (pig r is 1),
    // g = 0.98 + (0.36 − 0.98)·0.25, b same pattern; no grey term
    // (1 − satF = 0).
    const red = watercolorWash([1, 0.2, 0.2], 1, 0, 1);
    expect(red[0]).toBeCloseTo(0.99 + (1 - 0.99) * 0.25, 6);
    expect(red[1]).toBeCloseTo(0.98 + (0.36 - 0.98) * 0.25, 6);
    expect(red[2]).toBeCloseTo(0.95 + (0.36 - 0.95) * 0.25, 6);
    // Grey at tone 0: mixF = 0.25·0.35 = 0.0875 into white, and the
    // grey wash factor (1−satF)·tone2·0.5·gran is 0.
    const grey = watercolorWash([0.5, 0.5, 0.5], 0, 0, 1);
    for (let i = 0; i < 3; i++) {
      expect(grey[i]).toBeCloseTo(PAPER_W[i] + (1 - PAPER_W[i]) * 0.0875, 6);
    }
  });

  it('monotone in tone: more shade, more pigment (a red cell darkens toward its hue)', () => {
    for (const satF of [0, 0.3, 1]) {
      const a = watercolorWash([1, 0.2, 0.2], satF, 0.2, 1);
      const b = watercolorWash([1, 0.2, 0.2], satF, 0.5, 1);
      const c = watercolorWash([1, 0.2, 0.2], satF, 0.9, 1);
      // The green channel (the farthest from the red hue) must fall.
      expect(a[1]).toBeGreaterThan(b[1]);
      expect(b[1]).toBeGreaterThan(c[1]);
    }
  });

  it('a saturated red tint gives r > g, r > b where colour applies', () => {
    for (const [satF, tone2] of [
      [1, 0.2],
      [1, 1],
      [0.6, 0.8],
    ] as const) {
      const c = watercolorWash([1, 0.2, 0.2], satF, tone2, 1);
      expect(c[0]).toBeGreaterThan(c[1]);
      expect(c[0]).toBeGreaterThan(c[2]);
    }
  });

  it('grey things mix toward GREY_WASH by (1 − satF)·tone2·0.5·gran', () => {
    // tone2 = 1, satF = 0, gran 1: dens(1) = 0.8, mixF = 0.8·1·0.35
    // = 0.28 (pigment is white), then the grey mix by 1·1·0.5·1 = 0.5.
    const c = watercolorWash([0.5, 0.5, 0.5], 0, 1, 1);
    const f = washDensity(1) * 0.35;
    for (let i = 0; i < 3; i++) {
      const before = PAPER_W[i] + (1 - PAPER_W[i]) * f;
      expect(c[i]).toBeCloseTo(before + (GREY_WASH[i] - before) * 0.5, 6);
    }
    // Half-saturated: the grey factor halves ((1 − 0.5)·1·0.5·1 = 0.25).
    const c2 = watercolorWash([0.5, 0.5, 0.5], 0.5, 1, 1);
    const f2 = washDensity(1) * 1 * (0.35 + 0.65 * 0.5);
    const pig2 = (a: number, b: number) => a + (b - a) * 0.4; // f = 0.8·0.5
    for (let i = 0; i < 3; i++) {
      const before = PAPER_W[i] + (pig2(1, 0.5) - PAPER_W[i]) * f2;
      expect(c2[i]).toBeCloseTo(before + (GREY_WASH[i] - before) * 0.25, 6);
    }
  });
});
