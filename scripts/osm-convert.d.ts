/**
 * Type declarations for `scripts/osm-convert.mjs`, so the vitest test and
 * `tsc --noEmit` (scripts/check.sh) can import the JS module without
 * `allowJs`. The `.mjs` runtime is authoritative; this file only narrows the
 * shapes (mirroring `src/data/types.ts` via `import type`).
 */

import type { CityData, RoadClass } from '../src/data/types';

/** WGS84 point used as the projection origin. */
type Origin = { lat: number; lon: number };
type Bbox = [number, number, number, number];

export function project(
  lon: number,
  lat: number,
  origin: Origin,
): [number, number];

export function round1(v: number): number;

export function roadClassOf(highway: string): RoadClass | null;

export function heightOf(tags: Record<string, string>): number;

export function convertOverpass(
  json: { elements: unknown[] },
  opts: { origin: Origin; bbox?: Bbox },
): CityData & { skippedRelations?: number };
