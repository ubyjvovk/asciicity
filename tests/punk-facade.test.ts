/**
 * Cyberpunk facade decisions (`src/render/punk/facademath.ts`).
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Facades".
 */
import { describe, it, expect } from 'vitest';
import {
  BLINDS_SHARE,
  DARK_BUILDING_SHARE,
  INTENSITY_MIN,
  INTENSITY_RANGE,
  SHOPFRONT_HEIGHT_M,
  TINT_SHARES,
  WINDOW_CELL_M,
  WINDOW_TINTS,
  buildingSeed,
  detailFade,
  inShopLitSpan,
  isDarkBuilding,
  shopEmissive,
  shopfrontKind,
  shutterAlbedo,
  windowLight,
  FACADE_PATTERNS,
  GLASS_LIT_MAX,
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_GLASS,
  MAT_METAL,
  MAT_NONE,
  MAT_PLASTER,
  MAT_STONE,
  MAT_WOOD,
  facadePattern,
  nightAlbedo,
  nightRoofAlbedo,
  windowLitP,
} from '../src/render/punk/facademath';
import { MATERIAL_CODE } from '../src/world/buildings';

/** Deterministic [0, 1) PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('cyberpunk facades', () => {
  it('lit fraction of windowLight over 200 buildings × 400 cells with cellV ≥ 2 is within [0.08, 0.14]', () => {
    const rng = mulberry32(0xfacade);
    let lit = 0;
    let n = 0;
    for (let b = 0; b < 200; b++) {
      const seed = buildingSeed(rng(), rng(), rng());
      for (let i = 0; i < 400; i++) {
        const cellU = b * 17 + (i % 40);
        const cellV = 2 + Math.floor(i / 40);
        if (windowLight(cellU, cellV, seed).lit) lit++;
        n++;
      }
    }
    const frac = lit / n;
    expect(frac).toBeGreaterThanOrEqual(0.08);
    expect(frac).toBeLessThanOrEqual(0.14);
  });

  it("share of isDarkBuilding over 10 000 seeds within [0.22, 0.28], and a dark building's lit fraction ≤ 0.03", () => {
    const rng = mulberry32(0xda12);
    let darkN = 0;
    const seeds: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const seed = buildingSeed(rng(), rng(), rng());
      seeds.push(seed);
      if (isDarkBuilding(seed)) darkN++;
    }
    const share = darkN / seeds.length;
    expect(share).toBeGreaterThanOrEqual(0.22);
    expect(share).toBeLessThanOrEqual(0.28);
    expect(share).toBeCloseTo(DARK_BUILDING_SHARE, 1);

    const darkSeed = seeds.find((s) => isDarkBuilding(s));
    expect(darkSeed).toBeDefined();
    let lit = 0;
    const cells = 400;
    for (let i = 0; i < cells; i++) {
      if (windowLight(i, 2 + (i % 20), darkSeed!).lit) lit++;
    }
    expect(lit / cells).toBeLessThanOrEqual(0.03);
  });

  it('tint shares of lit windows within ±0.03 of 0.60 / 0.20 / 0.12 / 0.08', () => {
    const rng = mulberry32(0x71a7);
    const counts = [0, 0, 0, 0];
    let litN = 0;
    for (let b = 0; b < 200; b++) {
      const seed = buildingSeed(rng(), rng(), rng());
      for (let i = 0; i < 400; i++) {
        const w = windowLight(b * 17 + (i % 40), 2 + Math.floor(i / 40), seed);
        if (!w.lit) continue;
        counts[w.tint]++;
        litN++;
      }
    }
    expect(litN).toBeGreaterThan(1000);
    for (let t = 0; t < 4; t++) {
      expect(counts[t] / litN).toBeCloseTo(TINT_SHARES[t], 1);
      expect(Math.abs(counts[t] / litN - TINT_SHARES[t])).toBeLessThanOrEqual(0.03);
    }
    expect(WINDOW_TINTS[0]).toEqual([1.0, 0.62, 0.32]);
    expect(WINDOW_TINTS[1]).toEqual([0.75, 0.85, 1.0]);
    expect(WINDOW_TINTS[2]).toEqual([0.1, 0.85, 1.0]);
    expect(WINDOW_TINTS[3]).toEqual([1.0, 0.12, 0.62]);
  });

  it('intensity always in [0.05, 0.35], median < 0.12 (wave 23b dimmed)', () => {
    const rng = mulberry32(0x1a7e);
    const vals: number[] = [];
    for (let b = 0; b < 200; b++) {
      const seed = buildingSeed(rng(), rng(), rng());
      for (let i = 0; i < 400; i++) {
        const w = windowLight(b * 17 + (i % 40), 2 + Math.floor(i / 40), seed);
        if (!w.lit) continue;
        expect(w.intensity).toBeGreaterThanOrEqual(0.05);
        expect(w.intensity).toBeLessThanOrEqual(0.35);
        expect(w.intensity).toBeGreaterThanOrEqual(INTENSITY_MIN);
        expect(w.intensity).toBeLessThanOrEqual(INTENSITY_MIN + INTENSITY_RANGE);
        vals.push(w.intensity);
      }
    }
    vals.sort((a, b) => a - b);
    const mid = vals[Math.floor(vals.length / 2)];
    expect(mid).toBeLessThan(0.12);
  });

  it('blinds share of lit windows within [0.25, 0.35]', () => {
    const rng = mulberry32(0xb11d);
    let blinds = 0;
    let litN = 0;
    for (let b = 0; b < 200; b++) {
      const seed = buildingSeed(rng(), rng(), rng());
      for (let i = 0; i < 400; i++) {
        const w = windowLight(b * 17 + (i % 40), 2 + Math.floor(i / 40), seed);
        if (!w.lit) continue;
        litN++;
        if (w.blinds) blinds++;
      }
    }
    const share = blinds / litN;
    expect(share).toBeGreaterThanOrEqual(0.25);
    expect(share).toBeLessThanOrEqual(0.35);
    expect(share).toBeCloseTo(BLINDS_SHARE, 1);
  });

  it('no lit window for cells whose bottom is < 4 m above the wall base (cellV·3 < 4)', () => {
    const rng = mulberry32(0x0400);
    for (let b = 0; b < 80; b++) {
      const seed = buildingSeed(rng(), rng(), rng());
      for (let cellU = 0; cellU < 40; cellU++) {
        for (let cellV = 0; cellV < 8; cellV++) {
          const w = windowLight(cellU, cellV, seed);
          if (cellV * WINDOW_CELL_M < SHOPFRONT_HEIGHT_M) {
            expect(w.lit).toBe(false);
          }
        }
      }
    }
  });

  it('shopfrontKind shutter share within [0.70, 0.80]', () => {
    const rng = mulberry32(0x5109);
    let shutter = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      const seed = buildingSeed(rng(), rng(), rng());
      if (shopfrontKind(i % 97, seed) === 'shutter') shutter++;
    }
    const share = shutter / n;
    expect(share).toBeGreaterThanOrEqual(0.7);
    expect(share).toBeLessThanOrEqual(0.8);
  });

  it('shop glass emissive in [0.12, 0.40] (wave 23b), lit only in the middle 3.6 m; shutters 0.02–0.05', () => {
    const rng = mulberry32(0x5e9);
    for (let i = 0; i < 2000; i++) {
      const seed = buildingSeed(rng(), rng(), rng());
      const e = shopEmissive(i, seed);
      expect(e).toBeGreaterThanOrEqual(0.12);
      expect(e).toBeLessThanOrEqual(0.4);
      const a = shutterAlbedo(i, seed);
      expect(a).toBeGreaterThanOrEqual(0.02);
      expect(a).toBeLessThanOrEqual(0.05);
    }
    expect(inShopLitSpan(0.5)).toBe(false);
    expect(inShopLitSpan(1.1)).toBe(false);
    expect(inShopLitSpan(1.2)).toBe(true);
    expect(inShopLitSpan(3)).toBe(true);
    expect(inShopLitSpan(4.79)).toBe(true);
    expect(inShopLitSpan(4.8)).toBe(false);
    expect(inShopLitSpan(6 + 3)).toBe(true);
    expect(inShopLitSpan(-3)).toBe(true);
    let lit = 0;
    for (let x = 0; x < 600; x++) if (inShopLitSpan(x / 100)) lit++;
    expect(lit / 600).toBeCloseTo(0.6, 2);
  });

  it('fine detail fades with distance: 1 at ≤ 15 m, 0 at ≥ 60 m', () => {
    expect(detailFade(0)).toBe(1);
    expect(detailFade(15)).toBe(1);
    expect(detailFade(37.5)).toBeCloseTo(0.5, 6);
    expect(detailFade(60)).toBe(0);
    expect(detailFade(500)).toBe(0);
    for (let d = 15; d < 60; d += 1) expect(detailFade(d + 1)).toBeLessThanOrEqual(detailFade(d));
  });

  it('determinism: same inputs → same outputs', () => {
    const seed = buildingSeed(0.2, 0.4, 0.7);
    expect(buildingSeed(0.2, 0.4, 0.7)).toBe(seed);
    expect(isDarkBuilding(seed)).toBe(isDarkBuilding(seed));
    const a = windowLight(12, 5, seed);
    const b = windowLight(12, 5, seed);
    expect(b).toEqual(a);
    expect(shopfrontKind(3, seed)).toBe(shopfrontKind(3, seed));
    expect(shopEmissive(3, seed)).toBe(shopEmissive(3, seed));
    expect(shutterAlbedo(3, seed)).toBe(shutterAlbedo(3, seed));
  });
});

describe('cyberpunk facades × OSM', () => {
  it('nightAlbedo([1, 0, 0]) = [0.18, 0, 0]; −1 input → null (use procedural)', () => {
    const n = nightAlbedo([1, 0, 0]);
    expect(n).not.toBeNull();
    expect(n?.[0]).toBeCloseTo(0.18, 6);
    expect(n?.[1]).toBeCloseTo(0, 6);
    expect(n?.[2]).toBeCloseTo(0, 6);
    expect(nightAlbedo([-1, -1, -1])).toBeNull();
    expect(nightRoofAlbedo([1, 0.5, 0])?.[1]).toBeCloseTo(0.075, 6);
    expect(nightRoofAlbedo([-1, -1, -1])).toBeNull();
  });

  it('the pattern table has one entry per material code 0–7 with the §4.11 sizes', () => {
    expect(FACADE_PATTERNS).toHaveLength(8);
    // Codes agree with world/buildings.ts MATERIAL_CODE.
    expect(MATERIAL_CODE).toEqual({
      brick: MAT_BRICK,
      stone: MAT_STONE,
      concrete: MAT_CONCRETE,
      glass: MAT_GLASS,
      metal: MAT_METAL,
      wood: MAT_WOOD,
      plaster: MAT_PLASTER,
    });
    expect(facadePattern(MAT_NONE).kind).toBe('panels');
    expect(facadePattern(MAT_CONCRETE).kind).toBe('panels');
    expect(facadePattern(MAT_BRICK).kind).toBe('brick');
    expect(facadePattern(MAT_BRICK).size).toBeCloseTo(0.075, 6);
    expect(facadePattern(MAT_STONE).kind).toBe('ashlar');
    expect(facadePattern(MAT_STONE).size).toBeCloseTo(0.6, 6);
    const glass = facadePattern(MAT_GLASS);
    expect(glass.kind).toBe('curtain');
    expect(glass.size).toBeCloseTo(1.5, 6);
    expect(glass.albedo).toBeCloseTo(0.02, 6);
    expect(glass.roughness).toBeCloseTo(0.05, 6);
    expect(glass.metalness).toBeCloseTo(0.9, 6);
    expect(facadePattern(MAT_METAL).kind).toBe('seams');
    expect(facadePattern(MAT_METAL).size).toBeCloseTo(0.5, 6);
    expect(facadePattern(MAT_METAL).metalness).toBeCloseTo(0.7, 6);
    expect(facadePattern(MAT_WOOD).kind).toBe('boards');
    expect(facadePattern(MAT_WOOD).size).toBeCloseTo(0.2, 6);
    expect(facadePattern(MAT_PLASTER).kind).toBe('smooth');
    expect(facadePattern(99).kind).toBe('panels');
  });

  it('glass lit fraction over 20 000 cells within [0.12, 0.21] and ≤ 0.3 per building', () => {
    const rng = mulberry32(0x61a55);
    let lit = 0;
    let n = 0;
    for (let b = 0; b < 50; b++) {
      const seed = buildingSeed(rng(), rng(), rng());
      expect(windowLitP(seed, MAT_GLASS)).toBeLessThanOrEqual(GLASS_LIT_MAX);
      let litB = 0;
      for (let i = 0; i < 400; i++) {
        const cellU = b * 17 + (i % 40);
        const cellV = 2 + Math.floor(i / 40);
        if (windowLight(cellU, cellV, seed, MAT_GLASS).lit) litB++;
      }
      expect(litB / 400).toBeLessThanOrEqual(0.3);
      lit += litB;
      n += 400;
    }
    expect(n).toBe(20000);
    const frac = lit / n;
    expect(frac).toBeGreaterThanOrEqual(0.12);
    expect(frac).toBeLessThanOrEqual(0.21);
    // Non-glass materials keep the T-0152 probability.
    const seed = buildingSeed(0.3, 0.3, 0.3);
    expect(windowLitP(seed, MAT_BRICK)).toBe(windowLitP(seed));
  });
});
