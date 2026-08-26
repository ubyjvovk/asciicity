/**
 * Unit tests for the pure Bayer 8×8 dither / Game Boy helpers
 * (docs/architecture.md §4.11). No WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  BAYER8,
  bayer8,
  ditherOn,
  gameboyLevel,
  GAMEBOY_PALETTE,
  STYLES,
} from '../../src/render/styles/dither';

/** Spec matrix from architecture.md §4.11. */
const SPEC_BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

describe('BAYER8', () => {
  it('equals the §4.11 matrix and bayer8(x, y) ∈ (0, 1) with 64 distinct values', () => {
    expect(BAYER8).toEqual(SPEC_BAYER8);
    const values = new Set<number>();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const t = bayer8(x, y);
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThan(1);
        expect(t).toBeCloseTo((SPEC_BAYER8[y][x] + 0.5) / 64, 10);
        values.add(t);
      }
    }
    expect(values.size).toBe(64);
  });
});

describe('bayer8', () => {
  it('wraps for x, y ≥ 8', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const base = bayer8(x, y);
        expect(bayer8(x + 8, y)).toBe(base);
        expect(bayer8(x, y + 8)).toBe(base);
        expect(bayer8(x + 16, y + 24)).toBe(base);
        expect(bayer8(x + 8 * 5, y + 8 * 3)).toBe(base);
      }
    }
  });
});

describe('ditherOn', () => {
  it('ditherOn(0, …) is false everywhere and ditherOn(1, …) true everywhere', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(ditherOn(0, x, y)).toBe(false);
        expect(ditherOn(1, x, y)).toBe(true);
      }
    }
  });

  it('over the 64 cells the on-count for v = 0.5 is 32 ± 1', () => {
    let on = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (ditherOn(0.5, x, y)) on++;
      }
    }
    expect(Math.abs(on - 32)).toBeLessThanOrEqual(1);
  });
});

describe('gameboyLevel', () => {
  it('is 0 for v = 0, 3 for v = 1, monotone in v, and the average level over the 64 cells for v = 0.5 is within 0.2 of 1.5', () => {
    let sumHalf = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(gameboyLevel(0, x, y)).toBe(0);
        expect(gameboyLevel(1, x, y)).toBe(3);

        let prev = gameboyLevel(0, x, y);
        for (let i = 1; i <= 100; i++) {
          const cur = gameboyLevel(i / 100, x, y);
          expect(cur).toBeGreaterThanOrEqual(prev);
          prev = cur;
        }

        sumHalf += gameboyLevel(0.5, x, y);
      }
    }
    expect(sumHalf / 64).toBeCloseTo(1.5, 0);
    expect(Math.abs(sumHalf / 64 - 1.5)).toBeLessThanOrEqual(0.2);
  });
});

describe('STYLES', () => {
  it('exports dither then gameboy', () => {
    expect(STYLES.map((s) => s.id)).toEqual(['dither', 'gameboy']);
    expect(STYLES[0].label).toBe('DITHER');
    expect(STYLES[1].label).toBe('GAMEBOY');
    for (const s of STYLES) {
      expect(s.cellW).toBe(2);
      expect(s.cellH).toBe(2);
      expect(s.subX).toBe(1);
      expect(s.subY).toBe(1);
      expect(s.needsDepth).toBe(false);
      expect(s.fragment).toMatch(/void\s+main\s*\(\s*\)/);
    }
  });
});

describe('GAMEBOY_PALETTE', () => {
  it('has the 4 §4.11 colours', () => {
    expect(GAMEBOY_PALETTE).toHaveLength(4);
    const hex = GAMEBOY_PALETTE.map(([r, g, b]) => {
      const c = (v: number) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, '0');
      return `#${c(r)}${c(g)}${c(b)}`;
    });
    expect(hex).toEqual(['#0f380f', '#306230', '#8bac0f', '#9bbc0f']);
  });
});
