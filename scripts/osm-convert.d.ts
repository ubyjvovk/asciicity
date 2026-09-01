/**
 * Type declarations for `scripts/osm-convert.mjs`, so the vitest test and
 * `tsc --noEmit` (scripts/check.sh) can import the JS module without
 * `allowJs`. The `.mjs` runtime is authoritative; this file only narrows the
 * shapes (mirroring `src/data/types.ts` via `import type`).
 */

import type { CityData, RoadClass, Vec2 } from '../src/data/types';

/** WGS84 point used as the projection origin. */
type Origin = { lat: number; lon: number };
type Bbox = [number, number, number, number];

/**
 * Any object exposing bilinear DEM lookup — satisfied by `scripts/dem.mjs`'s
 * `Dem` class, or a stub in tests.
 */
type DemLike = { elevationAt(lat: number, lon: number): number };

export function project(
  lon: number,
  lat: number,
  origin: Origin,
): [number, number];

export function round1(v: number): number;

export function roadClassOf(highway: string): RoadClass | null;

export function heightOf(tags: Record<string, string>): number;

export function pickName(
  tags: Record<string, string>,
  lang?: string,
): string | undefined;

export function assembleRings(
  ways: Array<{ id: number; geometry: Array<{ lon: number; lat: number }> }>,
): Array<Array<{ lon: number; lat: number }>>;

export function clipRingToBox(
  ring: Vec2[],
  box: { minX: number; minZ: number; maxX: number; maxZ: number },
): Vec2[];

/** Bbox rect used by the coastline pipeline (data-format.md "Coastline water"). */
type BboxRect = { minX: number; minY: number; maxX: number; maxY: number };

export function signedArea(ring: Vec2[]): number;

export function clipPolylineToBbox(points: Vec2[], bbox: BboxRect): Vec2[][];

export function stitchChains(
  pieces: Vec2[][],
): { closed: Vec2[][]; open: Vec2[][] };

export function closeCoastline(openChains: Vec2[][], bbox: BboxRect): Vec2[][];

/** Hard cap on emitted trees (data-format.md §Trees). Exposed for tests. */
export const TREE_CAP: number;

/**
 * `--water-dem` DEM-contoured shoreline helpers (data-format.md "Water
 * relations", T-0116). The sloppy harbour polygon is node-masked against the
 * bare-earth terrain grid and re-contoured so small features are restored.
 */

/** Mark a masked water node for each grid node inside `ring` with height ≤ level + threshold. */
export function waterMaskFromRing(
  ring: Vec2[],
  level: number,
  threshold: number,
  heights: ArrayLike<number>,
  cols: number,
  rows: number,
  x0: number,
  z0: number,
  step: number,
): Uint8Array;

/** One 3×3 majority-vote pass over a binary mask (ties round up to water). */
export function majorityVoteGrid(mask: Uint8Array, cols: number, rows: number): Uint8Array;

/** Mask of grid cells occupied by a building centroid or non-bridge road vertex. */
export function protectedNodesFrom(
  points: Vec2[],
  cols: number,
  rows: number,
  x0: number,
  z0: number,
  step: number,
): Uint8Array;

/** Flip ≤ 8-node unprotected land specks to water, drop < 6-node water puddles. In place. */
export function cleanupMask(mask: Uint8Array, cols: number, rows: number, prot: Uint8Array): Uint8Array;

/** Marching-squares boundary rings (outer shoreline + island holes) for a water mask. */
export function traceWaterBoundary(
  mask: Uint8Array,
  cols: number,
  rows: number,
  x0: number,
  z0: number,
  step: number,
): Array<Array<[number, number]>>;

/** One or more Chaikin corner-cut smoothing passes on a closed ring. */
export function chaikin(ring: Array<[number, number]>, passes: number): Array<[number, number]>;

/** Cut a sloppy ring down to the DEM shore: mask → vote → force-LAND → cleanup → trace → Chaikin. */
export function contourWaterRings(opts: {
  ring: Vec2[];
  level?: number;
  threshold?: number;
  heights: ArrayLike<number>;
  cols: number;
  rows: number;
  x0: number;
  z0: number;
  step: number;
  protectedNodes?: Uint8Array;
}): { rings: Array<Array<[number, number]>>; mask: Uint8Array };

export function convertOverpass(
  json: { elements: unknown[] },
  opts: {
    origin: Origin;
    bbox?: Bbox;
    lang?: string;
    dem?: DemLike;
    step?: number;
    /** Override the 40 000 tree cap (tests pass a tiny value). */
    treeCap?: number;
    /** Full-relation water geometry (skip bbox clip on relation rings). */
    waterFull?: boolean;
    /** DEM-contoured shoreline for sloppy giant water rings. */
    waterDem?: boolean;
  },
): CityData & {
  skippedRelations?: number;
  skippedOpenWaterChains?: number;
  droppedOpenInnerChains?: number;
  treesFilled?: number;
  treesDropped?: number;
};
