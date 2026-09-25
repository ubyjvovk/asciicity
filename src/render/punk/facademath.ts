/**
 * Pure facade decisions and constants (wave 20b). No three/webgpu — the
 * TSL graph in `facade.ts` imports these numbers and hashes the same inputs
 * with `hash2Node` so unit tests and the shader cannot drift.
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Facades" and
 * "Facades × OSM (wave 21)".
 */
import { hash2 } from './noise';

/** JS mirror of `hash2Node` — every facade roll uses this, never another hash. */
export function facadeHash(x: number, y: number): number {
  return hash2(x, y);
}

/** Rec.709 luma weights for `mix(luma(vc), vc, ALBEDO_CHROMA)`. */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** UV unit in metres (`buildings.ts`: u = perimeter/24, v = (y − base)/24). */
export const UV_TILE_M = 24;
/** Window-cell size (m): `u·8`, `v·8` index these. */
export const WINDOW_CELL_M = 3;
/** Atlas cell size (px); window occupies x∈[2, 6), y∈[1, 6). */
export const ATLAS_CELL_PX = 8;
export const WINDOW_PX_X0 = 2;
export const WINDOW_PX_X1 = 6;
export const WINDOW_PX_Y0 = 1;
export const WINDOW_PX_Y1 = 6;

/** Shopfront band height (m) above wall base; no lit windows below this. */
export const SHOPFRONT_HEIGHT_M = 4;
/** Shopfront segment length (m of u). */
export const SHOPFRONT_SEGMENT_M = 6;
/** Roll-down shutter share of shopfront segments (PM GPU review: 55 % read as a neon strip). */
export const SHUTTER_SHARE = 0.75;
/** Shutter albedo range: `SHUTTER_ALBEDO_MIN + SHUTTER_ALBEDO_RANGE · r` (dark metal, no emission). */
export const SHUTTER_ALBEDO_MIN = 0.02;
export const SHUTTER_ALBEDO_RANGE = 0.03;
/** Shutter ridge spacing (m). */
export const SHUTTER_RIDGE_M = 0.12;
/** Dark mullion spacing on shop glass (m). */
export const MULLION_M = 1.5;
/** Shop-glass emissive range: 0.18–0.55. */
export const SHOP_EMISSIVE_MIN = 0.18;
export const SHOP_EMISSIVE_RANGE = 0.37;
/** Lit width (m) of shop glass, centred in its segment; the rest are dark piers. */
export const SHOP_LIT_WIDTH_M = 3.6;
/** Dark pier width (m) each side of the lit shop glass. */
export const SHOP_PIER_M = (SHOPFRONT_SEGMENT_M - SHOP_LIT_WIDTH_M) / 2;

/** Fine-detail fade distance (m): seams / mullions / blinds contrast × `1 − smoothstep(NEAR, FAR, d)`. */
export const DETAIL_FADE_NEAR_M = 15;
export const DETAIL_FADE_FAR_M = 60;

/** Floor-band spacing (m) — every `v·8` integer line. */
export const FLOOR_BAND_M = 3;
/** Floor-band thickness (m). */
export const FLOOR_BAND_WIDTH_M = 0.22;
/** Floor-band albedo darkening (35 %). */
export const FLOOR_BAND_DARKEN = 0.35;
/** Vertical panel-seam spacing (m) — every `u·16`. */
export const PANEL_SEAM_M = 1.5;
/** Max bump strength for seams (≤ 0.35). */
export const SEAM_BUMP = 0.35;

/** Grime / rain-streak `vnoise(u·STREAK_U_SCALE, v·STREAK_V_SCALE)`. */
export const STREAK_U_SCALE = 24;
export const STREAK_V_SCALE = 1.5;
/** Max albedo darkening from streaks (35 %). */
export const STREAK_DARKEN = 0.35;
/** Max roughness drop from wet streaks. */
export const STREAK_ROUGHNESS_DROP = 0.25;

