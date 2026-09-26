/**
 * Giant hologram placement + timing maths (wave 25, T-0173). Pure: no three,
 * no DOM — unit-tested in node. The browser layer is `hologram.ts`; notes in
 * docs/styles/cyberpunk-hologram.md.
 *
 * Each city anchors the hologram to a spawn preset: resolve the preset
 * (`resolveSpawn`), step `aheadM` metres along its bearing, then search rings
 * every 5 m out to 80 m for the nearest point whose 14 m disc is free of
 * building footprints. The hologram faces back at the preset position, so
 * the default preset view sees her front.
 */
import type { Building, Vec2 } from '../../data/types';
import { resolveSpawn, SPAWN_PRESETS } from '../../data/spawn';

/** One city's hologram anchor: a `SPAWN_PRESETS` key and the step ahead of it (m). */
export interface HoloAnchor {
  preset: string;
  aheadM: number;
}

/** Hologram anchor per city id. Cities without an entry get no hologram. */
export const HOLO_ANCHORS: Record<string, HoloAnchor> = {
  london: { preset: 'bank', aheadM: 40 },
  kyiv: { preset: 'maidan', aheadM: 40 },
  tokyo: { preset: 'shibuya', aheadM: 40 },
  sydney: { preset: 'circularquay', aheadM: 40 },
  sf: { preset: 'unionsquare', aheadM: 40 },
  nyc: { preset: 'timessquare', aheadM: 40 },
};

/**
 * Dataset origins (`index.json` `origin`) of the anchored cities. The layer
 * context carries no origin, so the committed values are mirrored here;
 * tests/punk-hologram.test.ts fails if they drift from the data.
 */
export const HOLO_ORIGINS: Record<string, { lat: number; lon: number }> = {
  london: { lat: 51.5133, lon: -0.0887 },
  kyiv: { lat: 50.4501, lon: 30.5234 },
  tokyo: { lat: 35.6812, lon: 139.7671 },
  sydney: { lat: -33.8613, lon: 151.211 },
  sf: { lat: 37.788, lon: -122.4075 },
  nyc: { lat: 40.7359, lon: -73.9905 },
};

/** Footprint-free radius around the hologram centre (m). */
export const HOLO_CLEAR_R = 14;
/** Ring spacing of the clear-spot search (m); also the along-ring sample spacing. */
export const HOLO_SEARCH_STEP = 5;
/** Largest search ring radius (m). */
export const HOLO_SEARCH_MAX = 80;
/** Posed model height (m). */
export const HOLO_HEIGHT = 50;
/** Sway amplitude (radians, ±20°). */
export const HOLO_SWAY_AMP = (20 * Math.PI) / 180;
/** Sway period (s). */
export const HOLO_SWAY_PERIOD = 40;
/** Base opacity/brightness. */
export const HOLO_FLICKER_BASE = 0.75;
/** Flicker wobble amplitude around the base. */
export const HOLO_FLICKER_AMP = 0.08;
/** Glitch length (s). */
export const HOLO_GLITCH_S = 0.15;
/** Shortest gap between glitch starts (s). */
export const HOLO_GLITCH_MIN_GAP = 6;
/** Longest gap between glitch starts (s, exclusive). */
export const HOLO_GLITCH_MAX_GAP = 14;

/** A resolved hologram placement in local metres (`x` east, `z` south). */
export interface HoloPlacement {
  /** Hologram centre (feet). */
  x: number;
  z: number;
  /** Game-convention yaw (forward = `(sin yaw, −cos yaw)`) from the spot toward the preset. */
  yaw: number;
  /** The stepped search start (preset + `aheadM` along its bearing). */
  startX: number;
  startZ: number;
  /** The resolved preset position the hologram faces. */
  presetX: number;
  presetZ: number;
}

/** The resolved preset pose and stepped search start for a city, or null when the city has no hologram. */
export function holoStart(cityId: string): { preset: { x: number; z: number; yaw: number }; start: { x: number; z: number } } | null {
  const anchor = HOLO_ANCHORS[cityId];
  const origin = HOLO_ORIGINS[cityId];
  if (!anchor || !origin || !SPAWN_PRESETS[anchor.preset]) return null;
  const p = resolveSpawn(anchor.preset, origin, () => false);
  return {
    preset: p,
    start: { x: p.x + anchor.aheadM * Math.sin(p.yaw), z: p.z - anchor.aheadM * Math.cos(p.yaw) },
  };
}

/** Game-convention yaw (forward `(sin yaw, −cos yaw)`) looking from `from` to `to`. */
export function holoYaw(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(to.x - from.x, -(to.z - from.z));
}

/** Squared distance from `p` to segment `a`–`b`. */
function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qz = az + t * dz - pz;
  return qx * qx + qz * qz;
}

