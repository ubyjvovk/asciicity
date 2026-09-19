/**
 * Unit tests for the `retrocgi` pure helpers (docs/architecture.md §4.11
 * "`retrocgi` (wave 19)"). The shader mirrors them term for term, so these
 * cases are its spec: the phosphor-green line display is `RETRO_BG` plus
 * `RETRO_LINE · I`, where `I = (e0 ? 1 : HALO_GAIN · halo) · fade · flick`;
 * a cell is an edge on depth (`isEdge`, imported) OR on a shoreline where
 * the centre's water state differs from a neighbour's (skipped in sky).
 */
import { describe, expect, it } from 'vitest';
import {
  FADE_FAR,
  FADE_MIN,
  FADE_NEAR,
  FLICKER,
  HALO_GAIN,
  RETRO_BG,
  RETRO_LINE,
  SHORE_UP,
  STYLES,
  isWaterColour,
  retroColour,
  retroEdge,
  retroFade,
  retroIntensity,
} from '../../src/render/styles/retrocgi';

const WATER_HEX: readonly [number, number, number] = [22 / 255, 58 / 255, 107 / 255];

describe('isWaterColour', () => {
  it('WATER_HEX 0x163a6b as floats is water', () => {
    expect(isWaterColour(WATER_HEX)).toBe(true);
  });

  it('the same colour × 0.3 (night) and × 1.7 (exposed) is still water', () => {
    expect(isWaterColour([WATER_HEX[0] * 0.3, WATER_HEX[1] * 0.3, WATER_HEX[2] * 0.3])).toBe(true);
    expect(isWaterColour([WATER_HEX[0] * 1.7, WATER_HEX[1] * 1.7, WATER_HEX[2] * 1.7])).toBe(true);
  });

  it('grey, green, black and pale blue-grey are not water', () => {
    expect(isWaterColour([0.5, 0.5, 0.5])).toBe(false);
    expect(isWaterColour([0.1, 0.6, 0.2])).toBe(false);
    expect(isWaterColour([0, 0, 0])).toBe(false);
    expect(isWaterColour([0.5, 0.55, 0.6])).toBe(false);
  });
});

describe('retroEdge', () => {
  const grey: readonly [number, number, number] = [0.5, 0.5, 0.5];

  it('a flat plane (five equal depths, five equal greys) is not an edge', () => {
    expect(retroEdge([100, 100, 100, 100, 100], [grey, grey, grey, grey, grey], 2000)).toBe(false);
  });

  it('a depth step (C 50, R 80, others 50) is an edge', () => {
    expect(retroEdge([50, 50, 80, 50, 50], [grey, grey, grey, grey, grey], 2000)).toBe(true);
  });

  it('equal depths with centre land and left neighbour water is an edge (shoreline)', () => {
    const land: readonly [number, number, number] = [0.5, 0.5, 0.5];
    expect(retroEdge([100, 100, 100, 100, 100], [land, WATER_HEX, land, land, land], 2000)).toBe(true);
  });

  it('all five samples sky with one water sample is not an edge (shoreline skipped in sky)', () => {
    const far = 2000;
    expect(retroEdge([far, far, far, far, far], [WATER_HEX, WATER_HEX, grey, grey, grey], far)).toBe(false);
  });

  it('centre sky with one neighbour at 100 m is an edge (skyline)', () => {
    const far = 2000;
    const s = far;
    expect(retroEdge([s, 100, s, s, s], [grey, grey, grey, grey, grey], far)).toBe(true);
  });
});

