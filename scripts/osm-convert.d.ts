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
  },
): CityData & {
  skippedRelations?: number;
  skippedOpenWaterChains?: number;
  treesFilled?: number;
  treesDropped?: number;
};
