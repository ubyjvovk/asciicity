/**
 * Fetch-based loader for `CityData` and tiled `TileData` (docs/architecture.md
 * §4 / §4.19). Fetch the URL, then validate the JSON payload.
 */
import type { CityData, TileData } from './types';
import { validateCity } from './validate';

/**
 * Fetch and validate city data from `url`, returning the validated `CityData`.
 * Throws `Error('city data: HTTP <status>')` on a non-OK response.
 */
export async function loadCity(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CityData> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`city data: HTTP ${res.status}`);
  }
  return validateCity(await res.json());
}

/**
 * Light shape-check for a tile file (`v === 1`, `buildings`/`roads` arrays).
 * Tile files are machine-generated from already-validated input
 * (data-format.md "Tiled datasets" rule 7); this is not a full `validateCity`.
 */
export function parseTileData(raw: unknown): TileData {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('tile: expected an object');
  }
  const t = raw as Record<string, unknown>;
  if (t.v !== 1) {
    throw new Error('tile: v must be 1');
  }
  if (!Array.isArray(t.buildings)) {
    throw new Error('tile: buildings must be an array');
  }
  if (!Array.isArray(t.roads)) {
    throw new Error('tile: roads must be an array');
  }
  if (t.trees !== undefined && !Array.isArray(t.trees)) {
    throw new Error('tile: trees must be an array');
  }
  if (t.woods !== undefined && !Array.isArray(t.woods)) {
    throw new Error('tile: woods must be an array');
  }
  return raw as TileData;
}

/**
 * Fetch one `tiles/<i>_<j>.json` and run the light shape check.
 * Throws `Error('city data: HTTP <status>')` on a non-OK response.
 */
export async function loadTile(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TileData> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`city data: HTTP ${res.status}`);
  }
  return parseTileData(await res.json());
}

/** Mutable clock used by {@link dueRebuild} (fake-clock friendly). */
export interface RebuildClock {
  /** Last snapshot version that triggered a rebuild. */
  version: number;
  /** Timestamp (`now`) of that rebuild. */
  at: number;
}

/**
 * True when `version` has changed and at least `intervalMs` has elapsed since
 * `state.at` (≤ 1 rebuild per second). On true, updates `state` to
 * `{ version, at: now }`. Pass `now` explicitly so tests can drive a fake clock.
 */
export function dueRebuild(
  version: number,
  state: RebuildClock,
  now: number,
  intervalMs = 1000,
): boolean {
  if (version === state.version) return false;
  if (now - state.at < intervalMs) return false;
  state.version = version;
  state.at = now;
  return true;
}

/**
 * Parse `?tileradius=<m>` into TileManager radii (`unloadR = 1.3 · m`).
 * Missing / non-positive / non-finite values return `undefined` (defaults).
 */
export function parseTileRadius(
  search: string,
): { loadR: number; unloadR: number } | undefined {
  const raw = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  ).get('tileradius');
  if (raw === null || raw.trim() === '') return undefined;
  const m = Number(raw);
  if (!Number.isFinite(m) || m <= 0) return undefined;
  return { loadR: m, unloadR: 1.3 * m };
}
