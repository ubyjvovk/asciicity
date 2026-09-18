/**
 * Unit tests for the pure parts of the `scribble` render style that
 * stayed in `scribble.ts` after T-0139 extracted the stroke machinery
 * into `strokes.ts` (docs/architecture.md §4.11): the view-space-normal
 * surface class, sky-hair density, and the neutral vs coloured ink/wash
 * colours. The shared-machinery tests (hash, viewPos/viewNormal,
 * depthFade, stroke coordinates/scale/LOD, wobble/lifts, sky coordinates,
 * hair) live in `tests/styles/strokes.test.ts`.
 * Runs in node; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  INK,
  PAPER,
  inkColour,
  skyDensity,
  surfaceClass,
  washColour,
} from '../../src/render/styles/scribble';
import { UP_K } from '../../src/render/styles/strokes';

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