/** Mix of vertex colour vs luma for base albedo. */
export const ALBEDO_CHROMA = 0.25;
/** Base albedo scale: `ALBEDO_MIN + ALBEDO_RANGE · bs`. */
export const ALBEDO_MIN = 0.2;
export const ALBEDO_RANGE = 0.12;

/** Unlit glass. */
export const GLASS_ALBEDO = 0.015;
export const GLASS_ROUGHNESS = 0.08;
export const GLASS_METALNESS = 0.6;

/** Dry concrete / metal wall. */
export const WALL_ROUGHNESS = 0.62;
export const WALL_METALNESS = 0.18;

/** Share of buildings that stay dark. */
export const DARK_BUILDING_SHARE = 0.25;
/**
 * Lit probability inside a dark building (0 → a dark building's lit
 * fraction is 0 ≤ 0.03). Non-dark buildings use {@link WINDOW_LIT_P}.
 */
export const DARK_WINDOW_LIT_P = 0;
/**
 * Lit probability inside a non-dark building. Overall (25 % dark at 0) is
 * `0.75 · WINDOW_LIT_P` ≈ 0.109, inside the 8–14 % band.
 */
export const WINDOW_LIT_P = 0.145;

/** Intensity: `INTENSITY_MIN + INTENSITY_RANGE · r³`. */
export const INTENSITY_MIN = 0.15;
export const INTENSITY_RANGE = 0.75;

/**
 * Window tint palette (linear RGB): tungsten, fluorescent, cyan, magenta.
 * Shares: 60 / 20 / 12 / 8 %.
 */
export const WINDOW_TINTS: readonly (readonly [number, number, number])[] = [
  [1.0, 0.62, 0.32],
  [0.75, 0.85, 1.0],
  [0.1, 0.85, 1.0],
  [1.0, 0.12, 0.62],
];
/** Tint shares in palette order; must sum to 1. */
export const TINT_SHARES: readonly [number, number, number, number] = [0.6, 0.2, 0.12, 0.08];
/** Cumulative tint thresholds (0.60 / 0.80 / 0.92). */
export const TINT_THRESH: readonly [number, number, number] = [0.6, 0.8, 0.92];

/** Share of lit windows that show blinds. */
export const BLINDS_SHARE = 0.3;
/** Share of lit windows that flicker. */
export const FLICKER_SHARE = 0.02;

/** Roof bitumen albedo range. */
export const ROOF_ALBEDO_MIN = 0.03;
export const ROOF_ALBEDO_RANGE = 0.02;
/** Roof / street puddle mask: `smoothstep(LO, HI, fbm2(xz · FREQ))`. */
export const ROOF_PUDDLE_LO = 0.54;
export const ROOF_PUDDLE_HI = 0.62;
export const ROOF_PUDDLE_FREQ = 0.07;
/** `rippleNormal` UV scale for roofs. */
export const RIPPLE_SCALE = 4.8;

/** Hash salts so each decision is an independent `hash2` on the same inputs. */
export const HASH_SALT_DARK = 19;
export const HASH_SALT_LIT = 3;
export const HASH_SALT_INT = 11;
export const HASH_SALT_TINT = 23;
export const HASH_SALT_BLINDS = 41;
export const HASH_SALT_SHOP = 61;
export const HASH_SALT_FLICKER = 73;
export const HASH_SALT_SHOP_INT = 91;
export const HASH_SALT_SHOP_TINT = 103;
export const HASH_SALT_SHUTTER = 127;

/** Building seed `bs` = h(vertexColor.rg · 97 + vertexColor.b · 13). */
export function buildingSeed(r: number, g: number, b: number): number {
  return facadeHash(r * 97 + b * 13, g * 97 + b * 13);
}

/** True for {@link DARK_BUILDING_SHARE} of seeds. */
export function isDarkBuilding(seed: number): boolean {
  return facadeHash(seed, HASH_SALT_DARK) < DARK_BUILDING_SHARE;
}

