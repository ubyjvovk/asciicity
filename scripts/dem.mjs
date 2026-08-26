/**
 * SRTM 1-arc-second DEM → `terrain` grid + `waterLevels` (pure logic, zero
 * dependencies, node ≥ 22).
 *
 * Mirrors `docs/data-format.md` "Terrain" — tile naming, HGT layout, bilinear
 * + void rule, the grid formula and water flattening. Tiles come from the AWS
 * Terrain Tiles "skadi" mirror of SRTM; everything is cached under
 * `.cache/dem/`. The browser never imports this — `fetch-osm.mjs` runs it at
 * data-generation time (wired in by T-0040).
 *
 * Projection helpers are imported from `./osm-convert.mjs`; the inverse
 * (`unproject`) lives here because the converter never needs it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { project, round1 } from './osm-convert.mjs';

const DEG = Math.PI / 180;
const TILE_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/skadi';
/** HGT sample value that marks a void (no data). */
const VOID = -32768;

/**
 * Name of the 1-arc-second SRTM tile whose south-west corner is the floor of
 * `(lat, lon)`: `N`/`S` + 2 digits lat, `E`/`W` + 3 digits lon (e.g.
 * `(50.45, 30.52)` → `N50E030`, `(51.51, -0.09)` → `N51W001`).
 * @param {number} lat latitude in degrees
 * @param {number} lon longitude in degrees
 * @returns {string} tile name like `N50E030`
 */
export function hgtTileName(lat, lon) {
  const tileLat = Math.floor(lat);
  const tileLon = Math.floor(lon);
  const ns = tileLat >= 0 ? 'N' : 'S';
  const ew = tileLon >= 0 ? 'E' : 'W';
  return (
    `${ns}${String(Math.abs(tileLat)).padStart(2, '0')}` +
    `${ew}${String(Math.abs(tileLon)).padStart(3, '0')}`
  );
}

/**
 * Public download URL for a skadi tile (the directory prefix is the `NS`+lat
 * part of the name).
 * @param {string} name tile name like `N50E030`
 * @returns {string} https URL for the `.hgt.gz` file
 */
export function hgtUrl(name) {
  return `${TILE_URL}/${name.slice(0, 3)}/${name}.hgt.gz`;
}

/**
 * Decode a gunzipped big-endian `int16` HGT buffer into a square sample grid.
 * `side` is `sqrt(bytes / 2)` and must be an integer ≥ 2; row 0 is the tile's
 * north edge, `-32768` marks a void (preserved as-is).
 * @param {Buffer|ArrayBuffer|Uint8Array} gunzippedBuffer raw HGT bytes
 * @returns {{side: number, samples: Int16Array}} side and row-major samples
 */
export function decodeHgt(gunzippedBuffer) {
  const buf = Buffer.isBuffer(gunzippedBuffer)
    ? gunzippedBuffer
    : Buffer.from(
        gunzippedBuffer instanceof ArrayBuffer
          ? gunzippedBuffer
          : gunzippedBuffer.buffer ?? gunzippedBuffer,
      );
  const side = Math.sqrt(buf.byteLength / 2);
  if (!Number.isInteger(side) || side < 2) {
    throw new Error(
      `decodeHgt: HGT buffer of ${buf.byteLength} bytes is not a square side×side grid`,
    );
  }
  const samples = new Int16Array(side * side);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buf.readInt16BE(i * 2);
  }
  return { side, samples };
}

/**
 * Bilinear sample of one SRTM tile at a fractional (row, col), applying the
 * void rule: a `-32768` corner is replaced by the mean of the non-void
 * corners (all void → 0), each substitution counted in `this._voids`.
 * @private
 */
function sampleTile(samples, side, row, col) {
  const r0 = Math.min(side - 2, Math.max(0, Math.floor(row)));
  const c0 = Math.min(side - 2, Math.max(0, Math.floor(col)));
  const r1 = r0 + 1;
  const c1 = c0 + 1;
  const at = (r, c) => samples[r * side + c];
  const raw = [at(r0, c0), at(r0, c1), at(r1, c0), at(r1, c1)];
  const nonVoid = raw.filter((v) => v !== VOID);
  const mean = nonVoid.length
    ? nonVoid.reduce((a, b) => a + b, 0) / nonVoid.length
    : 0;
  const filled = raw.map((v) => {
    if (v !== VOID) return v;
    this._voids++;
    return mean;
  });
  const [v00, v10, v01, v11] = filled;
  const u = row - r0;
  const v = col - c0;
  return (
    (1 - u) * (1 - v) * v00 +
    (1 - u) * v * v10 +
    u * (1 - v) * v01 +
    u * v * v11
  );
}

/**
 * A set of decoded SRTM tiles with bilinear, void-aware elevation lookup.
 * Tiles are keyed by `hgtTileName(lat, lon)`; `elevationAt` picks the tile
 * containing its point and interpolates within it.
 */
export class Dem {
  /**
   * @param {Map<string, {side: number, samples: Int16Array}>} tiles decoded tiles
   */
  constructor(tiles) {
    /** @type {Map<string, {side: number, samples: Int16Array}>} */
    this.tiles = tiles;
    /** @private count of void corners substituted so far */
    this._voids = 0;
  }

  /** Number of void corners substituted during lookups so far. */
  get voids() {
    return this._voids;
  }

  /**
   * Bilinear elevation (metres above sea level) at a WGS84 point, void-aware.
   * Row 0 of each tile is its north edge.
   * @param {number} lat latitude in degrees
   * @param {number} lon longitude in degrees
   * @returns {number} elevation in metres
   * @throws {Error} when the enclosing tile is not loaded
   */
  elevationAt(lat, lon) {
    const name = hgtTileName(lat, lon);
    const tile = this.tiles.get(name);
    if (!tile) {
      throw new Error(`DEM tile ${name} not loaded (needed for ${lat},${lon})`);
    }
    const { side, samples } = tile;
    const tileLat = Math.floor(lat);
    const tileLon = Math.floor(lon);
    const row = (tileLat + 1 - lat) * (side - 1);
    const col = (lon - tileLon) * (side - 1);
    return sampleTile.call(this, samples, side, row, col);
  }
}

