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
  /** Height in metres (roof, flat). Clamped to [3, 650] by producers (wave 10 supertalls; 650 since wave 11 — Tokyo Skytree is 634 m). */
  h: number;
  /**
   * Base height in metres for a `building:part` that starts above the ground
   * (OSM `min_height` / `building:min_level`; wave 10, data-format "Building
   * parts"). Absent or 0 = grounded. Walls run from `minH` to `h`; parts with
   * `minH >= 2.5` do not block the player (you walk under them).
   */
  minH?: number;
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
   * Optional trees as flat quads `[x, z, h, r]` — trunk base in local metres,
   * total height `h` (m), canopy radius `r` (m). Produced by the converter
   * from OSM tree nodes/rows and wood/park fills (data-format.md §Trees).
   * Absent or empty when the producer has none. Added 2026-08-27 (wave 7).
   */
  trees?: [number, number, number, number][];
  /**
   * Optional woodland/park rings (same ring rules as `water`) — the minimap
   * paints them; the 3D world uses `trees`. Added 2026-08-27 (wave 7).
   */
  woods?: Vec2[][];
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

/*
 * ── Tiled datasets (wave 11, sector streaming) ───────────────────────────
 * Large cities ship as `public/data/<city>/index.json` (globals, below) plus
 * one `tiles/<i>_<j>.json` per non-empty 1000-m tile. Format contract:
 * docs/data-format.md "Tiled datasets"; runtime: docs/architecture.md §4.19.
 */

/** Per-tile entry in `TileIndexData.tiles`: element counts + the tile file's byte length (loading-bar denominator). */
export interface TileStat {
  buildings: number;
  roads: number;
  trees: number;
  bytes: number;
}

/**
 * Anchor of a named building (footprint centroid, local metres) so spawn
 * presets and fast travel resolve before any tile is loaded. Order = tile
 * scan order; consumers take the FIRST entry for a name.
 */
export interface LandmarkEntry {
  name: string;
  x: number;
  z: number;
}

/**
 * `index.json` of a tiled city. Carries everything global (terrain, water,
 * rivers, bridge roads, places, landmark anchors) plus the tile directory.
 * Tile `(i, j)` covers `x ∈ [i·tileSize, (i+1)·tileSize)`,
 * `z ∈ [j·tileSize, (j+1)·tileSize)` in local metres — `i = floor(x /
 * tileSize)`, `j = floor(z / tileSize)`, negative indices allowed; the key
 * is `"i_j"` (e.g. `"-3_2"`).
 */
export interface TileIndexData {
  v: 1;
  /** Discriminant against a monolithic `CityData` file. */
  tiled: true;
  origin: { lat: number; lon: number };
  /** `[minLon, minLat, maxLon, maxLat]` of the source query (WGS84). */
  bbox: [number, number, number, number];
  /** Metres per tile edge (1000 for shipped datasets). */
  tileSize: number;
  /**
   * Every road whose `bridge` is truthy — global, whole polylines, NEVER
   * split at tile edges: bridge chaining (§4.9), `BridgeDecks` and
   * `groundAt` are built once from this list so decks never pop in or out.
   */
  bridgeRoads: Road[];
  /** Anchors of every named building (see `LandmarkEntry`). */
  landmarks: LandmarkEntry[];
  /** ALL places, global (small; zone naming and spawn need them at boot). */
  places: Place[];
  /** Non-empty tiles only, keyed `"i_j"`. */
  tiles: Record<string, TileStat>;
  terrain?: TerrainData;
  water?: Vec2[][];
  waterLevels?: number[];
  rivers?: Vec2[][];
}

/** One `tiles/<i>_<j>.json` file. Element schemas are exactly `CityData`'s. */
export interface TileData {
  v: 1;
  buildings: Building[];
  roads: Road[];
  trees?: [number, number, number, number][];
  woods?: Vec2[][];
}