/** Tint index 0..3 (tungsten / fluorescent / cyan / magenta). */
export type WindowTint = 0 | 1 | 2 | 3;

/** Per-window lighting decision (cell id + building seed). */
export interface WindowLight {
  lit: boolean;
  intensity: number;
  tint: WindowTint;
  blinds: boolean;
}

const UNLIT: WindowLight = { lit: false, intensity: 0, tint: 0, blinds: false };

/** Intensity from a unit hash, skewed low: `0.15 + 0.75 · r³`. */
export function windowIntensity(r: number): number {
  return INTENSITY_MIN + INTENSITY_RANGE * r * r * r;
}

/** Tint index from a unit hash using {@link TINT_THRESH}. */
export function windowTintIndex(r: number): WindowTint {
  if (r < TINT_THRESH[0]) return 0;
  if (r < TINT_THRESH[1]) return 1;
  if (r < TINT_THRESH[2]) return 2;
  return 3;
}

/**
 * Lit / intensity / tint / blinds for window cell `(cellU, cellV)`; `code` is
 * the OSM material (glass lights ×1.5, see {@link windowLitP}).
 * No lights when the cell bottom is below {@link SHOPFRONT_HEIGHT_M}.
 */
export function windowLight(cellU: number, cellV: number, seed: number, code = 0): WindowLight {
  const cu = Math.floor(cellU);
  const cv = Math.floor(cellV);
  if (cv * WINDOW_CELL_M < SHOPFRONT_HEIGHT_M) return UNLIT;
  const pLit = windowLitP(seed, code);
  const hLit = facadeHash(cu + seed * 17, cv + seed * 9 + HASH_SALT_LIT);
  if (hLit >= pLit) return UNLIT;
  const rInt = facadeHash(cu + seed * 5, cv + HASH_SALT_INT);
  const rTint = facadeHash(cu + seed * 2, cv + HASH_SALT_TINT);
  const rBlinds = facadeHash(cu + seed * 13, cv + HASH_SALT_BLINDS);
  return {
    lit: true,
    intensity: windowIntensity(rInt),
    tint: windowTintIndex(rTint),
    blinds: rBlinds < BLINDS_SHARE,
  };
}

/** Ground-floor treatment for a 6 m u-segment. */
export type ShopfrontKind = 'shutter' | 'shop';

/** 75 % roll-down shutter, 25 % lit shop glass, per 6 m of u. */
export function shopfrontKind(segment: number, seed: number): ShopfrontKind {
  const seg = Math.floor(segment);
  return facadeHash(seg + seed * 8, HASH_SALT_SHOP) < SHUTTER_SHARE ? 'shutter' : 'shop';
}

/** Shutter albedo 0.02–0.05 for a 6 m segment (same roll in the shader). */
export function shutterAlbedo(segment: number, seed: number): number {
  const seg = Math.floor(segment);
  return SHUTTER_ALBEDO_MIN + SHUTTER_ALBEDO_RANGE * facadeHash(seg + seed * 6, HASH_SALT_SHUTTER);
}

/** Shop-glass emissive strength 0.18–0.55 for a 6 m segment. */
export function shopEmissive(segment: number, seed: number): number {
  const seg = Math.floor(segment);
  return SHOP_EMISSIVE_MIN + SHOP_EMISSIVE_RANGE * facadeHash(seg + seed * 3, HASH_SALT_SHOP_INT);
}

/** True when metre `uM` along the wall falls in the lit middle 3.6 m of its shop segment. */
export function inShopLitSpan(uM: number): boolean {
  const x = uM - Math.floor(uM / SHOPFRONT_SEGMENT_M) * SHOPFRONT_SEGMENT_M;
  return x >= SHOP_PIER_M && x < SHOPFRONT_SEGMENT_M - SHOP_PIER_M;
}

