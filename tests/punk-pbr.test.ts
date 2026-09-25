/**
 * Cyberpunk PBR detail textures (T-0167): the pure mirrors in
 * src/render/punk/facademath.ts and streetmath.ts that the TSL graphs in
 * facade.ts / street.ts / pbr.ts follow (architecture.md §4.11 "PBR detail
 * textures"). Pure node tests — no WebGPU, no image files.
 */
import { describe, it, expect } from 'vitest';
import {
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_GLASS,
  MAT_METAL,
  MAT_NONE,
  MAT_PLASTER,
  MAT_STONE,
  MAT_WOOD,
  PBR_ALBEDO_MAX,
  PBR_ALBEDO_MIN,
  PBR_STONE_TINT,
  PBR_WALL_SETS,
  PBR_WALL_UV_SCALE,
  buildingSeed,
  linearMeanRgb,
  pbrAlbedoMod,
  pbrAntiTile,
  pbrFacadeSet,
  pbrFade,
  pbrWallIndex,
  pbrWallUv,
  srgbByteToLinear,
} from '../src/render/punk/facademath';
import { antiTileUv, horizontalTbn, horizontalUv, rotate2, PBR_ROT_SCALE } from '../src/render/punk/streetmath';

describe('albedo modulation', () => {
  it('albedo modulation clamps to [0.45, 1.8] and is 1 at the texture mean', () => {
    expect(pbrAlbedoMod(0.3, 0.3)).toBeCloseTo(1, 9);
    expect(pbrAlbedoMod(0.12, 0.12)).toBeCloseTo(1, 9);
    expect(pbrAlbedoMod(0, 0.3)).toBeCloseTo(PBR_ALBEDO_MIN, 9);
    expect(pbrAlbedoMod(1, 0.2)).toBeCloseTo(PBR_ALBEDO_MAX, 9);
    expect(pbrAlbedoMod(0.45, 0.3)).toBeCloseTo(1.5, 9);
    for (let t = 0; t <= 1; t += 0.01) {
      const m = pbrAlbedoMod(t, 0.25);
      expect(m).toBeGreaterThanOrEqual(PBR_ALBEDO_MIN - 1e-12);
      expect(m).toBeLessThanOrEqual(PBR_ALBEDO_MAX + 1e-12);
    }
  });

  it('fades the pattern to its mean (1) as the fade goes to 0', () => {
    expect(pbrAlbedoMod(0, 0.3, 0)).toBeCloseTo(1, 9);
    expect(pbrAlbedoMod(1, 0.2, 0.5)).toBeCloseTo(1 + (PBR_ALBEDO_MAX - 1) / 2, 9);
  });

  it('measures the linear mean of sRGB pixels', () => {
    expect(srgbByteToLinear(0)).toBeCloseTo(0, 9);
    expect(srgbByteToLinear(255)).toBeCloseTo(1, 9);
    expect(srgbByteToLinear(188)).toBeCloseTo(0.5029, 3);
    const px = [255, 0, 188, 255, 0, 255, 188, 255];
    const m = linearMeanRgb(px);
    expect(m[0]).toBeCloseTo(0.5, 9);
    expect(m[1]).toBeCloseTo(0.5, 9);
    expect(m[2]).toBeCloseTo(0.5029, 3);
  });
});

describe('distance fade', () => {
  it('distance fade = 1 at ≤ 15 m, 0 at ≥ 60 m, monotone', () => {
    expect(pbrFade(0)).toBeCloseTo(1, 9);
    expect(pbrFade(15)).toBeCloseTo(1, 9);
    expect(pbrFade(60)).toBeCloseTo(0, 9);
    expect(pbrFade(200)).toBeCloseTo(0, 9);
    let prev = pbrFade(0);
    for (let d = 0.5; d <= 80; d += 0.5) {
      const f = pbrFade(d);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      prev = f;
    }
    expect(pbrFade(37.5)).toBeCloseTo(0.5, 9);
  });
});

