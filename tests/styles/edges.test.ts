/**
 * Unit tests for `edges` pure helpers (docs/architecture.md §4.11). The
 * shader mirrors `isEdge` term for term, so these cases are its spec. The
 * rule (revised 2026-08-27) is the **second difference of inverse depth**:
 * neighbours `[dL, dR, dU, dD]`, `w = 1/d`, edge when
 * `|wL + wR − 2·wC| > k·wC` or `|wU + wD − 2·wC| > k·wC`, `k = 0.02`, over
 * non-sky samples; the centre/neighbour sky disagreement rule is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { EDGE_COLOUR, EDGE_K, FLOOR_GAIN, SKY_FRACTION, STYLES, isEdge } from '../../src/render/styles/edges';

describe('isEdge — inverse-depth second difference', () => {
  it('a plane — inverse depths linear along each axis — is not an edge at k = 0.02', () => {
    // wC = 1/20 = 0.05; wL = wU = 0.046, wR = wD = 0.054, all exactly linear.
    const dC = 20;
    const dL = 1 / (1 / 20 - 0.004);
    const dR = 1 / (1 / 20 + 0.004);
    const dU = dL;
    const dD = dR;
    expect(isEdge(dC, [dL, dR, dU, dD], 2000)).toBe(false);
  });

  it('a wall in front of ground (dC = 20, dR = 40, others 20) is an edge', () => {
    // wC = 0.05, wR = 0.025 → |0.05 + 0.025 − 0.1| = 0.025 > 0.02·0.05 = 0.001.
    expect(isEdge(20, [20, 40, 20, 20], 2000)).toBe(true);
  });

  it('a crease (left pair linear slope 0.004, right pair flat) is an edge', () => {
    // wC = wR = 0.05, wL = 0.046 → |0.046 + 0.05 − 0.1| = 0.004 > 0.001.
    // U/D stay linear so they contribute no bend themselves.
    const dL = 1 / (1 / 20 - 0.004);
    const dU = 1 / (1 / 20 + 0.004);
    const dD = 1 / (1 / 20 - 0.004);
    expect(isEdge(20, [dL, 20, dU, dD], 2000)).toBe(true);
  });

  it('k = 1 makes the crease false', () => {
    const dL = 1 / (1 / 20 - 0.004);
    const dU = 1 / (1 / 20 + 0.004);
    const dD = 1 / (1 / 20 - 0.004);
    expect(isEdge(20, [dL, 20, dU, dD], 2000, 1)).toBe(false);
  });

  it('a single 3 % step on one side is an edge (a bend in inverse depth)', () => {
    // wW (100 → 103): |0.01 + 0.0097087 − 0.02| ≈ 0.000291 > 0.02·0.01 = 0.0002.
    expect(isEdge(100, [100, 100, 100, 103], 2000)).toBe(true);
  });

  it('a 1 % step on one side is not an edge', () => {
    // |0.01 + 1/101 − 0.02| ≈ 0.000099 < 0.0002.
    expect(isEdge(100, [100, 100, 100, 101], 2000)).toBe(false);
  });

  it('k is respected: k = 0.05 makes the 3 % step false', () => {
    expect(isEdge(100, [100, 100, 100, 103], 2000, 0.05)).toBe(false);
  });
});

describe('isEdge — sky rule (unchanged)', () => {
  it('centre sky (≥ 0.98·far) with a non-sky neighbour is an edge', () => {
    const far = 2000;
    const centreSky = 0.98 * far;
    expect(isEdge(centreSky, [100, 100, 100, 100], far)).toBe(true);
  });

  it('all sky is not an edge', () => {
    const far = 2000;
    const s = 0.99 * far;
    expect(isEdge(s, [s, s, s, s], far)).toBe(false);
  });

  it('non-sky neighbour with sky centre triggers on any pair, order-independent', () => {
    const far = 1000;
    const s = far; // exactly at far, cSky true
    expect(isEdge(s, [100, s, s, s], far)).toBe(true);
    expect(isEdge(s, [s, 100, s, s], far)).toBe(true);
    expect(isEdge(s, [s, s, 100, s], far)).toBe(true);
    expect(isEdge(s, [s, s, s, 100], far)).toBe(true);
  });

  it('edge survives a lone bend even when the other cardinal is a flat plane', () => {
    // Horizontal flat, vertical has a bend — only the vertical should fire.
    const dC = 100;
    const flat = 100;
    // wU = 0.01, wD = 1/103 → bend ~0.000291 > 0.0002.
    expect(isEdge(dC, [flat, flat, flat, 103], 2000)).toBe(true);
  });
});

describe('constants', () => {
  it('EDGE_COLOUR is the ticket-specified green', () => {
    expect(EDGE_COLOUR).toEqual([0.25, 1.0, 0.6]);
  });

  it('FLOOR_GAIN is 0.12', () => {
    expect(FLOOR_GAIN).toBeCloseTo(0.12, 6);
  });

  it('SKY_FRACTION is 0.98', () => {
    expect(SKY_FRACTION).toBeCloseTo(0.98, 6);
  });

  it('EDGE_K is the §4.11 threshold k = 0.02', () => {
    expect(EDGE_K).toBeCloseTo(0.02, 6);
  });
});

describe('STYLES', () => {
  it('has exactly one entry with id `edges`', () => {
    expect(STYLES).toHaveLength(1);
    expect(STYLES[0].id).toBe('edges');
    expect(STYLES[0].label).toBe('EDGES');
  });

  it('reports cell 2×2, sub 1×1, needsDepth true (§4.11)', () => {
    const s = STYLES[0];
    expect(s.cellW).toBe(2);
    expect(s.cellH).toBe(2);
    expect(s.subX).toBe(1);
    expect(s.subY).toBe(1);
    expect(s.needsDepth).toBe(true);
  });

  it('fragment defines main(), reads linearDepth and the inverse-depth rule', () => {
    const src = STYLES[0].fragment;
    expect(src).toMatch(/void\s+main\s*\(\s*\)/);
    expect(src).toContain('linearDepth');
    expect(src).toContain('abs(wL + wR - 2.0 * wC)');
    expect(src).toContain('abs(wU + wD - 2.0 * wC)');
  });

  it('makeUniforms returns an empty record (no atlas needed)', () => {
    const u = STYLES[0].makeUniforms({
      cols: 1,
      rows: 1,
      makeCanvas: () => ({}) as HTMLCanvasElement,
    });
    expect(Object.keys(u)).toHaveLength(0);
  });
});