/** Fine-detail contrast at view distance `d` (m): 1 near, 0 beyond 60 m (smoothstep 15 → 60). */
export function detailFade(d: number): number {
  const t = Math.min(1, Math.max(0, (d - DETAIL_FADE_NEAR_M) / (DETAIL_FADE_FAR_M - DETAIL_FADE_NEAR_M)));
  return 1 - t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Facades × OSM (wave 21, T-0161): the `extra` vec4 = (osm rgb linear | −1, material code).
// ---------------------------------------------------------------------------

/** OSM facade colour → night albedo scale (`osm · 0.18`). */
export const OSM_WALL_NIGHT = 0.18;
/** OSM roof colour → night albedo scale (`roofColor · 0.15`). */
export const OSM_ROOF_NIGHT = 0.15;
/** Share of the procedural grime / floor bands kept on top of an OSM colour. */
export const OSM_GRIME_KEEP = 0.25;

/** `extra.w` material codes (mirror of `MATERIAL_CODE` in `world/buildings.ts`; 0 = none). */
export const MAT_NONE = 0;
export const MAT_BRICK = 1;
export const MAT_STONE = 2;
export const MAT_CONCRETE = 3;
export const MAT_GLASS = 4;
export const MAT_METAL = 5;
export const MAT_WOOD = 6;
export const MAT_PLASTER = 7;

/** Glass curtain wall: lit-probability multiplier ("offices ×1.5") and its cap. */
export const GLASS_LIT_MULT = 1.5;
export const GLASS_LIT_MAX = 0.3;

/** Brick joints need a nearer fade than the 15 → 60 m detail fade (0.075 m courses alias sooner). */
export const BRICK_FADE_NEAR_M = 6;
export const BRICK_FADE_FAR_M = 25;

/** Surface pattern family of a material code. */
export type FacadePatternKind = 'panels' | 'brick' | 'ashlar' | 'curtain' | 'seams' | 'boards' | 'smooth';

/** Per-material facade pattern parameters (architecture.md §4.11 "Facades × OSM"). */
export interface FacadePattern {
  kind: FacadePatternKind;
  /** Course / block height (brick, ashlar) or joint spacing along u (panels, curtain, seams, boards), m; 0 = none. */
  size: number;
  /** Unit length along u for bonded patterns (brick 0.225 m, ashlar 1.2 m); 0 when not bonded. */
  unitLength: number;
  /** Joint / mortar / mullion width (m). */
  joint: number;
  /** Albedo override (glass curtain wall) or −1 to keep the base albedo. */
  albedo: number;
  roughness: number;
  metalness: number;
  /** ± per-unit albedo variation (bricks, blocks, boards) or stain contrast (plaster). */
  variation: number;
}

/** Pattern table indexed by material code 0–7; concrete / none keep the T-0152 panels. */
export const FACADE_PATTERNS: readonly FacadePattern[] = [
  { kind: 'panels', size: PANEL_SEAM_M, unitLength: 0, joint: 0.04, albedo: -1, roughness: WALL_ROUGHNESS, metalness: WALL_METALNESS, variation: 0 },
  { kind: 'brick', size: 0.075, unitLength: 0.225, joint: 0.012, albedo: -1, roughness: 0.82, metalness: 0.04, variation: 0.15 },
  { kind: 'ashlar', size: 0.6, unitLength: 1.2, joint: 0.02, albedo: -1, roughness: 0.72, metalness: 0.05, variation: 0.12 },
  { kind: 'panels', size: PANEL_SEAM_M, unitLength: 0, joint: 0.04, albedo: -1, roughness: WALL_ROUGHNESS, metalness: WALL_METALNESS, variation: 0 },
  { kind: 'curtain', size: 1.5, unitLength: 0, joint: 0.06, albedo: 0.02, roughness: 0.05, metalness: 0.9, variation: 0 },
  { kind: 'seams', size: 0.5, unitLength: 0, joint: 0.03, albedo: -1, roughness: 0.4, metalness: 0.7, variation: 0 },
  { kind: 'boards', size: 0.2, unitLength: 0, joint: 0.012, albedo: -1, roughness: 0.78, metalness: 0.02, variation: 0.2 },
  { kind: 'smooth', size: 0, unitLength: 0, joint: 0, albedo: -1, roughness: 0.85, metalness: 0.02, variation: 0.12 },
];

/** Pattern for an `extra.w` code; unknown codes fall back to the T-0152 panels. */
export function facadePattern(code: number): FacadePattern {
  const k = Math.round(code);
  return FACADE_PATTERNS[k] ?? FACADE_PATTERNS[MAT_NONE];
}

/** OSM facade rgb (linear) → night albedo `rgb · 0.18`; null (use procedural) when rgb < 0. */
export function nightAlbedo(rgb: readonly [number, number, number]): [number, number, number] | null {
  if (rgb[0] < 0) return null;
  return [rgb[0] * OSM_WALL_NIGHT, rgb[1] * OSM_WALL_NIGHT, rgb[2] * OSM_WALL_NIGHT];
}

/** OSM roof rgb (linear) → night albedo `rgb · 0.15`; null (keep bitumen) when rgb < 0. */
export function nightRoofAlbedo(rgb: readonly [number, number, number]): [number, number, number] | null {
  if (rgb[0] < 0) return null;
  return [rgb[0] * OSM_ROOF_NIGHT, rgb[1] * OSM_ROOF_NIGHT, rgb[2] * OSM_ROOF_NIGHT];
}

/** Per-window lit probability: dark / normal building, ×1.5 capped at 0.3 for glass (offices). */
export function windowLitP(seed: number, code = MAT_NONE): number {
  const p = isDarkBuilding(seed) ? DARK_WINDOW_LIT_P : WINDOW_LIT_P;
  return Math.round(code) === MAT_GLASS ? Math.min(GLASS_LIT_MAX, p * GLASS_LIT_MULT) : p;
}

// ---------------------------------------------------------------------------
// PBR detail textures (wave 23, T-0167): CC0 ambientCG sets modulate the
// procedural materials (architecture.md §4.11 "PBR detail textures").
// ---------------------------------------------------------------------------

/** The six CC0 sets under `public/textures/cc0/<set>/`. */
export type PbrSetName = 'asphalt' | 'concrete' | 'brick' | 'metal' | 'paving' | 'plaster';
/** Every set name, in README order. */
export const PBR_SET_NAMES: readonly PbrSetName[] = ['asphalt', 'concrete', 'brick', 'metal', 'paving', 'plaster'];

/** Albedo modulation `tex / mean` is clamped to this band. */
export const PBR_ALBEDO_MIN = 0.25;
export const PBR_ALBEDO_MAX = 2.6;
/** Roughness = mix(procedural, tex.r, PBR_ROUGH_MIX). */
export const PBR_ROUGH_MIX = 0.6;
/** Tangent-space normal-map strength. */
export const PBR_NORMAL_STRENGTH = 1.6;
/** Distance fade (m): texture pattern → its mean, normal → flat over 15 → 60 m. */
export const PBR_FADE_NEAR_M = 25;
export const PBR_FADE_FAR_M = 90;
/** Facades: wall uv × 6 = one repeat per 4 m. */
export const PBR_WALL_UV_SCALE = UV_TILE_M / 4;
/** Roofs: one repeat per 6 m of world xz. */
export const PBR_ROOF_M = 6;
/** Stone facades use concrete tinted by this (linear rgb). */
export const PBR_STONE_TINT: readonly [number, number, number] = [0.9, 0.87, 0.8];
/** Hash salts for the per-building anti-tiling rolls. */
export const HASH_SALT_PBR_SWAP = 139;
export const HASH_SALT_PBR_OU = 151;
export const HASH_SALT_PBR_OV = 163;

/**
 * Albedo modulation of one channel: `tex / mean` clamped to [0.45, 1.8]
 * (exactly 1 at the texture mean), pulled toward 1 by `fade` (1 near, 0 far).
 */
export function pbrAlbedoMod(tex: number, mean: number, fade = 1): number {
  const m = Math.min(PBR_ALBEDO_MAX, Math.max(PBR_ALBEDO_MIN, tex / Math.max(mean, 1e-4)));
  return 1 + (m - 1) * fade;
}

/** Texture detail weight at view distance `d` (m): 1 at ≤ 15 m, 0 at ≥ 60 m, smooth and monotone. */
export function pbrFade(d: number): number {
  return detailFade(d);
}

/** Per-building anti-tiling: 0/90° uv swap and a uv offset in [0, 1)². */
export interface PbrAntiTile {
  swap: boolean;
  offsetU: number;
  offsetV: number;
}

/** Deterministic anti-tiling roll for building seed `seed` (same hashes in the shader). */
export function pbrAntiTile(seed: number): PbrAntiTile {
  return {
    swap: facadeHash(seed * 29, HASH_SALT_PBR_SWAP) < 0.5,
    offsetU: facadeHash(seed * 31, HASH_SALT_PBR_OU),
    offsetV: facadeHash(seed * 37, HASH_SALT_PBR_OV),
  };
}

/**
 * Wall texture uv for a building: `uv · 6 + offset`, u/v swapped when the
 * roll says so. Only isotropic sets (concrete, plaster) take the swap —
 * bricks and standing seams would turn on their side.
 */
export function pbrWallUv(u: number, v: number, seed: number, allowSwap: boolean): [number, number] {
  const t = pbrAntiTile(seed);
  const su = u * PBR_WALL_UV_SCALE;
  const sv = v * PBR_WALL_UV_SCALE;
  const swap = allowSwap && t.swap;
  return [(swap ? sv : su) + t.offsetU, (swap ? su : sv) + t.offsetV];
}

/** Texture set (or null = procedural only) and albedo tint for a facade. */
export interface PbrFacadeSet {
  set: PbrSetName | null;
  tint: readonly [number, number, number];
}

const NO_TINT: readonly [number, number, number] = [1, 1, 1];

/**
 * OSM `extra.w` material code → texture set: brick → brick, metal → metal,
 * plaster → plaster, stone → concrete × {@link PBR_STONE_TINT}, glass / wood →
 * none, concrete / none / unknown → concrete.
 */
export function pbrFacadeSet(code: number): PbrFacadeSet {
  switch (Math.round(code)) {
    case MAT_BRICK:
      return { set: 'brick', tint: NO_TINT };
    case MAT_METAL:
      return { set: 'metal', tint: NO_TINT };
    case MAT_PLASTER:
      return { set: 'plaster', tint: NO_TINT };
    case MAT_STONE:
      return { set: 'concrete', tint: PBR_STONE_TINT };
    case MAT_GLASS:
    case MAT_WOOD:
      return { set: null, tint: NO_TINT };
    default:
      return { set: 'concrete', tint: NO_TINT };
  }
}

/** Wall sampler branch index: 0 none, 1 concrete, 2 brick, 3 metal, 4 plaster. */
export const PBR_WALL_SETS: readonly (PbrSetName | null)[] = [null, 'concrete', 'brick', 'metal', 'plaster'];

/** Branch index of a facade set in {@link PBR_WALL_SETS}. */
export function pbrWallIndex(set: PbrSetName | null): number {
  const i = PBR_WALL_SETS.indexOf(set);
  return i < 0 ? 0 : i;
}

/** sRGB-encoded byte → linear [0, 1]. */
export function srgbByteToLinear(b: number): number {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Mean linear rgb of RGBA8 sRGB pixels (the `TEX_MEAN` of a colour map). */
export function linearMeanRgb(rgba: ArrayLike<number>): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return [1, 1, 1];
  for (let i = 0; i < n * 4; i += 4) {
    r += srgbByteToLinear(rgba[i]);
    g += srgbByteToLinear(rgba[i + 1]);
    b += srgbByteToLinear(rgba[i + 2]);
  }
  return [r / n, g / n, b / n];
}