describe('per-building anti-tiling', () => {
  it('per-building anti-tiling: deterministic, 0/90° swap + offset in [0, 1)', () => {
    let swaps = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const seed = buildingSeed((i * 0.37) % 1, (i * 0.61) % 1, (i * 0.13) % 1);
      const a = pbrAntiTile(seed);
      expect(pbrAntiTile(seed)).toEqual(a);
      expect(a.offsetU).toBeGreaterThanOrEqual(0);
      expect(a.offsetU).toBeLessThan(1);
      expect(a.offsetV).toBeGreaterThanOrEqual(0);
      expect(a.offsetV).toBeLessThan(1);
      if (a.swap) swaps++;
      // The uv: offset always, swap only for isotropic sets.
      const [u0, v0] = pbrWallUv(0.5, 0.25, seed, false);
      expect(u0).toBeCloseTo(0.5 * PBR_WALL_UV_SCALE + a.offsetU, 9);
      expect(v0).toBeCloseTo(0.25 * PBR_WALL_UV_SCALE + a.offsetV, 9);
      const [u1, v1] = pbrWallUv(0.5, 0.25, seed, true);
      expect(u1).toBeCloseTo((a.swap ? 0.25 : 0.5) * PBR_WALL_UV_SCALE + a.offsetU, 9);
      expect(v1).toBeCloseTo((a.swap ? 0.5 : 0.25) * PBR_WALL_UV_SCALE + a.offsetV, 9);
    }
    // Both orientations occur, roughly evenly.
    expect(swaps / n).toBeGreaterThan(0.3);
    expect(swaps / n).toBeLessThan(0.7);
  });

  it('4 m per facade repeat (24 m wall uv × 6)', () => {
    expect(PBR_WALL_UV_SCALE).toBe(6);
  });
});

describe('horizontal TBN', () => {
  it('horizontal TBN: (0.5, 0.5, 1) maps to +y world; (1, 0.5, 0.5) tilts toward +x', () => {
    const up = horizontalTbn([0.5, 0.5, 1]);
    expect(up[0]).toBeCloseTo(0, 9);
    expect(up[1]).toBeCloseTo(1, 9);
    expect(up[2]).toBeCloseTo(0, 9);
    const east = horizontalTbn([1, 0.5, 0.5]);
    expect(east[0]).toBeCloseTo(1, 9);
    expect(east[2]).toBeCloseTo(0, 9);
    const tilted = horizontalTbn([0.75, 0.5, 1], 0.8);
    expect(tilted[0]).toBeGreaterThan(0);
    expect(tilted[1]).toBeGreaterThan(tilted[0]);
    expect(Math.hypot(...tilted)).toBeCloseTo(1, 9);
    // B = −z: a +v texel tilts toward north (−z).
    expect(horizontalTbn([0.5, 1, 0.5])[2]).toBeCloseTo(-1, 9);
  });

  it('world xz → uv with v = −z, and the rotated ×0.43 anti-tiling copy', () => {
    expect(horizontalUv(3, -6, 3)).toEqual([1, 2]);
    const [ru, rv] = antiTileUv(1, 0);
    expect(Math.hypot(ru, rv)).toBeCloseTo(PBR_ROT_SCALE, 9);
    expect((Math.atan2(rv, ru) * 180) / Math.PI).toBeCloseTo(37, 9);
    const [bx, by] = rotate2(...rotate2(0.3, -0.7, 37), -37);
    expect(bx).toBeCloseTo(0.3, 9);
    expect(by).toBeCloseTo(-0.7, 9);
  });
});

describe('OSM material → texture set', () => {
  it('OSM material → texture set mapping (brick/metal/plaster/stone/glass/wood/none)', () => {
    expect(pbrFacadeSet(MAT_BRICK).set).toBe('brick');
    expect(pbrFacadeSet(MAT_METAL).set).toBe('metal');
    expect(pbrFacadeSet(MAT_PLASTER).set).toBe('plaster');
    expect(pbrFacadeSet(MAT_STONE)).toEqual({ set: 'concrete', tint: PBR_STONE_TINT });
    expect(pbrFacadeSet(MAT_GLASS).set).toBeNull();
    expect(pbrFacadeSet(MAT_WOOD).set).toBeNull();
    expect(pbrFacadeSet(MAT_NONE)).toEqual({ set: 'concrete', tint: [1, 1, 1] });
    expect(pbrFacadeSet(MAT_CONCRETE).set).toBe('concrete');
    expect(pbrFacadeSet(99).set).toBe('concrete');
  });

  it('branch indices match the shader (0 none, 1 concrete, 2 brick, 3 metal, 4 plaster)', () => {
    expect(PBR_WALL_SETS).toEqual([null, 'concrete', 'brick', 'metal', 'plaster']);
    // facade.ts: idx = 1 + brick + 2·metal + 3·plaster − (glass + wood)
    const shader = (c: number): number =>
      1 + (c === MAT_BRICK ? 1 : 0) + (c === MAT_METAL ? 2 : 0) + (c === MAT_PLASTER ? 3 : 0) - (c === MAT_GLASS || c === MAT_WOOD ? 1 : 0);
    for (let c = 0; c <= 7; c++) expect(shader(c)).toBe(pbrWallIndex(pbrFacadeSet(c).set));
  });
});
