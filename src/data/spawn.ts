/**
 * Spawn presets and coordinates for `?at=` (docs/integration.md §URL
 * parameters). Pure module: resolves an `?at=` value to a local-metre
 * spawn point, projecting WGS84 presets/coordinates relative to the city
 * origin, and resolving named-building presets against the dataset via
 * `landmarkSpawn`. No DOM/WebGL.
 */
import type { CityData, Vec2 } from './types';
import { project } from '../geo';

/** Resolved spawn pose in local metres: `x` east, `z` south, yaw in radians. */
export interface SpawnPoint {
  x: number;
  z: number;
  yaw: number;
}

/**
 * A named spawn preset scoped to a single city. Either a fixed WGS84 position
 * facing `bearingDeg`, or a named building matched against the dataset
 * (`{ building }`) — the building form may carry its own fallback coordinate
 * used when the building is absent from the current dataset.
 */
export type SpawnPreset =
  | { building: string; label: string; city: 'london' | 'kyiv' | 'sf'; lon?: number; lat?: number; bearingDeg?: number }
  | { lon: number; lat: number; bearingDeg: number; label: string; city: 'london' | 'kyiv' | 'sf' };

/** Named spawn presets keyed by lower-case name (used by `?at=<name>`). */
export const SPAWN_PRESETS: Record<string, SpawnPreset> = {
  bank: { lon: -0.0887, lat: 51.5133, bearingDeg: 270, label: 'Bank junction', city: 'london' },
  // Named-building presets: `landmarkSpawn` finds the building and picks a
  // road vertex scaled by the building's height, facing it.
  stpauls: { building: "St Paul's Cathedral", label: "Facing St Paul's Cathedral", city: 'london' },
  gherkin: { building: '30 St Mary Axe', label: 'Facing the Gherkin', city: 'london' },
  monument: { building: 'Monument', label: 'Facing the Monument', city: 'london' },
  tower: { building: 'Tower of London', label: 'Facing the Tower of London', city: 'london' },
  barbican: { building: 'Barbican', label: 'Facing the Barbican', city: 'london' },
  liverpoolst: { building: 'Liverpool Street', label: 'Facing Liverpool Street', city: 'london' },
  leadenhall: { building: 'Leadenhall Market', label: 'Facing Leadenhall Market', city: 'london' },
  walkietalkie: {
    building: '20 Fenchurch Street',
    label: 'Facing the Walkie Talkie',
    city: 'london',
  },
  lloyds: { building: "Lloyd's", label: "Facing Lloyd's", city: 'london' },
  // Fixed coordinate presets (places, not resolvable single buildings).
  bigben: {
    lon: -0.12235,
    lat: 51.50085,
    bearingDeg: 268,
    label: 'Westminster Bridge, facing Big Ben',
    city: 'london',
  },
  parliament: {
    lon: -0.12655,
    lat: 51.5006,
    bearingDeg: 90,
    label: 'Parliament Square, facing the Palace of Westminster',
    city: 'london',
  },
  trafalgar: {
    building: "Nelson's Column",
    city: 'london',
    label: "Trafalgar Square, facing Nelson's Column",
    lon: -0.128,
    lat: 51.5079,
    bearingDeg: 180,
  },
  embankment: {
    lon: -0.122,
    lat: 51.5074,
    bearingDeg: 120,
    label: 'Victoria Embankment, facing the London Eye',
    city: 'london',
  },
  // Kyiv presets (wave 7, docs/integration.md §Kyiv presets). Building
  // presets resolve against `applyLandmarks(kyiv.json)` and keep their
  // previous coordinates as fallback when the name goes missing upstream.
  maidan: {
    lon: 30.524,
    lat: 50.45,
    bearingDeg: 250,
    label: 'Maidan Nezalezhnosti, facing Hotel Ukraina',
    city: 'kyiv',
  },
  sophia: {
    building: 'Saint Sophia Cathedral',
    label: 'Facing Saint Sophia Cathedral',
    city: 'kyiv',
    lon: 30.5165,
    lat: 50.453,
    bearingDeg: 270,
  },
  michael: {
    building: 'St. Michael Golden-Domed Cathedral',
    label: "Facing St. Michael's Golden-Domed Cathedral",
    city: 'kyiv',
    lon: 30.521,
    lat: 50.4553,
    bearingDeg: 60,
  },
  andriyivskyy: {
    building: "Saint Andrew's Church",
    label: "Top of Andriyivskyy Descent, facing St Andrew's Church",
    city: 'kyiv',
    lon: 30.5165,
    lat: 50.4586,
    bearingDeg: 40,
  },
  lavra: {
    building: 'Great Lavra Belltower',
    label: 'Pechersk Lavra, facing the Great Bell Tower',
    city: 'kyiv',
    lon: 30.556,
    lat: 50.435,
    bearingDeg: 100,
  },
  motherland: {
    building: 'Motherland Monument',
    label: 'Facing the Motherland Monument',
    city: 'kyiv',
    lon: 30.561,
    lat: 50.4275,
    bearingDeg: 135,
  },
  goldengate: {
    building: 'Golden Gate',
    label: 'Facing the Golden Gate',
    city: 'kyiv',
    lon: 30.5133,
    lat: 50.4485,
    bearingDeg: 20,
  },
  rada: {
    building: 'Verkhovna Rada of Ukraine',
    label: 'Facing the Verkhovna Rada of Ukraine',
    city: 'kyiv',
    lon: 30.5373,
    lat: 50.4471,
    bearingDeg: 260,
  },
  volodymyr: {
    building: "St. Volodymyr's Cathedral",
    label: "Facing St. Volodymyr's Cathedral",
    city: 'kyiv',
    lon: 30.5085,
    lat: 50.4449,
    bearingDeg: 180,
  },
  arch: {
    building: 'Arch of Freedom of the Ukrainian people',
    label: 'Facing the Arch of Freedom',
    city: 'kyiv',
    lon: 30.5304,
    lat: 50.4549,
    bearingDeg: 250,
  },
  olimpiyskiy: {
    building: 'Olympic National Sports Complex Stadium',
    label: 'Facing the Olympic Stadium',
    city: 'kyiv',
    lon: 30.5168,
    lat: 50.4333,
    bearingDeg: 100,
  },
  nicholas: {
    building: 'St. Nicholas Cathedral',
    label: 'Facing St. Nicholas Cathedral',
    city: 'kyiv',
    lon: 30.5176,
    lat: 50.4257,
    bearingDeg: 180,
  },
  bessarabka: {
    building: 'Bessarabskyi market',
    label: 'Bessarabska Square, looking down Khreshchatyk',
    city: 'kyiv',
    lon: 30.5209,
    lat: 50.442,
    bearingDeg: 0,
  },
  podil: {
    lon: 30.517,
    lat: 50.465,
    bearingDeg: 180,
    label: 'Kontraktova Square, Podil',
    city: 'kyiv',
  },
  arsenalna: {
    lon: 30.5455,
    lat: 50.4443,
    bearingDeg: 90,
    label: 'Arsenalna, the deepest metro station',
    city: 'kyiv',
  },
  parkbridge: {
    lon: 30.5324,
    lat: 50.45498,
    bearingDeg: 33,
    label: 'Parkovyi Bridge, facing Trukhaniv Island',
    city: 'kyiv',
  },
  glassbridge: {
    lon: 30.52974,
    lat: 50.45489,
    bearingDeg: 286,
    label: 'Klitschko glass bridge, facing the Arch',
    city: 'kyiv',
  },
  funicular: {
    lon: 30.5231,
    lat: 50.4592,
    bearingDeg: 210,
    label: 'Funicular lower station, looking up',
    city: 'kyiv',
  },
  hydropark: {
    lon: 30.577,
    lat: 50.4459,
    bearingDeg: 270,
    label: 'Hydropark, facing the right-bank hills',
    city: 'kyiv',
  },
  metrobridge: {
    lon: 30.56,
    lat: 50.4423,
    bearingDeg: 90,
    label: 'Metro Bridge over the Dnipro',
    city: 'kyiv',
  },
  // San Francisco presets (wave 8, docs/integration.md §San Francisco
  // presets). Building presets resolve against `applyLandmarks(sf.json)` and
  // keep their fallback coordinates when a name goes missing upstream.
  ggb: {
    // Wave 9 (architecture.md §4.13 (c)): re-aimed at the east sidewalk
    // 260 m south of the south tower (snapped onto the East Sidewalk line,
    // as the previous mid-span preset was), facing north along the deck at
    // the south tower.
    lon: -122.477472,
    lat: 37.811672,
    bearingDeg: 355,
    label: 'Golden Gate Bridge deck, facing the south tower',
    city: 'sf',
  },
  alcatraz: {
    // Fixed-coordinate preset ON the island beside the lighthouse (parity
    // rule, §4.6 makes the island walkable), bearing 150° toward the city.
    // NOTE (T-0079 reconciliation): the PM's spec was a *building* preset
    // on 'Alcatraz Island Lighthouse'. On this data that resolves via
    // `landmarkSpawn` to the island's low shore road (the lighthouse's
    // view-corridor rule rejects high ground near it, leaving only low
    // road vertices), giving y ≈ −2.4 — below the mandated e2e y > 5.
    // The PM's own fallback coordinate (below) resolves to y ≈ 16.9 (≈ the
    // PM's "lighthouse ~40 m ASL → y ≈ 15"), so we use it as a fixed
    // coordinate preset. See the Worker report.
    lon: -122.4222,
    lat: 37.8262,
    bearingDeg: 150,
    label: 'Alcatraz Island, by the lighthouse',
    city: 'sf',
  },
  transamerica: {
    building: 'Transamerica Pyramid',
    label: 'Facing the Transamerica Pyramid',
    city: 'sf',
    lon: -122.4026,
    lat: 37.7952,
    bearingDeg: 270,
  },
  salesforce: {
    building: 'Salesforce Tower',
    label: 'Facing Salesforce Tower',
    city: 'sf',
    lon: -122.397,
    lat: 37.7898,
    bearingDeg: 180,
  },
  coittower: {
    building: 'Coit Tower',
    label: 'Facing Coit Tower',
    city: 'sf',
    lon: -122.4058,
    lat: 37.8024,
    bearingDeg: 180,
  },
  ferrybuilding: {
    building: 'San Francisco Ferry Building',
    label: 'Facing the Ferry Building',
    city: 'sf',
    lon: -122.3934,
    lat: 37.7955,
    bearingDeg: 315,
  },
  paintedladies: {
    lon: -122.433,
    lat: 37.7765,
    bearingDeg: 75,
    label: 'Alamo Square, facing the Painted Ladies row',
    city: 'sf',
  },
  lombard: {
    lon: -122.4187,
    lat: 37.8021,
    bearingDeg: 100,
    label: 'Top of the Lombard crooked block, facing down',
    city: 'sf',
  },
  pier39: {
    lon: -122.4103,
    lat: 37.8087,
    bearingDeg: 0,
    label: 'Pier 39, out toward Alcatraz',
    city: 'sf',
  },
  unionsquare: {
    lon: -122.4075,
    lat: 37.788,
    bearingDeg: 315,
    label: 'Union Square, facing downtown',
    city: 'sf',
  },
};

