/**
 * Strict validator for `CityData` (docs/data-format.md §Schema (v: 1)).
 * Pure: no DOM/WebGL. Throws an `Error` naming the JSON-ish path of the first
 * problem found, e.g. `buildings[3].poly` or `roads[0].cls`.
 */
import type { CityData, Vec2 } from './types';

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
 * Validate an unknown value as `CityData`, returning the same object (typed)
 * when valid and throwing otherwise.
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
    if (!isFiniteNum(building.h) || building.h < 3 || building.h > 320) {
      throw new Error(`buildings[${i}].h: height must be in [3, 320]`);
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
    const road = r as Record<string, unknown>;
    const cls = road.cls;
    if (typeof cls !== 'string' || !ROAD_CLASSES.has(cls)) {
      throw new Error(`roads[${i}].cls: unknown road class`);
    }
    if (road.name !== undefined && typeof road.name !== 'string') {
      throw new Error(`roads[${i}].name: must be a string`);
    }
    validatePts(road.pts, `roads[${i}].pts`);
    if (!isFiniteNum(road.id)) {
      throw new Error(`roads[${i}].id: must be a finite number`);
    }
    if (roadIds.has(road.id as number)) {
      throw new Error(`roads[${i}].id: duplicate id`);
    }
    roadIds.add(road.id as number);
  });

  // places
  if (!Array.isArray(city.places)) {
    throw new Error('places: expected an array');
  }
  city.places.forEach((p, i) => {
    const place = p as Record<string, unknown>;
    if (typeof place.name !== 'string' || place.name.length === 0) {
      throw new Error(`places[${i}].name: must be a non-empty string`);
    }
    if (!isFiniteNum(place.x)) {
      throw new Error(`places[${i}].x: must be a finite number`);
    }
    if (!isFiniteNum(place.z)) {
      throw new Error(`places[${i}].z: must be a finite number`);
    }
  });

  return raw as CityData;
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
