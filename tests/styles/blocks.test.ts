/**
 * Unit tests for the pure parts of the blocks render style (docs/architecture.md
 * §4.11 "blocks"; docs/styles/blocks.md). Runs in node — no WebGL, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { quadrantBits, splitMeans } from '../../src/render/styles/blocks';

describe('quadrantBits', () => {
  it('quadrantBits([0,0,1,1]) sets bits 2|3 — the top row on', () => {
    // lums[2] (top-left) and lums[3] (top-right) > mean 0.5.
    expect(quadrantBits([0, 0, 1, 1])).toBe(0b1100);
  });

  it('quadrantBits([1,0,0,0]) sets bit 0 only — the bottom-left quadrant is brightest', () => {
    expect(quadrantBits([1, 0, 0, 0])).toBe(0b0001);
  });

  it('all-equal lums → all on (bits 0..3 = 15)', () => {
    expect(quadrantBits([0.5, 0.5, 0.5, 0.5])).toBe(15);
    expect(quadrantBits([0, 0, 0, 0])).toBe(15);
    expect(quadrantBits([1, 1, 1, 1])).toBe(15);
  });

  it('a single lums above the mean lights exactly its bit', () => {
    // mean of [0.5, 0.25, 0.75, 0.5] = 0.5 → only top-left (0.75) exceeds 0.5 + 1e-4.
    expect(quadrantBits([0.5, 0.25, 0.75, 0.5])).toBe(0b0100);
  });
});

describe('splitMeans', () => {
  it('returns fg = mean of the on quadrants colours and bg = mean of the off ones', () => {
    const colours: [number, number, number][] = [
      [0.2, 0, 0], // bottom-left  (off)
      [0, 0, 0], // bottom-right (off)
      [0.8, 0, 0], // top-left     (on)
      [0.4, 0, 0], // top-right    (on)
    ];
    const { fg, bg } = splitMeans(colours, 0b1100, 1);
    // gamma = 1 → tintOf(mean)·shaped(bright(mean)) = mean for single-hue colours.
    expect(fg[0]).toBeCloseTo((0.8 + 0.4) / 2);
    expect(fg[1]).toBeCloseTo(0);
    expect(fg[2]).toBeCloseTo(0);
    expect(bg[0]).toBeCloseTo((0.2 + 0) / 2);
    expect(bg[1]).toBeCloseTo(0);
    expect(bg[2]).toBeCloseTo(0);
  });

  it('bg is black when all four quadrants are on', () => {
    const colours: [number, number, number][] = [
      [0.6, 0, 1],
      [0, 1, 0.2],
      [1, 0.5, 0],
      [0.3, 0.7, 0.9],
    ];
    const { bg } = splitMeans(colours, 0b1111, 0.45);
    expect(bg).toEqual([0, 0, 0]);
  });

  it('fg is black when no quadrant is on', () => {
    const colours: [number, number, number][] = [
      [0.1, 0.1, 0.1],
      [0.1, 0.1, 0.1],
      [0.1, 0.1, 0.1],
      [0.1, 0.1, 0.1],
    ];
    const { fg, bg } = splitMeans(colours, 0, 1);
    expect(fg).toEqual([0, 0, 0]);
    // mean of all four greys, rendered with gamma = 1 → the grey itself.
    expect(bg[0]).toBeCloseTo(0.1);
  });

  it('applies the tint·density rule (gamma < 1 boosts mids)', () => {
    const colours: [number, number, number][] = [
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    // Only bottom-left on → fg mean = [1,0,0]; shaped(1) = 1 regardless of γ.
    const { fg } = splitMeans(colours, 0b0001, 0.45);
    expect(fg[0]).toBeCloseTo(1);
    expect(fg[1]).toBeCloseTo(0);
  });
});