/**
 * All presets belonging to a city id, as `[key, preset]` pairs in
 * `SPAWN_PRESETS` insertion (table) order. Used by the fast-travel menu
 * (architecture.md §4.13) and by tests to prove the per-city fence.
 */
export function presetsFor(cityId: string): [string, SpawnPreset][] {
  return Object.entries(SPAWN_PRESETS)
    .filter(([, p]) => p.city === cityId)
    .map(([k, v]) => [k, v]);
}

/** Clamp `x` into `[lo, hi]`. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Maximum +x offset (metres) the spawn search scans when the point is blocked. */
const SPAWN_MAX = 200;

/** Min clearance (metres) a `landmarkSpawn` road vertex must keep from buildings. */
const CLEARANCE = 6;

/** Widest radius (metres) a `landmarkSpawn` fallback road vertex may sit from the centroid. */
const LANDMARK_FALLBACK = 300;

/** Corridor sample spacing (metres) ahead of a spawn vertex toward its target. */
const CORRIDOR_STEP = 4;

/** Furthest corridor distance (metres) a spawn vertex must stay clear to its target. */
const CORRIDOR_LIMIT = 40;

/** Corridor probe radius (metres) kept clear of buildings along each sample. */
const CORRIDOR_R = 1.5;

/**
 * True when the view corridor from `pt` toward the target is clear: for
 * `k = 4, 8, …, 40` the point `pt + k·(sin yaw, −cos yaw)` (yaw faces the
 * centroid) is not blocked with `CORRIDOR_R` clearance. A spawn with a wall
 * close ahead fills the frame (an 8.6 m building 6 m away already blocks a
 * 70° view), so road vertices must keep a clear corridor as well as a clear
 * footprint. Returns true when `blocked` is undefined.
 */