/** Even-odd point-in-polygon. */
function inside(px: number, pz: number, poly: readonly Vec2[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > pz !== b[1] > pz && px < ((b[0] - a[0]) * (pz - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/**
 * Whether the disc of radius `r` around `(x, z)` is clear of every footprint:
 * the centre is inside no polygon and no footprint edge (hence no vertex)
 * comes closer than `r`.
 */
export function holoDiscClear(x: number, z: number, buildings: readonly Building[], r = HOLO_CLEAR_R): boolean {
  const r2 = r * r;
  for (const b of buildings) {
    const poly = b.poly;
    if (inside(x, z, poly)) return false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const c = poly[j]!;
      if (segDist2(x, z, a[0], a[1], c[0], c[1]) < r2) return false;
    }
  }
  return true;
}

/** Buildings whose bbox comes within `reach` of `(x, z)` (square test). */
function nearBuildings(x: number, z: number, reach: number, buildings: readonly Building[]): Building[] {
  const out: Building[] = [];
  for (const b of buildings) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [px, pz] of b.poly) {
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (pz < z0) z0 = pz;
      if (pz > z1) z1 = pz;
    }
    if (x1 >= x - reach && x0 <= x + reach && z1 >= z - reach && z0 <= z + reach) out.push(b);
  }
  return out;
}

/**
 * The nearest footprint-free spot for the hologram: step `aheadM` metres
 * from `start` along `bearing` (game yaw, forward `(sin, −cos)`), then test
 * that point and rings every `HOLO_SEARCH_STEP` m out to `HOLO_SEARCH_MAX` m
 * (samples ≈ 5 m apart along each ring, starting in the bearing direction)
 * and return the first whose `HOLO_CLEAR_R` disc is clear
 * ({@link holoDiscClear}); null when the whole search area is built up.
 */
export function holoSpot(
  start: { x: number; z: number },
  bearing: number,
  buildings: readonly Building[],
  aheadM = 0,
): { x: number; z: number } | null {
  const sx = start.x + aheadM * Math.sin(bearing);
  const sz = start.z - aheadM * Math.cos(bearing);
  const near = nearBuildings(sx, sz, HOLO_SEARCH_MAX + HOLO_CLEAR_R, buildings);
  if (holoDiscClear(sx, sz, near)) return { x: sx, z: sz };
  for (let r = HOLO_SEARCH_STEP; r <= HOLO_SEARCH_MAX; r += HOLO_SEARCH_STEP) {
    const n = Math.max(6, Math.ceil((2 * Math.PI * r) / HOLO_SEARCH_STEP));
    for (let k = 0; k < n; k++) {
      const a = bearing + (2 * Math.PI * k) / n;
      const x = sx + r * Math.sin(a);
      const z = sz - r * Math.cos(a);
      if (holoDiscClear(x, z, near)) return { x, z };
    }
  }
  return null;
}

/**
 * Full placement for a city: {@link holoStart} → {@link holoSpot} from the
 * stepped start → yaw facing the preset. Null when the city has no anchor
 * or no clear spot exists among `buildings`.
 */
export function holoPlacement(cityId: string, buildings: readonly Building[]): HoloPlacement | null {
  const s = holoStart(cityId);
  if (!s) return null;
  const spot = holoSpot(s.start, s.preset.yaw, buildings);
  if (!spot) return null;
  return {
    x: spot.x,
    z: spot.z,
    yaw: holoYaw(spot, s.preset),
    startX: s.start.x,
    startZ: s.start.z,
    presetX: s.preset.x,
    presetZ: s.preset.z,
  };
}

/** Tile keys (`"i_j"`, 1000 m tiles) whose rect meets the square of half-extent `r` around `(x, z)`. */
export function holoTileKeys(x: number, z: number, r: number, tileSize = 1000): string[] {
  const keys: string[] = [];
  for (let i = Math.floor((x - r) / tileSize); i <= Math.floor((x + r) / tileSize); i++) {
    for (let j = Math.floor((z - r) / tileSize); j <= Math.floor((z + r) / tileSize); j++) keys.push(`${i}_${j}`);
  }
  return keys;
}

/** Sway yaw offset (radians) at time `t`: ±20° sine with a 40 s period. */
export function holoSway(t: number): number {
  return HOLO_SWAY_AMP * Math.sin((2 * Math.PI * t) / HOLO_SWAY_PERIOD);
}

/** Opacity/brightness flicker at time `t`: 0.75 ± 0.08 from two incommensurate 1–3 Hz sines. */
export function holoFlicker(t: number): number {
  const w = 0.6 * Math.sin(2 * Math.PI * 1.3 * t) + 0.4 * Math.sin(2 * Math.PI * 2.7 * t + 1.7);
  return HOLO_FLICKER_BASE + HOLO_FLICKER_AMP * w;
}

/** Deterministic hash of an integer to `[0, 1)`. */
export function holoHash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Gap (s) between glitch `k` and glitch `k + 1`: hashed into `[6, 14)`. */
export function holoGlitchGap(k: number): number {
  return HOLO_GLITCH_MIN_GAP + (HOLO_GLITCH_MAX_GAP - HOLO_GLITCH_MIN_GAP) * holoHash(k);
}
