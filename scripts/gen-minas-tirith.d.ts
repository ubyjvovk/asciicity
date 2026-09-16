/**
 * Type declarations for `scripts/gen-minas-tirith.mjs`, so the vitest test and
 * `tsc --noEmit` (scripts/check.sh) can import the JS module without
 * `allowJs`. The `.mjs` runtime is authoritative; this file only narrows the
 * shapes (mirroring `src/data/types.ts` via `import type`).
 */

import type {
  Building,
  CityData,
  Place,
  Road,
  TerrainData,
} from '../src/data/types';

/** One of the seven circles (wall radius, plateau height, wall height, colour). */
export type Tier = {
  k: number;
  r: number;
  h: number;
  wallH: number;
  color: number;
};

/** L1..L7: wall radius (m) and plateau height above the Pelennor. */
export const TIERS: ReadonlyArray<Tier>;

/**
 * Gate azimuths in degrees clockwise from north
 * (`x = r·sin a`, `z = −r·cos a`). Index 0 is L1.
 */
export const GATE_AZ: ReadonlyArray<number>;

/** Named HUD / tag places (architecture.md §4.23). */
export const PLACES: ReadonlyArray<Place>;

/** Seeded 32-bit PRNG (mulberry32) returning floats in [0, 1). */
export function mulberry32(seed: number): () => number;

/**
 * Ground height at `(x, z)` in metres. `rand` is a mulberry32 stream or a
 * numeric seed (Pelennor noise is a lattice hash, not a stream).
 */
export function terrainHeight(
  x: number,
  z: number,
  rand?: (() => number) | number,
): number;

/** Height grid covering the ±1500 m extent plus one margin cell. */
export function buildTerrain(seed: number): TerrainData;

/** Seven wall rings plus 14 gate towers (L1 pair = Great Gate). */
export function buildWalls(): Building[];

/** Climbing Way, ring roads, radial lanes, Pelennor roads. */
export function buildRoads(): Road[];

/**
 * Assemble the monolithic city for `seed` (default 1). Walls + gate towers
 * only; `trees` is empty (T-0127).
 */
export function buildCity(seed?: number): CityData;
