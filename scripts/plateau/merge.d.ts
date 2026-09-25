/**
 * Type declarations for `scripts/plateau/merge.mjs`, so the vitest test and
 * `tsc --noEmit` can import the JS module without `allowJs`. The `.mjs`
 * runtime is authoritative; shapes mirror `src/data/types.ts`.
 */

import type { Building, BuildingTier, TileData, TileIndexData, Vec2 } from '../../src/data/types';
import type { PlateauBuilding } from './citygml';

type Origin = { lat: number; lon: number };

/** A converted PLATEAU building waiting for ids / merge. */
export interface PlateauRow {
  gmlId?: string;
  building: Building;
  plateauName?: string;
}

/** Lowest PLATEAU building id (2^48). */
export const PLATEAU_ID_BASE: number;
/** Cap on `Building.tiers`. */
export const MAX_TIERS: number;
/** Stable id in [2^48, 2^49) from a gml:id. */
export function plateauId(gmlId: string): number;
/** True for ids in the PLATEAU range. */
export function isPlateauId(id: number): boolean;
/** Assign `plateauId`s in order, bumping collisions; returns the collision count. */
export function assignIds(rows: { gmlId: string; building: { id: number } }[]): number;
/** Unrounded vertex mean of a ring (the tiler's anchor). */
export function vertexMean(ring: number[][]): [number, number];
/** `"i_j"` tile of a building by the tiler's anchor rule. */
export function buildingTileKey(poly: number[][], tileSize: number): string;
/** Share of `ring` covered by the union of `others`. */
export function coveredShare(ring: number[][], others: number[][][]): number;
/** OSM `building:part` flags (raised parts and 3D-massing stacks). */
export function osmPartFlags(osm: { poly: Vec2[] | number[][]; h: number; minH?: number }[]): boolean[];
/** Merge rules 3 (+3b fallback), 4, 5: kept OSM + named, un-suppressed PLATEAU buildings. */
export function mergeBuildings(
  plateau: PlateauRow[],
  osm: Building[],
): { buildings: Building[]; stats: Record<string, number> };
/** Stepped / complex LOD2 massing → plan-disjoint tiers, or null with a reason. */
export function buildTiers(
  pb: PlateauBuilding,
  origin: Origin,
  base: number,
  h: number,
): { tiers: BuildingTier[] | null; reason?: string };
/** Re-assign buildings to tiles, recompute stats and landmarks. */
export function retile(
  index: TileIndexData,
  tiles: Map<string, TileData>,
  buildings: Building[],
): { index: TileIndexData; tiles: Map<string, TileData>; removed: string[]; created: string[] };
/** One PLATEAU building → `Building` (+ tiers, never with roof). */
export function convertBuilding(
  pb: PlateauBuilding,
  origin: Origin,
): { building?: Building; plateauName?: string; kind: string; skip?: string; tierReject?: string };
