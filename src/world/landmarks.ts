/**
 * Landmark fixes (docs/architecture.md §4.13): a PM-curated table of exact
 * OSM-name height/colour/shape overrides and extra synthetic buildings,
 * applied to the loaded `CityData` before anything is built. OSM gives
 * Kyiv's landmarks unusable stub heights (Saint Sophia 3 m, Great Lavra
 * Belltower 8 m, the Arch 3 m) and no Motherland Monument, so this module
 * corrects them at load. Pure: no DOM/WebGL.
 */
import type { CityData, Vec2 } from '../data/types';
import { project } from '../geo';
import { registerLandmarkColors } from './palette';

/** A single overridable landmark property. Omit any to leave it unchanged. */
export interface LandmarkFix {
  /** Replacement height in metres. */
  h?: number;
  /** Replacement hex colour (registered for `colorFor`). */
  color?: number;
  /** Silhouette cap (architecture §4.13): dome / spire / tower. */
  shape?: 'dome' | 'spire' | 'tower';
  /** Floating tag label (architecture §4.13); default is the OSM name. */
  label?: string;
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
  /** Silhouette cap; omit for a flat roof (architecture §4.13). */
  shape?: 'dome' | 'spire' | 'tower';
}

/**
 * Per-city map of exact OSM `name` → override. Heights are real-world metres;
 * colours feed `registerLandmarkColors`. Shapes (architecture §4.13) add a
 * silhouette cap. Empty table = unchanged.
 */
export const LANDMARK_FIXES: Readonly<Record<string, Readonly<Record<string, LandmarkFix>>>> = {
  kyiv: {
    'Saint Sophia Cathedral': { h: 29, color: 0xf7dc6f, shape: 'dome' },
    'Bell tower': { h: 76, color: 0xf7dc6f, shape: 'spire' },
    'St. Michael Golden-Domed Cathedral': { h: 40, color: 0xf7dc6f, shape: 'dome' },
    "Saint Andrew's Church": { h: 50, color: 0xf7dc6f, shape: 'spire' },
    'Great Lavra Belltower': { h: 96, color: 0xf7dc6f, shape: 'spire' },
    "Near Cave's Belltower": { h: 27, color: 0xf7dc6f, shape: 'spire' },
    'Bell Tower of Far Caves': { h: 41, color: 0xf7dc6f, shape: 'spire' },
    'Golden Gate': { h: 16, color: 0xe8e0c8 },
    'Arch of Freedom of the Ukrainian people': { h: 35, color: 0xe8e0c8 },
    'Verkhovna Rada of Ukraine': { h: 30, color: 0xe8e0c8 },
    "St. Volodymyr's Cathedral": { h: 49, color: 0xe8e0c8, shape: 'dome' },
    'St. Nicholas Cathedral': { color: 0xe8e0c8, shape: 'dome' },
  },
  london: {
    "St Paul's Cathedral": { shape: 'dome' },
    'Elizabeth Tower': { shape: 'spire' },
    // OSM maps the column as its 338 m² plinth at the default 14 m.
    "Nelson's Column": { h: 6, color: 0xe8e0c8, label: 'Trafalgar Square' },
  },
  sf: {
    // SF downtown is well-tagged (checked against the fetched sf.json):
    // Transamerica 260 and Salesforce 320 already match the real heights,
    // so only Coit Tower (h 64 right, wrong colour) needs a fix.
    'Coit Tower': { color: 0xf5f0e6 },
  },
};

/** Per-city extra synthetic buildings appended at load. */
export const EXTRA_BUILDINGS: Readonly<Record<string, readonly ExtraBuilding[]>> = {
  kyiv: [
    {
      name: 'Motherland Monument',
      lon: 30.5632,
      lat: 50.4266,
      h: 102,
      size: 20,
      color: 0xc0c0c0,
      shape: 'tower',
    },
  ],
  london: [
    {
      name: "Nelson's Column",
      lon: -0.12793,
      lat: 51.50776,
      h: 52,
      size: 5,
      color: 0xe8e0c8,
    },
  ],
  sf: [
    {
      name: 'Ferry Building Clock Tower',
      lon: -122.393378,
      lat: 37.79554,
      h: 75,
      size: 14,
      color: 0xf5f0e6,
      shape: 'tower',
    },
  ],
};

/**
 * Apply landmark fixes and extras to a `CityData`, returning a new object.
 * Heights/shapes are replaced by exact name match on OSM buildings (extras
 * with id ≤ −1000 keep the properties they were created with); colours are
 * registered via `registerLandmarkColors` so `colorFor` picks them up at
 * build; extras with ids −1000, −1001, … get a 4-point square footprint
 * projected via `src/geo.ts`. Idempotent: an extra already present (same
 * name and id ≤ −1000) is not re-appended, even if an OSM building shares
 * the name. Synthetic/unknown ids, or ids with empty tables, return the
 * input unchanged.
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

  // Apply height/shape overrides by exact OSM name. Extras keep the h/shape
  // they were created with, even when they share an OSM name (Nelson's
  // Column is both a 6 m plinth and a 52 m extra).
  const buildings = city.buildings.map((b) => {
    if (b.id <= -1000) return b;
    const fix = b.name !== undefined ? fixes[b.name] : undefined;
    if (fix === undefined) return b;
    const { h = b.h, shape = b.shape } = fix;
    if (h !== b.h || shape !== b.shape) {
      return { ...b, h, shape };
    }
    return b;
  });

  // Append extras, skipping any extra already present (idempotency). An OSM
  // building of the same name does not block the extra.
  const existingExtras = new Set(
    buildings.filter((b) => b.id <= -1000).map((b) => b.name),
  );
  let extraIndex = 0;
  for (const ex of extras) {
    if (existingExtras.has(ex.name)) continue;
    const [cx, cz] = project(ex.lon, ex.lat, city.origin);
    const half = ex.size / 2;
    const poly: Vec2[] = [
      [cx - half, cz - half],
      [cx + half, cz - half],
      [cx + half, cz + half],
      [cx - half, cz + half],
    ];
    buildings.push({
      id: -1000 - extraIndex,
      name: ex.name,
      h: ex.h,
      poly,
      ...(ex.shape !== undefined ? { shape: ex.shape } : {}),
    });
    existingExtras.add(ex.name);
    extraIndex++;
  }

  return { ...city, buildings };
}
