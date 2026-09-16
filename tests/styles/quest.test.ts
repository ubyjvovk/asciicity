/**
 * Unit tests for the pure parts of the `quest` render style
 * (docs/architecture.md §4.11, wave 16, T-0124): the 12×20 ramp table,
 * `bayer8` matrix, `rampFor` ramp selection, `shadeIndex` one-step dither,
 * `questSky` painted sky, and `questVignette`. Runs in node; no WebGL is
 * touched.
 */
import { describe, expect, it } from 'vitest';
import {
  QUEST_RAMP_ENDS,
  QUEST_RAMPS,
  bayer8,
  isNearSide,
  questSky,
  questVignette,
  rampFor,
  shadeIndex,
} from '../../src/render/styles/quest';

/** Brightness (max channel) of a normalised RGB tuple. */
function bright(c: readonly [number, number, number]): number {
  return Math.max(c[0], c[1], c[2]);
}

/** Parse `RRGGBB` into a normalised `[r, g, b]` in `[0, 1]`. */
function hex(rrggbb: string): readonly [number, number, number] {
  const n = parseInt(rrggbb, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

describe('QUEST_RAMPS', () => {
  it('is 12 x 20; shade 0 == dark and shade 19 == light for every ramp', () => {
    expect(QUEST_RAMPS.length).toBe(12);
    for (let r = 0; r < 12; r++) {
      expect(QUEST_RAMPS[r].length, `ramp ${r} has 20 shades`).toBe(20);
      const { dark, light } = QUEST_RAMP_ENDS[r];
      const drgb = hex(dark);
      const lrgb = hex(light);
      const d = QUEST_RAMPS[r][0];
      expect(d[0], `ramp ${r} shade 0 r`).toBeCloseTo(drgb[0], 6);
      expect(d[1], `ramp ${r} shade 0 g`).toBeCloseTo(drgb[1], 6);
      expect(d[2], `ramp ${r} shade 0 b`).toBeCloseTo(drgb[2], 6);
      const l = QUEST_RAMPS[r][19];
      expect(l[0], `ramp ${r} shade 19 r`).toBeCloseTo(lrgb[0], 6);
      expect(l[1], `ramp ${r} shade 19 g`).toBeCloseTo(lrgb[1], 6);
      expect(l[2], `ramp ${r} shade 19 b`).toBeCloseTo(lrgb[2], 6);
    }
  });

  it('every ramp is monotone non-decreasing in brightness (max channel)', () => {
    for (let r = 0; r < 12; r++) {
      for (let i = 1; i < 20; i++) {
        expect(
          bright(QUEST_RAMPS[r][i]),
          `ramp ${r} shade ${i} not ≥ shade ${i - 1}`,
        ).toBeGreaterThanOrEqual(bright(QUEST_RAMPS[r][i - 1]));
      }
    }
  });
});

describe('bayer8', () => {
  it('yields 64 distinct values in (0, 1)', () => {
    const seen = new Set<number>();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const v = bayer8(x, y);
        expect(v, `bayer8(${x}, ${y})`).toBeGreaterThan(0);
        expect(v, `bayer8(${x}, ${y})`).toBeLessThan(1);
        seen.add(v);
      }
    }
    expect(seen.size).toBe(64);
  });
});

describe('rampFor', () => {
  it('stone (0) for near-grey tints', () => {
    expect(rampFor([1, 1, 1])).toBe(0);
    expect(rampFor([0.9, 0.9, 1])).toBe(0);
  });

  it('sky-blue → 8 (sky), crimson → 10 (crimson), green → 6 (grass)', () => {
    expect(rampFor([0.2, 0.4, 1])).toBe(8);
    expect(rampFor([1, 0.3, 0.3])).toBe(10);
    expect(rampFor([0.5, 1, 0.4])).toBe(6);
  });
});

describe('shadeIndex', () => {
  it('six flat shades, no dither: 0→2, 0.17→5, 0.5→12, 0.99→19, 1→19', () => {
    expect(shadeIndex(0)).toBe(2);
    expect(shadeIndex(0.17)).toBe(5);
    expect(shadeIndex(0.5)).toBe(12);
    expect(shadeIndex(0.99)).toBe(19);
    expect(shadeIndex(1)).toBe(19);
  });
});

describe('isNearSide', () => {
  it('one-sided outline gate: inks only the nearer side (or neighbour sky)', () => {
    expect(isNearSide(10, 12, 1960)).toBe(true); // neighbour farther → centre near
    expect(isNearSide(12, 10, 1960)).toBe(false); // centre farther → not inked
    expect(isNearSide(10, 1965, 1960)).toBe(true); // neighbour sky, centre not
    expect(isNearSide(1965, 10, 1960)).toBe(false); // centre sky → not inked
  });
});

describe('questSky', () => {
  it('day: sky ramp 8, banded {17,14,11,8} from horizon to zenith', () => {
    // smoothstep(0.35,0.95,·): y01=0→s=0→band0→17; y01=0.5→s=0.156→still band0→17;
    // y01=1→s=1→band3→8. (Computed per the §4.11 formula; the ticket's
    // "{8,14} or {8,11}" guess does not match the smoothstep result.)
    expect(questSky(1, 0)).toEqual({ ramp: 8, index: 17 });
    expect(questSky(1, 0.5)).toEqual({ ramp: 8, index: 17 });
    expect(questSky(1, 1)).toEqual({ ramp: 8, index: 8 });
  });

  it('dusk: violet ramp 11, banded {15,12,9,6}', () => {
    expect(questSky(0.5, 0)).toEqual({ ramp: 11, index: 15 });
    expect(questSky(0.5, 1)).toEqual({ ramp: 11, index: 6 });
  });

  it('night: ramp 9, banded {9,7,5,3}; zenith 3 at y01=1', () => {
    expect(questSky(0, 0)).toEqual({ ramp: 9, index: 9 });
    expect(questSky(0, 1)).toEqual({ ramp: 9, index: 3 });
  });
});

describe('questVignette', () => {
  it('centre is 1, corner is 0.85 (vignette 0.15)', () => {
    expect(questVignette([0.5, 0.5])).toBe(1);
    expect(questVignette([0, 0])).toBeCloseTo(0.85, 3);
  });
});
