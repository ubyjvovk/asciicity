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
}