function corridorClear(
  pt: Vec2,
  yaw: number,
  blocked?: (p: Vec2, r?: number) => boolean,
): boolean {
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);
  for (let k = CORRIDOR_STEP; k <= CORRIDOR_LIMIT; k += CORRIDOR_STEP) {
    const q: Vec2 = [pt[0] + k * fx, pt[1] + k * fz];
    if (blocked?.(q, CORRIDOR_R) ?? false) return false;
  }
  return true;
}

/** Parameter type for `resolveSpawn`'s `city` argument (bbox is optional for tests). */
type SpawnCity = Pick<CityData, 'buildings' | 'roads'> &
  Partial<Pick<CityData, 'bbox'>>;

/**
 * Parse an `?at=` value. `null`/empty → `null`; a preset name (trimmed,
 * case-insensitive) → `{ preset }`; `lon,lat[,bearing]` finite numbers →
 * the coordinates; anything else → `null`.
 */
export function parseAt(
  param: string | null,
): { preset?: string; lon?: number; lat?: number; bearingDeg?: number } | null {
  if (param === null) return null;
  const trimmed = param.trim();
  if (trimmed === '') return null;
  const key = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SPAWN_PRESETS, key)) {
    return { preset: key };
  }
  const parts = trimmed.split(',');
  if (parts.length < 2 || parts.length > 3) return null;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const out: { lon: number; lat: number; bearingDeg?: number } = { lon, lat };
  if (parts.length === 3) {
    const bearingDeg = Number(parts[2]);
    if (!Number.isFinite(bearingDeg)) return null;
    out.bearingDeg = bearingDeg;
  }
  return out;
}

