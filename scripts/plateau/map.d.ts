/**
 * Type declarations for `scripts/plateau/map.mjs`, so the vitest test and
 * `tsc --noEmit` can import the JS module without `allowJs`. The `.mjs`
 * runtime is authoritative; shapes mirror `src/data/types.ts`.
 */

import type { Building, Vec2 } from '../../src/data/types';
import type { PlateauBuilding } from './citygml';

type Origin = { lat: number; lon: number };

/** Roof classes produced by `classifyRoof` (`lod1` = no LOD2 roof). */
export type RoofKind =
  | 'none'
  | 'lod1'
  | 'flat'
  | 'stepped'
  | 'complex'
  | 'skillion'
  | 'gabled'
  | 'hipped'
  | 'pyramidal';

export interface RoofClass {
  kind: RoofKind;
  h?: number;
  dir?: number;
  levels?: number;
  slopedShare?: number;
  topShare?: number;
  mainY?: number;
  topY?: number;
}

/** `[lat, lon, h]` triples → local `[x, z, y]`. */
export function ringToLocal(ring: number[][], origin: Origin): number[][];
/** Absolute shoelace area of an `[x, z]` ring. */
export function ringArea(ring: number[][]): number;
/** Footprint cleanup to `Building.poly` rules; `[]` when degenerate. */
export function cleanRing(ring: number[][]): Vec2[];
/** Classify LOD2 roof facets (local `[x, z, y]` rings). */
export function classifyRoof(facets: number[][][]): RoofClass;
/** Stable numeric id from `uro:buildingID` / gml:id. */
export function numericId(buildingId: string | undefined, gmlId: string): number;
/** Map a parsed PLATEAU building onto our `Building`. */
export function toBuilding(
  pb: PlateauBuilding,
  origin: Origin,
): { building?: Building; roof: RoofClass; base?: number; skip?: string };
/** Union of edge-sharing facets (outer rings only), or null. */
export function unionFacets(rings: number[][][]): number[][][] | null;
/** `unionFacets` keeping holes (negatively oriented rings), or null. */
export function unionFacetsWithHoles(rings: number[][][]): { outers: number[][][]; holes: number[][][] } | null;
/** Cut a polygon with holes into hole-free, plan-disjoint pieces. */
export function splitHoles(outer: number[][], holes: number[][][]): number[][][];
/** LOD2 tiers what-if: grounded prisms per roof-height cluster. */
export function lod2Tiers(
  pb: PlateauBuilding,
  origin: Origin,
  base: number,
  id: number,
  opts?: { splitHoles?: boolean },
): { tiers: Building[]; fallback: boolean };
/** Even-odd point-in-polygon. */
export function pointInRing(x: number, z: number, ring: number[][]): boolean;
/** `[minX, minZ, maxX, maxZ]`. */
export function ringBounds(ring: number[][]): [number, number, number, number];
/** Sampled intersection area (m²). */
export function intersectionArea(a: number[][], b: number[][]): number;
/** Footprint IoU in [0, 1]. */
export function iou(a: number[][], b: number[][]): number;
/** Best-IoU OSM partner and OSM coverage per PLATEAU footprint. */
export function matchFootprints(
  plateau: number[][][],
  osm: number[][][],
): { j: number; iou: number; covered: number }[];
/** TS-free re-check of the validateCity building rules. */
export function checkBuildings(buildings: unknown[]): string[];
