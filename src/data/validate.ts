/**
 * Strict validator for `CityData` (docs/data-format.md §Schema (v: 1)) and
 * `TileIndexData` (docs/data-format.md "Tiled datasets"). Pure: no
 * DOM/WebGL. Throws an `Error` naming the JSON-ish path of the first problem
 * found, e.g. `buildings[3].poly` or `roads[0].cls`.
 */
import type { CityData, TileIndexData, Vec2 } from './types';

const ROAD_CLASSES = new Set<string>([
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'service',
  'pedestrian',
  'footway',
]);

/** True when `v` is a finite number. */
function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** True when `v` is a `[x, z]` pair of finite numbers. */
function isFiniteVec2(v: unknown): v is Vec2 {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    isFiniteNum(v[0]) &&
    isFiniteNum(v[1])
  );
}

/**
 * Validate a closed footprint ring: ≥ 3 finite `[x, z]` points, first not repeated last.
 */
function validatePoly(poly: unknown, path: string): void {
  if (!Array.isArray(poly) || poly.length < 3) {
    throw new Error(`${path}: polygon must have at least 3 points`);
  }
  poly.forEach((pt, k) => {
    if (!isFiniteVec2(pt)) {
      throw new Error(`${path}: point ${k} must be a finite [x, z]`);
    }
  });
  const first = poly[0] as Vec2;
  const last = poly[poly.length - 1] as Vec2;
  if (first[0] === last[0] && first[1] === last[1]) {
    throw new Error(`${path}: first point must not repeat last`);
  }
}

/**
 * Validate a road centre-line polyline: ≥ 2 finite `[x, z]` points.
 */
function validatePts(pts: unknown, path: string): void {
  if (!Array.isArray(pts) || pts.length < 2) {
    throw new Error(`${path}: polyline must have at least 2 points`);
  }
  pts.forEach((pt, k) => {
    if (!isFiniteVec2(pt)) {
      throw new Error(`${path}: point ${k} must be a finite [x, z]`);
    }
  });
}

/**
 * Shared road-entry checks (validateCity and validateTileIndex): class, name,
 * bridge flag, centre-line and id. The caller enforces id uniqueness where
 * required (the monolithic file; bridgeRoads is a subset of it).
 */
function validateRoadShape(r: unknown, path: string): void {
  const road = r as Record<string, unknown>;
  const cls = road.cls;
  if (typeof cls !== 'string' || !ROAD_CLASSES.has(cls)) {
    throw new Error(`${path}.cls: unknown road class`);
  }
  if (road.name !== undefined && typeof road.name !== 'string') {
    throw new Error(`${path}.name: must be a string`);
  }
  if (road.bridge !== undefined && typeof road.bridge !== 'boolean') {
    throw new Error(`${path}.bridge: must be a boolean`);
  }
  validatePts(road.pts, `${path}.pts`);
  if (!isFiniteNum(road.id)) {
    throw new Error(`${path}.id: must be a finite number`);
  }
}

/** Shared place-entry checks (validateCity and validateTileIndex). */
function validatePlaceShape(p: unknown, path: string): void {
  const place = p as Record<string, unknown>;
  if (typeof place.name !== 'string' || place.name.length === 0) {
    throw new Error(`${path}.name: must be a non-empty string`);
  }
  if (!isFiniteNum(place.x)) {
    throw new Error(`${path}.x: must be a finite number`);
  }
  if (!isFiniteNum(place.z)) {
    throw new Error(`${path}.z: must be a finite number`);
  }
}

/** Validate an array of closed rings (water / woods). */
function validateRings(rings: unknown, path: string): void {
  if (!Array.isArray(rings)) {
    throw new Error(`${path}: expected an array`);
  }
  rings.forEach((ring, i) => {
    validatePoly(ring, `${path}[${i}]`);
  });
}

/** Validate an array of polylines (rivers). */
function validatePolylines(arr: unknown, path: string): void {
  if (!Array.isArray(arr)) {
    throw new Error(`${path}: expected an array`);
  }
  arr.forEach((polyline, i) => {
    validatePts(polyline, `${path}[${i}]`);
  });
}

/** Validate a terrain DEM height grid. */
function validateTerrain(t: unknown, path: string): void {
  const terrain = t as Record<string, unknown>;
  if (!isFiniteNum(terrain.x0)) {
    throw new Error(`${path}.x0: must be a finite number`);
  }
  if (!isFiniteNum(terrain.z0)) {
    throw new Error(`${path}.z0: must be a finite number`);
  }
  if (!isFiniteNum(terrain.step) || (terrain.step as number) <= 0) {
    throw new Error(`${path}.step: must be a positive number`);
  }
  if (!Number.isInteger(terrain.cols) || (terrain.cols as number) < 2) {
    throw new Error(`${path}.cols: must be an integer >= 2`);
  }
  if (!Number.isInteger(terrain.rows) || (terrain.rows as number) < 2) {
    throw new Error(`${path}.rows: must be an integer >= 2`);
  }
  if (!isFiniteNum(terrain.datum)) {
    throw new Error(`${path}.datum: must be a finite number`);
  }
  if (!Array.isArray(terrain.heights)) {
    throw new Error(`${path}.heights: must be an array`);
  }
  if (terrain.heights.length !== (terrain.cols as number) * (terrain.rows as number)) {
    throw new Error(`${path}.heights: must have cols*rows entries`);
  }
  terrain.heights.forEach((hv, i) => {
    if (!isFiniteNum(hv)) {
      throw new Error(`${path}.heights[${i}]: must be a finite number`);
    }
  });
}

