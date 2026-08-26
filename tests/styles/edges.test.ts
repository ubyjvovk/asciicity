/**
 * Unit tests for `edges` pure helpers (docs/architecture.md §4.11). The
 * shader mirrors `isEdge` term for term, so these cases are its spec.
 */
import { describe, expect, it } from 'vitest';
import { EDGE_COLOUR, FLOOR_GAIN, SKY_FRACTION, STYLES, isEdge } from '../../src/render/styles/edges';

describe('isEdge', () => {
  it('flat neighbourhood — isEdge(100, [100,100,100,100], 2000) is false', () => {
    expect(isEdge(100, [100, 100, 100, 100], 2000)).toBe(false);
  });

  it('a 3 % step on one side is an edge', () => {
    expect(isEdge(100, [100, 100, 100, 103], 2000)).toBe(true);
  });

  it('a 1 % step is not an edge', () => {
    expect(isEdge(100, [100, 100, 100, 101], 2000)).toBe(false);
  });

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

  it('k is respected: k = 0.05 makes the 3 % step false', () => {
    expect(isEdge(100, [100, 100, 100, 103], 2000, 0.05)).toBe(false);
  });

  it('takes the smaller of the pair for the tolerance', () => {
    // dC = 100, dN = 50 → threshold = 0.02·min(100, 50) = 1. |100 − 50| = 50 > 1.
    expect(isEdge(100, [50, 100, 100, 100], 2000)).toBe(true);
  });

  it('non-sky neighbour with sky centre triggers on any pair, order-independent', () => {
    const far = 1000;
    const s = far; // exactly at far, cSky true
    expect(isEdge(s, [100, s, s, s], far)).toBe(true);
    expect(isEdge(s, [s, 100, s, s], far)).toBe(true);
    expect(isEdge(s, [s, s, 100, s], far)).toBe(true);
    expect(isEdge(s, [s, s, s, 100], far)).toBe(true);
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

  it('fragment defines main() and reads linearDepth', () => {
    const src = STYLES[0].fragment;
    expect(src).toMatch(/void\s+main\s*\(\s*\)/);
    expect(src).toContain('linearDepth');
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
