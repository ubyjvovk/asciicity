/**
 * Unit tests for the pure parts of the `crayon` render style
 * (docs/architecture.md §4.11, wave 18 "sketch family", "crayon"): the
 * coloured-pencil stroke colour and the paper wash strength. The shared
 * stroke machinery (pencil widths, wobble, lifts, sky hair) is the
 * `strokes.ts` chunk — its tests live in `tests/styles/strokes.test.ts`.
 * Runs in node; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  G,
  PAPER_P,
  crayonStroke,
  crayonWash,
} from '../../src/render/styles/crayon';

describe('crayonStroke', () => {
  it('formula at 3 points: mix(G, tint·0.60, 0.85·satF) per channel', () => {
    // Point 1: satF 0 — grey things are pure graphite.
    const grey = crayonStroke([0.8, 0.8, 0.8], 0);
    expect(grey[0]).toBeCloseTo(G[0], 6);
    expect(grey[1]).toBeCloseTo(G[1], 6);
    expect(grey[2]).toBeCloseTo(G[2], 6);
    // Point 2: saturated red at full satF —
    // r = 0.22 + (0.60 − 0.22)·0.85, g = 0.22 + (0.12 − 0.22)·0.85,
    // b = 0.25 + (0.12 − 0.25)·0.85.
    const red = crayonStroke([1, 0.2, 0.2], 1);
    expect(red[0]).toBeCloseTo(0.543, 6);
    expect(red[1]).toBeCloseTo(0.135, 6);
    expect(red[2]).toBeCloseTo(0.1395, 6);
    // Point 3: half saturation — f = 0.85·0.5 = 0.425.
    const half = crayonStroke([0.9, 0.5, 0.5], 0.5);
    expect(half[0]).toBeCloseTo(0.22 + (0.54 - 0.22) * 0.425, 6);
    expect(half[1]).toBeCloseTo(0.22 + (0.30 - 0.22) * 0.425, 6);
    expect(half[2]).toBeCloseTo(0.25 + (0.30 - 0.25) * 0.425, 6);
  });

  it('a saturated red tint gives r > g, r > b where colour applies', () => {
    for (const satF of [0.1, 0.5, 1]) {
      const c = crayonStroke([1, 0.2, 0.2], satF);
      expect(c[0]).toBeGreaterThan(c[1]);
      expect(c[0]).toBeGreaterThan(c[2]);
    }
  });
});

describe('crayonWash', () => {
  it('paper at tone 0: the wash is 0 so the base is bare PAPER_P', () => {
    expect(crayonWash(0, 0)).toBeCloseTo(0, 6);
    expect(crayonWash(0, 1)).toBeCloseTo(0, 6);
    // tone 0 → mix(PAPER_P, ·, 0) is PAPER_P in every channel.
    const t = 0;
    const satF = 1;
    const w = crayonWash(t, satF);
    expect(PAPER_P[0] + (G[0] - PAPER_P[0]) * w).toBeCloseTo(PAPER_P[0], 6);
  });

  it('monotone in tone: more shade, more pigment', () => {
    for (const satF of [0, 0.3, 1]) {
      const a = crayonWash(0.2, satF);
      const b = crayonWash(0.5, satF);
      const c = crayonWash(0.9, satF);
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
    }
  });

  it('formula at 3 points: 0.45·satF·tone^0.7 + 0.20·(1−satF)·tone', () => {
    expect(crayonWash(1, 1)).toBeCloseTo(0.45, 6);
    expect(crayonWash(1, 0)).toBeCloseTo(0.2, 6);
    expect(crayonWash(0.5, 1)).toBeCloseTo(0.45 * Math.pow(0.5, 0.7), 6);
  });
});