/** Validate a waterLevels array against the (possibly absent) water array. */
function validateWaterLevels(levels: unknown, water: unknown, path: string): void {
  if (!Array.isArray(levels)) {
    throw new Error(`${path}: expected an array`);
  }
  const waterArr = Array.isArray(water) ? water : [];
  if (levels.length !== waterArr.length) {
    throw new Error(`${path}: must match the water array length`);
  }
  levels.forEach((wl, i) => {
    if (!isFiniteNum(wl)) {
      throw new Error(`${path}[${i}]: must be a finite number`);
    }
  });
}

/**
 * Validate an unknown value as `CityData`, returning the same object (typed)
 * when valid and throwing otherwise. `h` is in `[3, 650]`; optional `minH`
 * is a finite number in `[0, h - 1)`.
 */
export function validateCity(raw: unknown): CityData {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('city data: expected an object');
  }
  const city = raw as Record<string, unknown>;

  if (city.v !== 1) {
    throw new Error('v: schema version must be 1');
  }

  // origin
  const origin = city.origin;
  if (typeof origin !== 'object' || origin === null) {
    throw new Error('origin: expected an object');
  }
  const o = origin as Record<string, unknown>;
  if (!isFiniteNum(o.lat)) {
    throw new Error('origin.lat: must be a finite number');
  }
  if (!isFiniteNum(o.lon)) {
    throw new Error('origin.lon: must be a finite number');
  }

  // bbox: [minLon, minLat, maxLon, maxLat]
  const bbox = city.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error('bbox: expected [minLon, minLat, maxLon, maxLat]');
  }
  for (let i = 0; i < 4; i++) {
    if (!isFiniteNum(bbox[i])) {
      throw new Error(`bbox[${i}]: must be a finite number`);
    }
  }

  // buildings
  if (!Array.isArray(city.buildings)) {
    throw new Error('buildings: expected an array');
  }
  const buildingIds = new Set<number>();
  city.buildings.forEach((b, i) => {
    const building = b as Record<string, unknown>;
    if (!isFiniteNum(building.h) || building.h < 3 || building.h > 650) {
      throw new Error(`buildings[${i}].h: height must be in [3, 650]`);
    }
    if (building.minH !== undefined) {
      if (
        !isFiniteNum(building.minH) ||
        building.minH < 0 ||
        building.minH >= (building.h as number) - 1
      ) {
        throw new Error(`buildings[${i}].minH: must be a finite number in [0, h - 1)`);
      }
    }
    if (building.name !== undefined && typeof building.name !== 'string') {
      throw new Error(`buildings[${i}].name: must be a string`);
    }
    validatePoly(building.poly, `buildings[${i}].poly`);
    if (!isFiniteNum(building.id)) {
      throw new Error(`buildings[${i}].id: must be a finite number`);
    }
    if (buildingIds.has(building.id as number)) {
      throw new Error(`buildings[${i}].id: duplicate id`);
    }
    buildingIds.add(building.id as number);
  });

  // roads
  if (!Array.isArray(city.roads)) {
    throw new Error('roads: expected an array');
  }
  const roadIds = new Set<number>();
  city.roads.forEach((r, i) => {
    validateRoadShape(r, `roads[${i}]`);
    const id = (r as Record<string, unknown>).id as number;
    if (roadIds.has(id)) {
      throw new Error(`roads[${i}].id: duplicate id`);
    }
    roadIds.add(id);
  });

  // places
  if (!Array.isArray(city.places)) {
    throw new Error('places: expected an array');
  }
  city.places.forEach((p, i) => {
    validatePlaceShape(p, `places[${i}]`);
  });

  // water (optional)
  if (city.water !== undefined) {
    validateRings(city.water, 'water');
  }

  // rivers (optional) — boat centre-line polylines, >= 2 finite points each.
  if (city.rivers !== undefined) {
    validatePolylines(city.rivers, 'rivers');
  }

  // trees (optional) — `[x, z, h, r]` quads (data-format.md §Trees).
  if (city.trees !== undefined) {
    if (!Array.isArray(city.trees)) {
      throw new Error('trees: expected an array');
    }
    city.trees.forEach((t, i) => {
      if (
        !Array.isArray(t) ||
        t.length !== 4 ||
        !isFiniteNum(t[0]) ||
        !isFiniteNum(t[1]) ||
        !isFiniteNum(t[2]) ||
        !isFiniteNum(t[3]) ||
        t[2] < 3 ||
        t[2] > 40 ||
        t[3] < 1 ||
        t[3] > 15
      ) {
        throw new Error(`trees[${i}]: expected finite [x, z, h, r] with 3 ≤ h ≤ 40, 1 ≤ r ≤ 15`);
      }
    });
  }

  // woods (optional) — woodland/park rings, same rules as water.
  if (city.woods !== undefined) {
    validateRings(city.woods, 'woods');
  }

  // terrain (optional) — regular DEM height grid.
  if (city.terrain !== undefined) {
    validateTerrain(city.terrain, 'terrain');
  }

  // waterLevels (optional) — one finite surface height per water ring.
  if (city.waterLevels !== undefined) {
    validateWaterLevels(city.waterLevels, city.water, 'waterLevels');
  }

  return raw as CityData;
}

