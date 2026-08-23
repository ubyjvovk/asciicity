/**
 * Spawn presets and coordinates for `?at=` (docs/integration.md §URL
 * parameters). Pure module: resolves an `?at=` value to a local-metre
 * spawn point, projecting WGS84 presets/coordinates relative to the city
 * origin. No DOM/WebGL.
 */
import type { Vec2 } from './types';
import { project } from '../geo';

/** Resolved spawn pose in local metres: `x` east, `z` south, yaw in radians. */
export interface SpawnPoint {
  x: number;
  z: number;
  yaw: number;
}

/** A named landmark preset: WGS84 position, facing `bearingDeg`, and a label. */
export interface SpawnPreset {
  lon: number;
  lat: number;
  bearingDeg: number;
  label: string;
}

/** Named spawn presets keyed by lower-case name (used by `?at=<name>`). */
export const SPAWN_PRESETS: Record<string, SpawnPreset> = {
  bank: { lon: -0.0887, lat: 51.5133, bearingDeg: 270, label: 'Bank junction' },
  stpauls: {
    lon: -0.095,
    lat: 51.5139,
    bearingDeg: 270,
    label: "Cheapside, facing St Paul's",
  },
  gherkin: {
    lon: -0.08,
    lat: 51.5132,
    bearingDeg: 0,
    label: 'St Mary Axe, facing the Gherkin',
  },
  monument: { lon: -0.0859, lat: 51.5098, bearingDeg: 0, label: 'Monument' },
  tower: { lon: -0.076, lat: 51.5095, bearingDeg: 180, label: 'Tower Hill' },
  barbican: { lon: -0.093, lat: 51.5185, bearingDeg: 0, label: 'Barbican' },
  liverpoolst: {
    lon: -0.083,
    lat: 51.5178,
    bearingDeg: 90,
    label: 'Liverpool Street',
  },
  leadenhall: {
    lon: -0.0845,
    lat: 51.5128,
    bearingDeg: 90,
    label: 'Leadenhall Market',
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
 * Resolve an `?at=` value to a spawn pose. `null`/unknown → the `bank`
 * preset at the origin; a preset or coordinate is projected to local metres
 * and, if `blocked`, walked `+x` in 1 m steps up to 200 m. Yaw comes from the
 * bearing (degrees → radians, wrapped to (−π, π]).
 */
export function resolveSpawn(
  param: string | null,
  origin: { lat: number; lon: number },
  blocked: (p: Vec2) => boolean,
): SpawnPoint {
  const parsed = parseAt(param);
  let lon: number;
  let lat: number;
  let bearingDeg: number;
  if (parsed?.preset) {
    const preset = SPAWN_PRESETS[parsed.preset];
    lon = preset.lon;
    lat = preset.lat;
    bearingDeg = preset.bearingDeg;
  } else if (parsed?.lon !== undefined && parsed?.lat !== undefined) {
    lon = parsed.lon;
    lat = parsed.lat;
    bearingDeg = parsed.bearingDeg ?? 0;
  } else {
    const preset = SPAWN_PRESETS.bank;
    lon = preset.lon;
    lat = preset.lat;
    bearingDeg = preset.bearingDeg;
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
