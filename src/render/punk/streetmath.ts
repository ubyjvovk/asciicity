/**
 * Pure maths for the cyberpunk streets (wave 20b, T-0153): the locked
 * puddle mask, the asphalt albedo and every material constant the shader
 * (`street.ts`) and its unit tests share. This module is intentionally
 * WebGPU-free (no `three/webgpu` import) so the distributions can be
 * unit-tested in plain node against the JS mirrors in `noise.ts`.
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Streets".
 */
import { fbm2, vnoise, smoothstepJs } from './noise';

/** Puddle mask threshold range: `smoothstep(E0, E1, fbm2(x·SCALE, z·SCALE))`. */
export const PUDDLE_E0 = 0.54;
export const PUDDLE_E1 = 0.62;
/** World-space scale applied to xz before fbm2 (metres per noise unit). */
export const PUDDLE_SCALE = 0.07;

// Asphalt (dry).
/** Base grey albedo of dry asphalt, midway in the 0.035–0.06 band. */
export const ASPHALT_BASE = 0.0475;
/** Fine-grain noise frequency (per metre). */
export const ASPHALT_GRAIN_SCALE = 3;
/** Fine-grain albedo amplitude (±). */
export const ASPHALT_GRAIN_AMP = 0.01;
/** Broad patch noise frequency (per metre). */
export const ASPHALT_PATCH_SCALE = 0.3;
/** Broad patch albedo amplitude (±). */
export const ASPHALT_PATCH_AMP = 0.012;
/** Albedo clamp band the whole asphalt function is kept inside. */
export const ASPHALT_MIN = 0.035;
export const ASPHALT_MAX = 0.06;
/** Dry asphalt: roughness (0.45–0.6), metalness, ripple strength. */
/** Damp asphalt (wave 23 perf pass): metalness 0.6 keeps it inside the SSR mask (≥ 0.5) at ~26 % weight so streets stay glossy while walls / pavement are skipped. */
export const ASPHALT_DRY_ROUGHNESS = 0.32;
export const ASPHALT_DRY_METALNESS = 0.6;
export const ASPHALT_DRY_RIPPLE = 0.12;
/** Ripple spatial scale shared by road / ground / terrain. */
export const ASPHALT_RIPPLE_SCALE = 4.2;

// Puddle (standing water).
export const PUDDLE_ALBEDO = 0.02;
export const PUDDLE_ROUGHNESS = 0.03;
export const PUDDLE_METALNESS = 0.9;
export const PUDDLE_RIPPLE = 1.2;

// Ground (concrete pavement, off-road).
/** Base pavement albedo (0.05–0.07 band). */
export const GROUND_BASE = 0.06;
/** Concrete tile edge (metres). */
export const GROUND_TILE = 1.5;
/** Tile seam width (metres). */
export const GROUND_TILE_SEAM = 0.02;
/** Pavement puddles sit at about half the road coverage: a higher mask. */
export const GROUND_PUDDLE_E0 = 0.6;
export const GROUND_PUDDLE_E1 = 0.68;
/** Terrain slope darkening: `1 − 0.5·(1 − normalWorld.y)`. */
export const SLOPE_DARKEN = 0.5;

// Water.
export const WATER_ALBEDO = 0.006;
export const WATER_ROUGHNESS = 0.02;
export const WATER_METALNESS = 0.95;
export const WATER_RIPPLE_SCALE = 2.2;
export const WATER_RIPPLE_STRENGTH = 0.7;
/** Slow water-wave period (metres). */
export const WATER_WAVE_PERIOD = 8;
/** Slow water-wave drift speed (m/s). */
export const WATER_WAVE_SPEED = 0.2;

// Specular anti-aliasing (rework 1): normal detail and puddle/water
// roughness fade with view distance so wet surfaces stop aliasing into
// blocky glitter under the half-resolution SSR beyond ~25 m.
/** View distance (m) at which normal detail starts fading out. */
export const RIPPLE_FADE_NEAR = 12;
/** View distance (m) at which normal detail is fully faded. */
export const RIPPLE_FADE_FAR = 45;
/** View distance (m) at which puddle/water roughness starts rising. */
export const ROUGH_FADE_NEAR = 20;
/** View distance (m) at which puddle/water roughness hits its floor. */
export const ROUGH_FADE_FAR = 80;
/** Roughness floor puddles/water are raised toward at distance. */
export const ROUGH_FLOOR = 0.35;
/** Grazing-angle guard band on `abs(dot(normalView, viewDir))`. */
export const GRAZE_LO = 0.05;
export const GRAZE_HI = 0.25;

/**
 * Puddle mask in [0, 1] at world (x, z): 0 = damp asphalt, 1 = standing
 * water. Locked formula (see §4.11 "Streets"); deterministic and pure.
 */
export function puddleAt(x: number, z: number): number {
  return smoothstepJs(PUDDLE_E0, PUDDLE_E1, fbm2(x * PUDDLE_SCALE, z * PUDDLE_SCALE));
}

/**
 * Dry-asphalt albedo at world (x, z): base grey with fine grain and broad
 * patch variation, clamped to the [0.035, 0.06] asphalt band.
 */
export function asphaltAlbedo(x: number, z: number): number {
  const grain = (vnoise(x * ASPHALT_GRAIN_SCALE, z * ASPHALT_GRAIN_SCALE) - 0.5) * 2 * ASPHALT_GRAIN_AMP;
  const patch = (vnoise(x * ASPHALT_PATCH_SCALE, z * ASPHALT_PATCH_SCALE) - 0.5) * 2 * ASPHALT_PATCH_AMP;
  const v = ASPHALT_BASE + grain + patch;
  return Math.min(ASPHALT_MAX, Math.max(ASPHALT_MIN, v));
}

/**
 * Normal-detail fade with view distance: 1 at d ≤ RIPPLE_FADE_NEAR, 0 at
 * d ≥ RIPPLE_FADE_FAR, monotone in between. `1 − smoothstep(NEAR, FAR, d)`.
 */
export function rippleFade(d: number): number {
  return 1 - smoothstepJs(RIPPLE_FADE_NEAR, RIPPLE_FADE_FAR, d);
}

/**
 * Distance roughness for mirror surfaces: `r` unchanged at d ≤ 20, raised
 * toward ROUGH_FLOOR by d ≥ 80 (for r < 0.35 reaches exactly ROUGH_FLOOR),
 * and never lower than `r`. Dry asphalt / pavement are unaffected.
 */
export function distanceRoughness(r: number, d: number): number {
  return r + (Math.max(r, ROUGH_FLOOR) - r) * smoothstepJs(ROUGH_FADE_NEAR, ROUGH_FADE_FAR, d);
}
