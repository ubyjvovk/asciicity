/**
 * Unit tests for the pure parts of the hatch render style (docs/architecture.md
 * §4.11 "hatch"): `hatchLevel` (density index for a cell brightness) and
 * `hatchSpacing` (the "/" and "\" diagonal spacings per atlas level). Runs in
 * node; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import { hatchLevel, hatchSpacing } from '../../src/render/styles/hatch';

describe('hatchLevel', () => {
  it('hatchLevel(1) → 0', () => {
    expect(hatchLevel(1)).toBe(0);
  });

  it('hatchLevel(0) → 7', () => {
    expect(hatchLevel(0)).toBe(7);
  });

  it('monotone decreasing in v', () => {
    let prev = hatchLevel(0);
    for (let i = 1; i <= 100; i++) {
      const v = i / 100;
      const cur = hatchLevel(v);
      expect(cur, `hatchLevel(${v})`).toBeLessThanOrEqual(prev);
      prev = cur;
    }
  });

  it('clamps values outside [0, 1]', () => {
    expect(hatchLevel(-1)).toBe(7);
    expect(hatchLevel(-1e6)).toBe(7);
    expect(hatchLevel(2)).toBe(0);
    expect(hatchLevel(1e6)).toBe(0);
  });

  it('every output is an integer in [0, 7]', () => {
    for (let i = 0; i <= 100; i++) {
      const level = hatchLevel(i / 100);
      expect(Number.isInteger(level)).toBe(true);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(7);
    }
  });
});

describe('hatchSpacing', () => {
  it('hatchSpacing returns { fwd: null, back: null } for 0', () => {
    expect(hatchSpacing(0)).toEqual({ fwd: null, back: null });
  });

  it('hatchSpacing returns { fwd: 16, back: null } for 1', () => {
    expect(hatchSpacing(1)).toEqual({ fwd: 16, back: null });
  });

  it('hatchSpacing returns { fwd: 4, back: null } for 4', () => {
    expect(hatchSpacing(4)).toEqual({ fwd: 4, back: null });
  });

  it('hatchSpacing returns { fwd: 4, back: 12 } for 5', () => {
    expect(hatchSpacing(5)).toEqual({ fwd: 4, back: 12 });
  });

  it('hatchSpacing returns { fwd: 4, back: 4 } for 7', () => {
    expect(hatchSpacing(7)).toEqual({ fwd: 4, back: 4 });
  });

  it('fwd spacings for levels 1..4 walk 16, 12, 8, 4', () => {
    expect(hatchSpacing(2)).toEqual({ fwd: 12, back: null });
    expect(hatchSpacing(3)).toEqual({ fwd: 8, back: null });
  });

  it('back spacings for levels 5..7 walk 12, 8, 4 while fwd stays at 4', () => {
    expect(hatchSpacing(6)).toEqual({ fwd: 4, back: 8 });
  });
});