/** Wrap `a` into `(−π, π]`, so e.g. 3π/2 becomes −π/2. */
function normalizeAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r <= -Math.PI) r += twoPi;
  return r;
}

/**
 * Resolve a named building to a spawn point ~`targetDist` metres away on a
 * road vertex, facing the building centroid. An **exact** (case-insensitive)
 * name match is preferred before a substring (`includes`) match; when several
 * buildings share the exact name, an extra (`id ≤ −1000`) wins over an OSM
 * footprint (Nelson's Column is both a 6 m plinth and a 52 m extra). The
 * default target distance scales with the target's height:
 * `clamp(70 + 1.2·h, 70, 220)`. Returns the candidate road vertex from every
 * road polyline (all classes) whose distance from the centroid lies in
 * `[targetDist − 40, targetDist + 60]` with the smallest `|dist − targetDist|`;
 * if none, any corridor-clear vertex within 300 m. Every candidate must pass
 * **both** a 6 m footprint clearance (`blocked(pt, 6) === false`) and a clear
 * view corridor toward the centroid (`blocked(pt + k·forward, 1.5) === false`
 * for `k = 4…40 m`) so the spawn never sits inside a building nor against a
 * wall that fills the frame; when no candidate survives, `null` is returned
 * (the caller falls back to a fixed coordinate). Returns `null` when the
 * building is unnamed/absent. Yaw faces the centroid via
 * `atan2(c.x − p.x, −(c.z − p.z))` (consistent with forward
 * `(sin yaw, −cos yaw)`).
 */
