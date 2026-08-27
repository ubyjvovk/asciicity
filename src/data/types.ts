/**
 * City data model — the contract between `public/data/city.json`, the OSM
 * fetch script, the synthetic generator, and every world builder.
 *
 * Coordinates are LOCAL METRES relative to `origin`:
 *   x = east (+) / west (-),  z = south (+) / north (-),  y = up (three.js).
 * See docs/data-format.md for the schema and docs/architecture.md for the
 * coordinate system. PM-owned: do not change shapes without a ticket that
 * says so explicitly.
 */

/** `[x, z]` in local metres. */
export type Vec2 = [number, number];

/**
 * Ground-height sampler in local metres: `y` of the walkable ground at
 * `(x, z)`. Every world builder takes one so geometry can be draped over
 * terrain; the default `FLAT_HEIGHT` reproduces the flat `y = 0` world.
 * Added 2026-08-26 (wave 5, terrain).
 */
export type HeightFn = (x: number, z: number) => number;

/** The flat world: ground is `y = 0` everywhere (London, synthetic city). */
export const FLAT_HEIGHT: HeightFn = () => 0;

/**
 * Regular height grid (a DEM sample) in local metres, relative to `datum`.
 * Node `(c, r)` sits at `(x0 + c·step, z0 + r·step)` — row 0 is the NORTH
 * edge (smallest z), column 0 the west edge — and its height is
 * `heights[r * cols + c]`. Heights are metres above the origin's own ground
 * (`datum` metres above sea level), rounded to 0.1 m. Producers cover the
 * bbox plus one cell of margin on every side. Added 2026-08-26 (wave 5).
 */
export interface TerrainData {
  x0: number;
  z0: number;
  /** Metres between grid nodes (20 for the shipped datasets). */
  step: number;
  /** Nodes per row (≥ 2). */
  cols: number;
  /** Rows (≥ 2). */
  rows: number;
  /** Metres above sea level of height 0 (the DEM elevation at `origin`). */
  datum: number;
  /** `rows * cols` finite numbers, row-major. */
  heights: number[];
}

export type RoadClass =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'pedestrian'
  | 'footway';

export interface Building {
  /** OSM way/relation id, or a synthetic id. Unique within the file. */
  id: number;
  /** Height in metres (roof, flat). Clamped to [3, 320] by producers. */
  h: number;
  /** OSM `name` when present — named buildings render as landmarks. */
  name?: string;
  /** Landmark silhouette cap set by `applyLandmarks` (architecture §4.13, wave 7). Absent = flat roof. */
  shape?: 'dome' | 'spire' | 'tower';
  /**
   * Footprint ring in local metres, >= 3 points, first point NOT repeated at
   * the end. Winding is unspecified; consumers normalise it.
   */
  poly: Vec2[];
}

export interface Road {
  id: number;
  name?: string;
  cls: RoadClass;
  /** True when the OSM way carries a `bridge` tag (walkable over water). Added 2026-08-24 (T-0030). */
  bridge?: boolean;
  /** Centre-line polyline in local metres, >= 2 points. */
  pts: Vec2[];
}

export interface Place {
  /** Display name, e.g. "Bank", "Liverpool Street", "St Paul's Cathedral". */
  name: string;
  x: number;
  z: number;
}

export interface CityData {
  /** Schema version. Always 1 for now. */
  v: 1;
  origin: { lat: number; lon: number };
  /** `[minLon, minLat, maxLon, maxLat]` of the source query (WGS84). */
  bbox: [number, number, number, number];
  buildings: Building[];
  roads: Road[];
  places: Place[];
  /**
   * Optional water polygons (the Thames, docks) as rings in local metres —
   * same ring rules as `Building.poly` (≥ 3 points, first not repeated).
   * Absent or empty when the producer has none. Added 2026-08-24 (T-0023).
   */
  water?: Vec2[][];
  /**
   * Optional river centre-lines (OSM `waterway=river`) as polylines in local
   * metres — boat paths. Absent when the producer has none. Added 2026-08-24 (T-0036).
   */
  rivers?: Vec2[][];
  /**
   * Optional height grid. Absent → the world is flat (`y = 0`). When present
   * every builder drapes geometry over it via a `HeightFn` (architecture.md
   * §4.9). Added 2026-08-26 (wave 5).
   */
  terrain?: TerrainData;
  /**
   * Optional water surface heights, one per `water[]` ring (same order and
   * length), metres relative to `terrain.datum`. Absent → every ring is at
   * 0. Producers flatten the terrain nodes inside each ring to its level.
   * Added 2026-08-26 (wave 5).
   */
  waterLevels?: number[];
}
