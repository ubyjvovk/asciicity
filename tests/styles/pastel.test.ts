/**
 * Unit tests for the pure parts of the `pastel` render style
 * (docs/architecture.md §4.11, wave 18 "sketch family"): the pastel
 * chalk (`chalkOf`) and the full surface colour (`pastelColour`) — the
 * 3×3 smoothing lives only in the fragment. The shared stroke machinery
 * and the anchored tooth (`toothOf` / `blotchA`) are unit-tested in
 * `tests/styles/strokes.test.ts`. Runs in node; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import { DARK_CHALK, PAPER_S, chalkOf, pastelColour } from '../../src/render/styles/pastel';

describe('chalkOf', () => {
  it('mix(white, t, 0.65·satF) at three points — white at satF 0, red-lead where colour applies', () => {
    // satF = 0: pure white chalk, whatever the tint.
    const w = chalkOf([1, 0.2, 0.2], 0);
    expect(w[0]).toBeCloseTo(1, 6);
    expect(w[1]).toBeCloseTo(1, 6);
    expect(w[2]).toBeCloseTo(1, 6);
    // satF = 0.5: half way to the red tint (0.65 · 0.5 = 0.325).
    const half = chalkOf([1, 0.2, 0.2], 0.5);
    expect(half[0]).toBeCloseTo(1, 6);
    expect(half[1]).toBeCloseTo(1 - 0.325 * 0.8, 6);
    expect(half[2]).toBeCloseTo(1 - 0.325 * 0.8, 6);
    // satF = 1: fully tinted (0.65 of the way to the red tint).
    const full = chalkOf([1, 0.2, 0.2], 1);
    expect(full[0]).toBeCloseTo(1, 6);
    expect(full[1]).toBeCloseTo(1 - 0.65 * 0.8, 6);
    expect(full[2]).toBeCloseTo(1 - 0.65 * 0.8, 6);
    // A saturated red tint gives r > g, r > b where colour applies.
    expect(full[0]).toBeGreaterThan(full[1]);
    expect(full[0]).toBeGreaterThan(full[2]);
  });
});

describe('pastelColour', () => {
  it('paper at tone 0 (v = 1): no dark chalk, a bright tone near PAPER_S at three teeth', () => {
    for (const g of [0.8, 1.0, 1.2]) {
      const c = pastelColour(1, [1, 1, 1], g);
      // Neutral tint → white chalk, so col = mix(PAPER_S, white, 0.9·g)
      // exactly — the (1−v)·0.55·g dark-chalk term is 0 at v = 1.
      expect(c[0]).toBeCloseTo(PAPER_S[0] + (1 - PAPER_S[0]) * 0.9 * g, 6);
      expect(c[1]).toBeCloseTo(PAPER_S[1] + (1 - PAPER_S[1]) * 0.9 * g, 6);
      expect(c[2]).toBeCloseTo(PAPER_S[2] + (1 - PAPER_S[2]) * 0.9 * g, 6);
      // …and it stays a paper tone: never darker than PAPER_S (only the
      // white chalk lightens it), at most a slight past-white overshoot
      // at the g = 1.2 extreme of the 0.9·g mix.
      for (let i = 0; i < 3; i++) {
        expect(c[i]).toBeGreaterThanOrEqual(PAPER_S[i]);
        expect(c[i]).toBeLessThan(1.02);
      }
    }
  });

  it('monotone in tone at three points (v = 1, 0.5, 0) — darker as tone grows', () => {
    const g = 1.1;
    const cTop = pastelColour(1, [1, 1, 1], g);
    const cMid = pastelColour(0.5, [1, 1, 1], g);
    const cLow = pastelColour(0, [1, 1, 1], g);
    for (let i = 0; i < 3; i++) {
      expect(cMid[i]).toBeLessThan(cTop[i]);
      expect(cLow[i]).toBeLessThan(cMid[i]);
    }
    // Formula at v = 0: mix(base, DARK_CHALK, 0.55·g) with the white-chalk base.
    const t = 0.55 * g;
    const baseR = PAPER_S[0] + (1 - PAPER_S[0]) * 0.9 * g;
    expect(cLow[0]).toBeCloseTo(baseR + (DARK_CHALK[0] - baseR) * t, 6);
  });

  it('saturated red tint gives r > g and r > b where colour applies, at three tones', () => {
    for (const v of [1, 0.5, 0]) {
      const c = pastelColour(v, [1, 0.2, 0.2], 1.0);
      expect(c[0]).toBeGreaterThan(c[1]);
      expect(c[0]).toBeGreaterThan(c[2]);
    }
  });
});
