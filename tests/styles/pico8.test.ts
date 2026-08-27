/**
 * Unit tests for the pure parts of the PICO-8 render style
 * (docs/architecture.md §4.11): `PICO8_PALETTE` order, `bayer4` matrix
 * values, and `nearestPico8` squared-RGB lookup. Runs in node; no WebGL
 * is touched.
 */
import { describe, expect, it } from 'vitest';
import { PICO8_PALETTE, bayer4, nearestPico8 } from '../../src/render/styles/pico8';

const HEX_ORDER: readonly string[] = [
  '000000', '1D2B53', '7E2553', '008751', 'AB5236', '5F574F', 'C2C3C7', 'FFF1E8',
  'FF004D', 'FFA300', 'FFEC27', '00E436', '29ADFF', '83769C', 'FF77A8', 'FFCCAA',
];

describe('PICO8_PALETTE', () => {
  it('has the 16 §4.11 colours in order', () => {
    expect(PICO8_PALETTE.length).toBe(16);
    for (let i = 0; i < 16; i++) {
      const n = parseInt(HEX_ORDER[i], 16);
      const r = ((n >> 16) & 0xff) / 255;
      const g = ((n >> 8) & 0xff) / 255;
      const b = (n & 0xff) / 255;
      const [pr, pg, pb] = PICO8_PALETTE[i];
      expect(pr, `entry ${i} r`).toBeCloseTo(r, 6);
      expect(pg, `entry ${i} g`).toBeCloseTo(g, 6);
      expect(pb, `entry ${i} b`).toBeCloseTo(b, 6);
    }
  });
});

describe('nearestPico8', () => {
  it('of each palette colour returns its own index', () => {
    for (let i = 0; i < PICO8_PALETTE.length; i++) {
      const [r, g, b] = PICO8_PALETTE[i];
      expect(nearestPico8([r, g, b]), `entry ${i}`).toBe(i);
    }
  });

  it('black → 0, white → 7 (#FFF1E8), pure green → 11 (#00E436)', () => {
    expect(nearestPico8([0, 0, 0])).toBe(0);
    expect(nearestPico8([1, 1, 1])).toBe(7);
    expect(nearestPico8([0, 1, 0])).toBe(11);
  });
});

describe('bayer4', () => {
  it('has 16 distinct values in (0, 1)', () => {
    const seen = new Set<number>();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const v = bayer4(x, y);
        expect(v, `bayer4(${x}, ${y})`).toBeGreaterThan(0);
        expect(v, `bayer4(${x}, ${y})`).toBeLessThan(1);
        seen.add(v);
      }
    }
    expect(seen.size).toBe(16);
  });
});
