/**
 * Type declarations for `scripts/tile-city.mjs`, so the vitest test and
 * `tsc --noEmit` (scripts/check.sh) can import the JS module without
 * `allowJs`. The `.mjs` runtime is authoritative; this file only narrows the
 * shapes (mirroring `src/data/types.ts` via `import type`).
 */

import type { CityData, TileData, TileIndexData } from '../src/data/types';

/** Tile edge length in metres for shipped datasets (1000). */
export const DEFAULT_TILE_SIZE: number;

/**
 * Tile a monolithic `CityData` into a tiled dataset. Deterministic: same
 * input → same `index` and `tiles`.
 */
export function tileCity(
  city: CityData,
  tileSize: number,
): { index: TileIndexData; tiles: Map<string, TileData> };