export function landmarkSpawn(
  name: string,
  city: Pick<CityData, 'buildings' | 'roads'>,
  targetDist?: number,
  blocked?: (p: Vec2, r?: number) => boolean,
): SpawnPoint | null {
  const needle = name.toLowerCase();
  // Exact (case-insensitive) match first, then substring match. An extra
  // (id ≤ −1000) with the same exact name wins over an OSM building.
  const exactMatches = city.buildings.filter(
    (b) => b.name !== undefined && b.name.toLowerCase() === needle,
  );
  const exact = exactMatches.find((b) => b.id <= -1000) ?? exactMatches[0];
  const building =
    exact ??
    city.buildings.find(
      (b) => b.name !== undefined && b.name.toLowerCase().includes(needle),
    );
  if (!building) return null;
  const distance = targetDist ?? clamp(70 + 1.2 * building.h, 70, 220);

  // Centroid of the footprint ring.
  let cx = 0;
  let cz = 0;
  for (const [x, z] of building.poly) {
    cx += x;
    cz += z;
  }
  const n = building.poly.length;
  cx /= n;
  cz /= n;

  // Yaw that faces the target centroid (the same bearing the preset faces).
  const targetYaw = (px: number, pz: number): number =>
    Math.atan2(cx - px, -(cz - pz));

  // A candidate passes iff it keeps 6 m of footprint clearance AND a clear
  // view corridor toward the centroid, so it never spawns inside/against a
  // building nor with a wall filling the frame ahead.
  const accept = (pt: Vec2): boolean =>
    !(blocked?.(pt, CLEARANCE) ?? false) && corridorClear(pt, targetYaw(pt[0], pt[1]), blocked);

  // In-range road vertices passing both checks.
  const inRange: { p: Vec2; dist: number }[] = [];
  for (const road of city.roads) {
    for (const pt of road.pts) {
      const dist = Math.hypot(pt[0] - cx, pt[1] - cz);
      if (dist >= distance - 40 && dist <= distance + 60 && accept(pt)) {
        inRange.push({ p: pt, dist });
      }
    }
  }

  // Fallbacks: no (passing) in-range vertex → any passing vertex within
  // 300 m; still none → null.
  let pool = inRange;
  if (pool.length === 0) {
    pool = [];
    for (const road of city.roads) {
      for (const pt of road.pts) {
        const dist = Math.hypot(pt[0] - cx, pt[1] - cz);
        if (dist <= LANDMARK_FALLBACK && accept(pt)) {
          pool.push({ p: pt, dist });
        }
      }
    }
  }

  if (pool.length === 0) return null;

  let best = pool[0];
  for (const cand of pool) {
    if (Math.abs(cand.dist - distance) < Math.abs(best.dist - distance)) {
      best = cand;
    }
  }

  const [px, pz] = best.p;
  const yaw = Math.atan2(cx - px, -(cz - pz));
  return { x: px, z: pz, yaw };
}