describe('retroFade', () => {
  it('≤ FADE_NEAR is 1, ≥ FADE_FAR is FADE_MIN, and 525 m is 0.675', () => {
    expect(retroFade(FADE_NEAR)).toBeCloseTo(1, 6);
    expect(retroFade(FADE_FAR)).toBeCloseTo(FADE_MIN, 6);
    // t = (525-150)/(900-150) = 0.5 → smoothstep 0.5 → 1 + (0.35-1)·0.5 = 0.675.
    expect(retroFade(525)).toBeCloseTo(0.675, 6);
  });

  it('is monotone non-increasing over 0…1200 in steps of 50', () => {
    let prev = retroFade(0);
    for (let d = 50; d <= 1200; d += 50) {
      const v = retroFade(d);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });
});

describe('retroIntensity', () => {
  it('a line cell is full intensity; halo cells scale by HALO_GAIN · count/4', () => {
    expect(retroIntensity(true, 0, 100, 1)).toBeCloseTo(1, 6);
    expect(retroIntensity(false, 4, 100, 1)).toBeCloseTo(HALO_GAIN, 6); // 0.30
    expect(retroIntensity(false, 2, 100, 1)).toBeCloseTo(HALO_GAIN / 2, 6); // 0.15
    expect(retroIntensity(false, 0, 100, 1)).toBeCloseTo(0, 6);
  });

  it('the halo never adds to a line cell', () => {
    expect(retroIntensity(true, 4, 100, 1)).toBeCloseTo(1, 6);
  });
});

describe('retroColour', () => {
  it('i = 0 is exactly RETRO_BG', () => {
    expect(retroColour(0)).toEqual([...RETRO_BG]);
  });

  it('i = 1 is RETRO_LINE on RETRO_BG, clamped to ≤ 1', () => {
    const [r, g, b] = retroColour(1);
    expect(r).toBeCloseTo(Math.min(1, RETRO_BG[0] + RETRO_LINE[0]), 6);
    expect(g).toBeCloseTo(Math.min(1, RETRO_BG[1] + RETRO_LINE[1]), 6); // 1.0
    expect(b).toBeCloseTo(Math.min(1, RETRO_BG[2] + RETRO_LINE[2]), 6); // 0.47
    expect(r).toBeLessThanOrEqual(1);
    expect(g).toBeLessThanOrEqual(1);
    expect(b).toBeLessThanOrEqual(1);
  });

  it('every channel stays within [0, 1] for i in 0…1.5', () => {
    for (let i = 0; i <= 1.5; i += 0.1) {
      const [r, g, b] = retroColour(i);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
  });
});

describe('constants', () => {
  it('RETRO_LINE is the §4.11 phosphor green (0.30, 1.00, 0.45)', () => {
    expect(RETRO_LINE).toEqual([0.3, 1.0, 0.45]);
  });

  it('RETRO_BG is the never-black tube glow (0.00, 0.02, 0.00)', () => {
    expect(RETRO_BG).toEqual([0.0, 0.02, 0.0]);
  });

  it('fade/flicker constants match §4.11', () => {
    expect(HALO_GAIN).toBeCloseTo(0.3, 6);
    expect(FADE_NEAR).toBeCloseTo(150, 6);
    expect(FADE_FAR).toBeCloseTo(900, 6);
    expect(FADE_MIN).toBeCloseTo(0.35, 6);
    expect(FLICKER).toBeCloseTo(0.04, 6);
  });
});

describe('STYLES', () => {
  it('has exactly one entry with id `retrocgi`', () => {
    expect(STYLES).toHaveLength(1);
    expect(STYLES[0].id).toBe('retrocgi');
    expect(STYLES[0].label).toBe('RETRO CGI');
  });

  it('reports cell 2×2, sub 1×1, needsDepth true, groundGrid false, cap 960×540 (§4.11)', () => {
    const s = STYLES[0];
    expect(s.cellW).toBe(2);
    expect(s.cellH).toBe(2);
    expect(s.subX).toBe(1);
    expect(s.subY).toBe(1);
    expect(s.needsDepth).toBe(true);
    expect(s.groundGrid).toBe(false);
    expect(s.targetCap).toEqual({ w: 960, h: 540 });
  });

  it('fragment defines main(), edgeAt(), the shoreline term, and the five halo calls', () => {
    const src = STYLES[0].fragment;
    expect(src).toMatch(/void\s+main\s*\(\s*\)/);
    expect(src).toContain('bool edgeAt(vec2 uv)');
    expect(src).toContain('isWater');
    expect(src).toContain('edgeAt(centreUv + vec2(-2.0 * stepUv.x, 0.0))');
    expect(src).toContain('RETRO_BG + RETRO_LINE * I');
  });

  it('makeUniforms returns an empty record (no atlas needed)', () => {
    const u = STYLES[0].makeUniforms({
      cols: 1,
      rows: 1,
      daylight: 1,
      makeCanvas: () => ({}) as HTMLCanvasElement,
    });
    expect(Object.keys(u)).toHaveLength(0);
  });

  it('11. retroEdge: shoreline is gated to horizontal surfaces (PM tune)', () => {
    const land: [number, number, number] = [0.4, 0.4, 0.4];
    const water: [number, number, number] = [22 / 255, 58 / 255, 107 / 255];
    const depths = [50, 50, 50, 50, 50];
    const colours = [land, water, land, land, land];
    expect(retroEdge(depths, colours, 2000, 1)).toBe(true);
    expect(retroEdge(depths, colours, 2000, SHORE_UP + 0.01)).toBe(true);
    expect(retroEdge(depths, colours, 2000, SHORE_UP)).toBe(false);
    expect(retroEdge(depths, colours, 2000, 0)).toBe(false); // a wall
  });
});
