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
 * A named spawn preset: either a named building matched against the dataset
 * (`{ building }`) or a fixed WGS84 position facing `bearingDeg`.
 */
export type SpawnPreset =
  | { building: string; label: string }
  | { lon: number; lat: number; bearingDeg: number; label: string };

/** Named spawn presets keyed by lower-case name (used by `?at=<name>`). */
export const SPAWN_PRESETS: Record<string, SpawnPreset> = {
  bank: { lon: -0.0887, lat: 51.5133, bearingDeg: 270, label: 'Bank junction' },
  // Named-building presets: `landmarkSpawn` finds the building and picks a
  // road vertex ~70 m away, facing it.
  stpauls: { building: "St Paul's Cathedral", label: "Facing St Paul's Cathedral" },
  gherkin: { building: '30 St Mary Axe', label: 'Facing the Gherkin' },
  monument: { building: 'Monument', label: 'Facing the Monument' },
  tower: { building: 'Tower of London', label: 'Facing the Tower of London' },
  barbican: { building: 'Barbican', label: 'Facing the Barbican' },
  liverpoolst: { building: 'Liverpool Street', label: 'Facing Liverpool Street' },
  leadenhall: { building: 'Leadenhall Market', label: 'Facing Leadenhall Market' },
  walkietalkie: {
    building: '20 Fenchurch Street',
    label: 'Facing the Walkie Talkie',
  },
  lloyds: { building: "Lloyd's", label: "Facing Lloyd's" },
  // Fixed coordinate presets (places, not resolvable single buildings).
  bigben: {
    lon: -0.12235,
    lat: 51.50085,
    bearingDeg: 268,
    label: 'Westminster Bridge, facing Big Ben',
  },
  parliament: {
    lon: -0.12655,
    lat: 51.5006,
    bearingDeg: 90,
    label: 'Parliament Square, facing the Palace of Westminster',
  },
  trafalgar: {
    lon: -0.128,
    lat: 51.5079,
    bearingDeg: 180,
    label: 'Trafalgar Square, facing Whitehall',
  },
  embankment: {
    lon: -0.122,
    lat: 51.5074,
    bearingDeg: 120,
    label: 'Victoria Embankment, facing the London Eye',
  },
};

/** Maximum +x offset (metres) the spawn search scans when the point is blocked. */
const SPAWN_MAX = 200;

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
 * road vertex, facing the building centroid. Returns the candidate road
 * vertex from every road polyline (all classes) whose distance from the
 * centroid lies in `[targetDist − 40, targetDist + 60]` with the smallest
 * `|dist − targetDist|`; if none, any road vertex within 200 m; else `null`
 * when the building is unnamed/absent. Yaw faces the centroid via
 * `atan2(c.x − p.x, −(c.z − p.z))` (consistent with forward `(sin yaw, −cos yaw)`).
 */
export function landmarkSpawn(
  name: string,
  city: Pick<CityData, 'buildings' | 'roads'>,
  targetDist = 70,
): SpawnPoint | null {
  const needle = name.toLowerCase();
  const building = city.buildings.find(
    (b) => b.name !== undefined && b.name.toLowerCase().includes(needle),
  );
  if (!building) return null;

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

  const candidates: Vec2[] = [];
  for (const road of city.roads) {
    for (const pt of road.pts) {
      const dist = Math.hypot(pt[0] - cx, pt[1] - cz);
      if (dist >= targetDist - 40 && dist <= targetDist + 60) {
        candidates.push(pt);
      }
    }
  }

  // Fallbacks: none in range → any road vertex within 200 m; still none → null.
  const pool =
    candidates.length > 0
      ? candidates.map((p) => ({ p, dist: Math.hypot(p[0] - cx, p[1] - cz) }))
      : (() => {
          const all: { p: Vec2; dist: number }[] = [];
          for (const road of city.roads) {
            for (const pt of road.pts) {
              const dist = Math.hypot(pt[0] - cx, pt[1] - cz);
              if (dist <= 200) all.push({ p: pt, dist });
            }
          }
          return all;
        })();

  if (pool.length === 0) return null;

  let best = pool[0];
  for (const cand of pool) {
    if (Math.abs(cand.dist - targetDist) < Math.abs(best.dist - targetDist)) {
      best = cand;
    }
  }

  const [px, pz] = best.p;
  const yaw = Math.atan2(cx - px, -(cz - pz));
  return { x: px, z: pz, yaw };
}

/**
 * Resolve an `?at=` value to a spawn pose. `null`/empty/unknown → the
 * `bigben` preset (Westminster Bridge facing Big Ben); a named-building
 * preset with `city` given resolves via `landmarkSpawn` (falling back to
 * `bigben` when the building is absent or unmatchable); a coordinate or
 * fixed preset is projected to local metres and, if `blocked`, walked `+x`
 * in 1 m steps up to 200 m. Yaw comes from the bearing (degrees → radians,
 * wrapped to (−π, π]) or from `landmarkSpawn`.
 */
export function resolveSpawn(
  param: string | null,
  origin: { lat: number; lon: number },
  blocked: (p: Vec2) => boolean,
  city?: Pick<CityData, 'buildings' | 'roads'>,
): SpawnPoint {
  const parsed = parseAt(param);
  const preset = parsed?.preset ? SPAWN_PRESETS[parsed.preset] : undefined;

  // Named-building preset: resolve against the dataset when a city is given.
  if (preset && 'building' in preset && city) {
    const landmark = landmarkSpawn(preset.building, city);
    if (landmark) return landmark;
    // Building absent → fall through to the bigben coordinate fallback.
  }

  // Coordinates from an explicit `lon,lat[,bearing]`, a fixed-coordinate
  // preset, or the bigben fallback (a named-building preset that could not
  // be resolved / no city given). parseAt returns either a preset name or
  // coordinates, never both.
  let lon: number;
  let lat: number;
  let bearingDeg: number;
  if (parsed?.lon !== undefined && parsed?.lat !== undefined) {
    lon = parsed.lon;
    lat = parsed.lat;
    bearingDeg = parsed.bearingDeg ?? 0;
  } else if (preset && 'lon' in preset) {
    lon = preset.lon;
    lat = preset.lat;
    bearingDeg = preset.bearingDeg;
  } else {
    const fb = SPAWN_PRESETS.bigben;
    if (!('lon' in fb)) {
      throw new Error('bigben preset must be a fixed-coordinate preset');
    }
    lon = fb.lon;
    lat = fb.lat;
    bearingDeg = fb.bearingDeg;
  }

  const [x0, z] = project(lon, lat, origin);
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
