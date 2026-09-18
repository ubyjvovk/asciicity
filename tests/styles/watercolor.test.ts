/**
 * Unit tests for the pure parts of the `watercolor` render style
 * (docs/architecture.md §4.11, wave 18 "sketch family", "watercolor"): the
 * transparent pigment, the wash density / mix strength, the 2-D value
 * noise and the granulation blotches, and the full surface wash colour.
 * The world-anchored surface machinery (sky test, outline) is the shared
 * `strokes.ts` chunk — its tests live in `tests/styles/strokes.test.ts`.
 * Runs in node; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import { hash2 } from '../../src/render/styles/strokes';
import {
  GREY_WASH,
  PAPER_W,
  blotch,
  pigmentOf,
  vnoise,
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
  it('paper at tone 0: the density floor is 0.35 and the wash mix stays near paper', () => {
    // dens(0) = 0.35 (the floor), so the mix factor at tone 0 is
    // 0.35·gran·(0.3 + 0.7·satF) — for grey things (satF 0) that is
    // 0.105·gran, barely off the paper.
    expect(washDensity(0)).toBeCloseTo(0.35, 6);
    expect(washStrength(0, 0, 1)).toBeCloseTo(0.35 * 0.3, 6);
    // A tone-0 grey wash sits within 0.02 of bare paper in every channel.
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

  it('formula at 3 points: 0.35 + 0.65·tone^0.6', () => {
    expect(washDensity(1)).toBeCloseTo(1.0, 6);
    expect(washDensity(0.5)).toBeCloseTo(0.35 + 0.65 * Math.pow(0.5, 0.6), 6);
    expect(washDensity(0.25)).toBeCloseTo(0.35 + 0.65 * Math.pow(0.25, 0.6), 6);
  });
});

describe('vnoise', () => {
  it('in [0, 1] at 3 points and equal to the hash2 corner at lattice points', () => {
    // On the integer lattice the smoothstep fade is 0/1, so vnoise is
    // exactly the corner hash2 value.
    expect(vnoise(0, 0)).toBeCloseTo(hash2(0, 0), 6);
    expect(vnoise(7, -3)).toBeCloseTo(hash2(7, -3), 6);
    // Bilinear blend of corner values in [0, 1] stays in [0, 1].
    for (const [x, y] of [
      [1.5, 2.5],
      [12.25, 0.75],
      [-2.5, 9.5],
    ] as const) {
      const n = vnoise(x, y);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });
});

describe('blotch', () => {
  it('in [0, 1] at 3 points: 0.5·vnoise(q/6) + 0.5·vnoise(q/17)', () => {
    // Both octaves sit on hash2 corners at the origin, so
    // blotch(0, 0) = the corner value itself (each octave = hash2(0, 0)).
    expect(blotch(0, 0)).toBeCloseTo(hash2(0, 0), 6);
    for (const [x, y] of [
      [6.5, 17.5],
      [31.3, 5.7],
      [1.1, 99.9],
    ] as const) {
      const b = blotch(x, y);
      expect(b).toBeCloseTo(0.5 * vnoise(x / 6, y / 6) + 0.5 * vnoise(x / 17, y / 17), 6);
      // 0.5·v1 + 0.5·v2 with v1, v2 in [0, 1] sits in [0, 1]; the
      // spec's gran = 0.85 + 0.30·blotch sits in [0.85, 1.15].
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
  });
});

describe('watercolorWash', () => {
  it('paper at tone 0: a tone-0 wash barely leaves the paper', () => {
    // Saturated red at gran 1: f = 0.35·1·(0.3 + 0.7) = 0.35 →
    // r = 0.99 + (1 − 0.99)·0.35 = 0.9935 (pig r is 1),
    // g = 0.98 + (0.36 − 0.98)·0.35, b same as g.
    const red = watercolorWash([1, 0.2, 0.2], 1, 0, 1);
    expect(red[0]).toBeCloseTo(0.99 + (1 - 0.99) * 0.35, 6);
    expect(red[1]).toBeCloseTo(0.98 + (0.36 - 0.98) * 0.35, 6);
    expect(red[2]).toBeCloseTo(0.95 + (0.36 - 0.95) * 0.35, 6);
    // Grey at tone 0: f = 0.35·0.3 = 0.105 into white, no grey mix.
    const grey = watercolorWash([0.5, 0.5, 0.5], 0, 0, 1);
    for (let i = 0; i < 3; i++) {
      expect(grey[i]).toBeCloseTo(PAPER_W[i] + (1 - PAPER_W[i]) * 0.105, 6);
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

  it('grey things (satF < 0.5) mix toward GREY_WASH by tone2·0.6', () => {
    // tone2 = 1, satF = 0: dens(1) = 1, f = 1·1·0.3 + 0.25·1 = 0.55
    // (gran 1), then the grey mix by tone2·0.6 = 0.6.
    const c = watercolorWash([0.5, 0.5, 0.5], 0, 1, 1);
    const f = washDensity(1) * 0.3 + 0.25;
    for (let i = 0; i < 3; i++) {
      const before = PAPER_W[i] + (1 - PAPER_W[i]) * f;
      expect(c[i]).toBeCloseTo(before + (GREY_WASH[i] - before) * 0.6, 6);
    }
  });
});