/**
 * Promise-returning Response shim used when `fetchImpl` is injected (keeps the
 * default `fetch` untouched for tests).
 * @typedef {{ok: boolean, status: number, arrayBuffer(): Promise<ArrayBuffer>}} DemResponse
 */

/**
 * Download (or load from `cacheDir`) every 1-arc-second tile touching `bbox`
 * and return a `Dem` over them. Downloaded `.hgt.gz` bodies are cached under
 * `<cacheDir>/<name>.hgt.gz` so a warm run never hits the network.
 * @param {[number,number,number,number]} bbox `[minLon, minLat, maxLon, maxLat]`
 * @param {{cacheDir?: string, fetchImpl?: (url: string) => Promise<DemResponse>}} [opts]
 * @returns {Promise<Dem>} a Dem over all tiles overlapping the bbox
 */
export async function fetchDemTiles(
  bbox,
  { cacheDir = '.cache/dem', fetchImpl = fetch } = {},
) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  mkdirSync(cacheDir, { recursive: true });
  const tiles = new Map();
  for (let lat = Math.floor(minLat); lat <= Math.floor(maxLat); lat++) {
    for (let lon = Math.floor(minLon); lon <= Math.floor(maxLon); lon++) {
      const name = hgtTileName(lat + 0.5, lon + 0.5);
      const file = join(cacheDir, `${name}.hgt.gz`);
      let gzipped;
      if (existsSync(file)) {
        gzipped = readFileSync(file);
      } else {
        const res = await fetchImpl(hgtUrl(name));
        if (!res.ok) {
          throw new Error(
            `Failed to download DEM tile ${name}: HTTP ${res.status}`,
          );
        }
        const body = Buffer.from(await res.arrayBuffer());
        gzipped = body;
        writeFileSync(file, body);
      }
      const { side, samples } = decodeHgt(gunzipSync(gzipped));
      tiles.set(name, { side, samples });
    }
  }
  return new Dem(tiles);
}

/**
 * Ray-casting point-in-polygon test (copied from `src/world/collision.ts` —
 * scripts cannot import TS); correct for either winding.
 * @param {[number,number]} p point `[x, z]`
 * @param {Array<[number,number]>} poly closed ring of `[x, z]` pairs
 * @returns {boolean} true when `p` is strictly inside `poly`
 */
function pointInPolygon(p, poly) {
  const px = p[0];
  const py = p[1];
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const straddles = yi > py !== yj > py;
    if (straddles && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Inverse of `project` (local metres → WGS84): `lon = origin.lon + x /
 * (cos(origin.lat°)·111320)`, `lat = origin.lat − z / 110574`.
 * @param {number} x local metres east
 * @param {number} z local metres south
 * @param {{lat: number, lon: number}} origin projection origin
 * @returns {[number, number]} `[lon, lat]`
 */
export function unproject(x, z, origin) {
  const lon = origin.lon + x / (Math.cos(origin.lat * DEG) * 111320);
  const lat = origin.lat - z / 110574;
  return [lon, lat];
}

/**
 * Build the `terrain` grid (+ per-ring `waterLevels`) from a DEM sample,
 * exactly per data-format.md steps 1–4: project + margin the bbox, sample at
 * every `step`-spaced node relative to `datum`, then flatten every node inside
 * each (already clipped) water ring to that ring's 10th-percentile level.
 * @param {{bbox: [number,number,number,number], origin: {lat:number,lon:number},
 *   dem: {elevationAt(lat:number, lon:number): number}, step?: number,
 *   waterRings?: Array<Array<[number,number]>>}} opts
 * @returns {{terrain: Object, waterLevels: number[]}} `{terrain, waterLevels}`
 */
export function buildTerrain({ bbox, origin, dem, step = 20, waterRings = [] }) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const corners = [
    project(minLon, minLat, origin),
    project(maxLon, minLat, origin),
    project(minLon, maxLat, origin),
    project(maxLon, maxLat, origin),
  ];
  const xs = corners.map((c) => c[0]);
  const zs = corners.map((c) => c[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);

  const x0 = Math.floor(minX / step) * step - step;
  const z0 = Math.floor(minZ / step) * step - step;
  const cols = Math.ceil((maxX - x0) / step) + 2;
  const rows = Math.ceil((maxZ - z0) / step) + 2;

  const datum = round1(dem.elevationAt(origin.lat, origin.lon));

  const heights = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [lon, lat] = unproject(x0 + c * step, z0 + r * step, origin);
      heights[r * cols + c] = round1(dem.elevationAt(lat, lon) - datum);
    }
  }

  const waterLevels = new Array(waterRings.length);
  for (let i = 0; i < waterRings.length; i++) {
    const ring = waterRings[i];
    const raw = ring.map(([x, z]) => {
      const [lon, lat] = unproject(x, z, origin);
      return dem.elevationAt(lat, lon) - datum;
    });
    raw.sort((a, b) => a - b);
    const n = raw.length;
    const level = n > 0 ? raw[Math.floor(0.1 * (n - 1))] : 0;
    waterLevels[i] = round1(level);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (pointInPolygon([x0 + c * step, z0 + r * step], ring)) {
          heights[idx] = waterLevels[i];
        }
      }
    }
  }

  return {
    terrain: { x0, z0, step, cols, rows, datum, heights },
    waterLevels,
  };
}
