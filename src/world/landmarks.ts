/**
 * Landmark fixes (docs/architecture.md §4.13): a PM-curated table of exact
 * OSM-name height/colour overrides and extra synthetic buildings, applied to
 * the loaded `CityData` before anything is built. OSM gives Kyiv's landmarks
 * unusable stub heights (Saint Sophia 3 m, Great Lavra Belltower 8 m, the
 * Arch 3 m) and no Motherland Monument, so this module corrects them at load.
 * Pure: no DOM/WebGL.
 */
import type { CityData, Vec2 } from '../data/types';
import { project } from '../geo';
import { registerLandmarkColors } from './palette';

/** A single overridable landmark property. Omit either to leave it unchanged. */
export interface LandmarkFix {
  /** Replacement height in metres. */
  h?: number;
  /** Replacement hex colour (registered for `colorFor`). */
  color?: number;
}

/** A synthetic building to append: a square footprint of side `size` centred on `(lon, lat)`. */
export interface ExtraBuilding {
  /** Display name (also registered as a colour). */
  name: string;
  lon: number;
  lat: number;
  /** Building height in metres. */
  h: number;
  /** Square footprint side, metres. */
  size: number;
  /** Hex colour. */
  color: number;
}

/**
 * Per-city map of exact OSM `name` → override. Heights are real-world metres;
 * colours feed `registerLandmarkColors`. London is empty (unchanged).
 */
export const LANDMARK_FIXES: Readonly<Record<string, Readonly<Record<string, LandmarkFix>>>> = {
  kyiv: {
    'Saint Sophia Cathedral': { h: 29, color: 0xf7dc6f },
    'Bell tower': { h: 76, color: 0xf7dc6f },
    'St. Michael Golden-Domed Cathedral': { h: 40, color: 0xf7dc6f },
    "Saint Andrew's Church": { h: 50, color: 0xf7dc6f },
    'Great Lavra Belltower': { h: 96, color: 0xf7dc6f },
    "Near Cave's Belltower": { h: 27, color: 0xf7dc6f },
    'Bell Tower of Far Caves': { h: 41, color: 0xf7dc6f },
    'Golden Gate': { h: 16, color: 0xe8e0c8 },
    'Arch of Freedom of the Ukrainian people': { h: 35, color: 0xe8e0c8 },
    'Verkhovna Rada of Ukraine': { h: 30, color: 0xe8e0c8 },
    "St. Volodymyr's Cathedral": { h: 49, color: 0xe8e0c8 },
    'St. Nicholas Cathedral': { color: 0xe8e0c8 },
  },
  london: {},
};

/** Per-city extra synthetic buildings appended at load (London: none). */
export const EXTRA_BUILDINGS: Readonly<Record<string, readonly ExtraBuilding[]>> = {
  kyiv: [
    {
      name: 'Motherland Monument',
      lon: 30.5632,
      lat: 50.4266,
      h: 102,
      size: 20,
      color: 0xc0c0c0,
    },
  ],
  london: [],
};

/**
 * Apply landmark fixes and extras to a `CityData`, returning a new object.
 * Heights are replaced by exact name match; colours are registered via
 * `registerLandmarkColors` so `colorFor` picks them up at build; extras with
 * ids −1000, −1001, … get a 4-point square footprint projected via
 * `src/geo.ts`. Idempotent: an extra already present is not re-appended.
 * Synthetic/unknown ids, or ids with empty tables, return the input unchanged.
 */
export function applyLandmarks(city: CityData, cityId: string): CityData {
  const fixes = LANDMARK_FIXES[cityId];
  const extras = EXTRA_BUILDINGS[cityId];

  // Register colours from both the fixes and the extras so building meshes
  // (colorFor) pick them up. Registered map stays empty for no-op cities.
  const colorMap: Record<string, number> = {};
  if (fixes) {
    for (const [name, fix] of Object.entries(fixes)) {
      if (fix.color !== undefined) colorMap[name] = fix.color;
    }
  }
  if (extras) {
    for (const ex of extras) colorMap[ex.name] = ex.color;
  }
  if (Object.keys(colorMap).length > 0) registerLandmarkColors(colorMap);

  // No fixes and no extras for this city (synthetic/unknown) → unchanged.
  if (
    fixes === undefined ||
    extras === undefined ||
    (Object.keys(fixes).length === 0 && extras.length === 0)
  ) {
    return city;
  }

  // Apply height overrides by exact OSM name.
  const buildings = city.buildings.map((b) => {
    const fix = b.name !== undefined ? fixes[b.name] : undefined;
    if (fix && fix.h !== undefined && b.h !== fix.h) {
      return { ...b, h: fix.h };
    }
    return b;
  });

  // Append extras, skipping any whose name already exists (idempotency).
  const existing = new Set(buildings.map((b) => b.name));
  let extraIndex = 0;
  for (const ex of extras) {
    if (existing.has(ex.name)) continue;
    const [cx, cz] = project(ex.lon, ex.lat, city.origin);
    const half = ex.size / 2;
    const poly: Vec2[] = [
      [cx - half, cz - half],
      [cx + half, cz - half],
      [cx + half, cz + half],
      [cx - half, cz + half],
    ];
    buildings.push({ id: -1000 - extraIndex, name: ex.name, h: ex.h, poly });
    existing.add(ex.name);
    extraIndex++;
  }

  return { ...city, buildings };
}