/**
 * Validate an unknown value as a `TileIndexData` (docs/data-format.md
 * "Tiled datasets" rule 7), returning the same object (typed) when valid and
 * throwing otherwise. Enforces the `tiled: true` discriminant, a positive
 * `tileSize`, present `bridgeRoads` / `landmarks` / `places`, tile keys
 * matching `/-?\d+_-?\d+/` and per-tile `TileStat` fields. Tile FILES get
 * only a light shape check at load time — they are machine-generated from
 * already-validated input (rule 7), so re-validating them here is skipped.
 */
export function validateTileIndex(raw: unknown): TileIndexData {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('tile index: expected an object');
  }
  const idx = raw as Record<string, unknown>;

  if (idx.v !== 1) {
    throw new Error('v: schema version must be 1');
  }
  if (idx.tiled !== true) {
    throw new Error('tiled: must be true');
  }

  // origin
  const origin = idx.origin;
  if (typeof origin !== 'object' || origin === null) {
    throw new Error('origin: expected an object');
  }
  const o = origin as Record<string, unknown>;
  if (!isFiniteNum(o.lat)) {
    throw new Error('origin.lat: must be a finite number');
  }
  if (!isFiniteNum(o.lon)) {
    throw new Error('origin.lon: must be a finite number');
  }

  // bbox: [minLon, minLat, maxLon, maxLat]
  const bbox = idx.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error('bbox: expected [minLon, minLat, maxLon, maxLat]');
  }
  for (let i = 0; i < 4; i++) {
    if (!isFiniteNum(bbox[i])) {
      throw new Error(`bbox[${i}]: must be a finite number`);
    }
  }

  // tileSize: metres per tile edge
  if (!isFiniteNum(idx.tileSize) || (idx.tileSize as number) <= 0) {
    throw new Error('tileSize: must be a positive number');
  }

  // bridgeRoads (rule 3) — global, whole polylines; a subset of the input
  // road set, so id uniqueness is inherited from the validated source.
  if (!Array.isArray(idx.bridgeRoads)) {
    throw new Error('bridgeRoads: expected an array');
  }
  idx.bridgeRoads.forEach((r, i) => {
    validateRoadShape(r, `bridgeRoads[${i}]`);
  });

  // landmarks (rule 4) — anchor of a named building.
  if (!Array.isArray(idx.landmarks)) {
    throw new Error('landmarks: expected an array');
  }
  idx.landmarks.forEach((l, i) => {
    const lm = l as Record<string, unknown>;
    if (typeof lm.name !== 'string' || lm.name.length === 0) {
      throw new Error(`landmarks[${i}].name: must be a non-empty string`);
    }
    if (!isFiniteNum(lm.x)) {
      throw new Error(`landmarks[${i}].x: must be a finite number`);
    }
    if (!isFiniteNum(lm.z)) {
      throw new Error(`landmarks[${i}].z: must be a finite number`);
    }
  });

  // places (rule 5) — global.
  if (!Array.isArray(idx.places)) {
    throw new Error('places: expected an array');
  }
  idx.places.forEach((p, i) => {
    validatePlaceShape(p, `places[${i}]`);
  });

  // tiles (rule 6) — non-empty tiles only, keyed "i_j", per-tile stats.
  if (typeof idx.tiles !== 'object' || idx.tiles === null || Array.isArray(idx.tiles)) {
    throw new Error('tiles: expected an object of tile stats');
  }
  const tiles = idx.tiles as Record<string, unknown>;
  for (const key of Object.keys(tiles)) {
    if (!/^-?\d+_-?\d+$/.test(key)) {
      throw new Error(`tiles: bad tile key "${key}"`);
    }
    const st = tiles[key] as Record<string, unknown>;
    for (const field of ['buildings', 'roads', 'trees', 'bytes'] as const) {
      const v = st[field];
      if (!isFiniteNum(v) || v < 0 || !Number.isInteger(v)) {
        throw new Error(`tiles["${key}"].${field}: must be a non-negative integer`);
      }
    }
  }

  // Optional globals — same rules as the monolithic `CityData`.
  if (idx.terrain !== undefined) {
    validateTerrain(idx.terrain, 'terrain');
  }
  if (idx.water !== undefined) {
    validateRings(idx.water, 'water');
  }
  if (idx.waterLevels !== undefined) {
    validateWaterLevels(idx.waterLevels, idx.water, 'waterLevels');
  }
  if (idx.rivers !== undefined) {
    validatePolylines(idx.rivers, 'rivers');
  }

  return raw as TileIndexData;
}
