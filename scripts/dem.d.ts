/**
 * Type declarations for `scripts/dem.mjs`, so the vitest test and
 * `tsc --noEmit` (scripts/check.sh) can import the JS module without
 * `allowJs`. The `.mjs` runtime is authoritative; this file only narrows the
 * shapes.
 */

import type { TerrainData, Vec2 } from '../src/data/types';

/** WGS84 point used as the projection origin. */
type Origin = { lat: number; lon: number };
type Bbox = [number, number, number, number];

export function hgtTileName(lat: number, lon: number): string;

export function hgtUrl(name: string): string;

export function decodeHgt(
  gunzippedBuffer: Buffer | ArrayBuffer | Uint8Array,
): { side: number; samples: Int16Array };

export class Dem {
  constructor(
    tiles: Map<string, { side: number; samples: Int16Array }>,
    opts?: { bareEarth?: boolean },
  );
  bareEarth: boolean;
  elevationAt(lat: number, lon: number): number;
  get voids(): number;
}

export function fetchDemTiles(
  bbox: Bbox,
  opts?: {
    cacheDir?: string;
    fetchImpl?: (
      url: string,
    ) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
    bareEarth?: boolean;
  },
): Promise<Dem>;

export function buildTerrain(opts: {
  bbox: Bbox;
  origin: Origin;
  dem: { elevationAt(lat: number, lon: number): number; bareEarth?: boolean };
  step?: number;
  waterRings?: Vec2[][];
  bare?: boolean;
}): { terrain: TerrainData; waterLevels: number[] };

export function unproject(x: number, z: number, origin: Origin): [number, number];

export function erode(heights: number[], cols: number, rows: number): number[];

export function smooth(heights: number[], cols: number, rows: number): number[];