/** True when the WGS84 point sits within `bbox = [minLon, minLat, maxLon, maxLat]`. */
function insideBbox(
  lon: number,
  lat: number,
  bbox: [number, number, number, number],
): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/** Look up the fallback preset and require it to be a fixed-coordinate form. */
function fixedFallback(name: string): {
  lon: number;
  lat: number;
  bearingDeg: number;
} {
  const p = SPAWN_PRESETS[name];
  if (
    !p ||
    'building' in p ||
    !('lon' in p) ||
    !('lat' in p) ||
    typeof p.lon !== 'number' ||
    typeof p.lat !== 'number'
  ) {
    throw new Error(
      `resolveSpawn fallback '${name}' must be a fixed-coordinate preset`,
    );
  }
  return { lon: p.lon, lat: p.lat, bearingDeg: p.bearingDeg };
}

/**
 * Resolve an `?at=` value to a spawn pose. Falls back to the `fallback`
 * preset (default `'bigben'`) when: `param` is `null`/empty/unknown; a
 * named-building preset has no `city` or its building is absent; the
 * resolved WGS84 point lies outside `city.bbox`. A named-building preset
 * that carries its own coordinates uses them (subject to the bbox check)
 * before falling back to the city's fallback preset. Blocked spawn points
 * walk `+x` in 1 m steps up to 200 m. Yaw comes from the bearing (degrees
 * → radians, wrapped to (−π, π]) or from `landmarkSpawn`.
 */
export function resolveSpawn(
  param: string | null,
  origin: { lat: number; lon: number },
  blocked: (p: Vec2) => boolean,
  city?: SpawnCity,
  fallback = 'bigben',
): SpawnPoint {
  const parsed = parseAt(param);
  const preset = parsed?.preset ? SPAWN_PRESETS[parsed.preset] : undefined;

  // Named-building preset: resolve against the dataset when a city is given.
  // `blocked` (with 6 m of clearance) is threaded through to `landmarkSpawn`
  // so the chosen vertex is never inside/against a building.
  if (preset && 'building' in preset && city) {
    const landmark = landmarkSpawn(preset.building, city, undefined, blocked);
    if (landmark) return landmark;
    // Building absent, or no unblocked vertex → fall through to this preset's
    // own fallback coordinate (if any), then to the city's fallback preset
    // (which does walk `+x` when blocked).
  }

  // Coordinates from an explicit `lon,lat[,bearing]`, a fixed-coordinate
  // preset, a hybrid building preset's fallback coord, or the fallback
  // preset. `parseAt` returns either a preset name or coordinates, never both.
  let lon: number | undefined;
  let lat: number | undefined;
  let bearingDeg = 0;
  if (parsed?.lon !== undefined && parsed?.lat !== undefined) {
    lon = parsed.lon;
    lat = parsed.lat;
    bearingDeg = parsed.bearingDeg ?? 0;
  } else if (preset && preset.lon !== undefined && preset.lat !== undefined) {
    lon = preset.lon;
    lat = preset.lat;
    bearingDeg = preset.bearingDeg ?? 0;
  }

  // If we ended up with a coordinate that lies outside the city's bbox, drop
  // it and use the fallback preset instead (which must be fixed-coordinate).
  const bbox = city?.bbox;
  const haveCoord = lon !== undefined && lat !== undefined;
  if (!haveCoord || (bbox && !insideBbox(lon!, lat!, bbox))) {
    const fb = fixedFallback(fallback);
    lon = fb.lon;
    lat = fb.lat;
    bearingDeg = fb.bearingDeg;
  }

  const [x0, z] = project(lon!, lat!, origin);
  let x = x0;
  const probe: Vec2 = [x0, z];
  for (let step = 0; step <= SPAWN_MAX; step++) {
    probe[0] = x0 + step;
    if (!blocked(probe)) {
      x = x0 + step;
      break;
    }
  }
  return { x, z, yaw: normalizeAngle((bearingDeg * Math.PI) / 180) };
}
