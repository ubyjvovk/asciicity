#!/usr/bin/env node
/**
 * Fetch real City of London OSM data from Overpass and write
 * `public/data/city.json`. Zero dependencies (node ≥ 22 global `fetch`).
 *
 * Query + conversion rules are specified in `docs/data-format.md`; see also
 * `docs/fetch-osm.md` for how to run this and what the summary line means.
 *
 * CLI:
 *   node scripts/fetch-osm.mjs \
 *     [--bbox minLon,minLat,maxLon,maxLat] \
 *     [--origin lon,lat] \
 *     [--out public/data/city.json]
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchDemTiles } from './dem.mjs';
import { convertOverpass } from './osm-convert.mjs';
import { tileCity, DEFAULT_TILE_SIZE } from './tile-city.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_BBOX = [-0.130, 51.497, -0.070, 51.521]; // Westminster to Aldgate
const DEFAULT_ORIGIN = { lon: -0.0887, lat: 51.5133 }; // Bank junction
const DEFAULT_OUT = 'public/data/city.json';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Build the Overpass QL query string for the given bbox. `timeoutSec` is the
 * Overpass server-side timeout — 180 s for London, bumped to 300 s for the
 * larger Kyiv bbox (data-format.md §Fetch script CLI).
 */
function buildQuery(bbox, timeoutSec = 180) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return `[out:json][timeout:${timeoutSec}];
(
  way["building"](${minLat},${minLon},${maxLat},${maxLon});
  relation["building"]["type"="multipolygon"](${minLat},${minLon},${maxLat},${maxLon});
  way["building:part"](${minLat},${minLon},${maxLat},${maxLon});
  relation["building:part"]["type"="multipolygon"](${minLat},${minLon},${maxLat},${maxLon});
  way["highway"~"^(trunk|motorway|motorway_link|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|cycleway|primary_link|secondary_link|trunk_link)$"](${minLat},${minLon},${maxLat},${maxLon});
  node["place"](${minLat},${minLon},${maxLat},${maxLon});
  node["railway"="station"](${minLat},${minLon},${maxLat},${maxLon});
  node["tourism"="attraction"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  way["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});
  way["waterway"="riverbank"](${minLat},${minLon},${maxLat},${maxLon});
  relation["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});
  relation["waterway"="riverbank"](${minLat},${minLon},${maxLat},${maxLon});
  way["waterway"="river"](${minLat},${minLon},${maxLat},${maxLon});
  // Bays/seas — mapped as ways, not polygons; see data-format.md "Coastline water".
  way["natural"="coastline"](${minLat},${minLon},${maxLat},${maxLon});
  node["natural"="tree"](${minLat},${minLon},${maxLat},${maxLon});
  way["natural"="tree_row"](${minLat},${minLon},${maxLat},${maxLon});
  way["natural"="wood"](${minLat},${minLon},${maxLat},${maxLon});
  way["landuse"="forest"](${minLat},${minLon},${maxLat},${maxLon});
  way["leisure"="park"](${minLat},${minLon},${maxLat},${maxLon});
  relation["natural"="wood"](${minLat},${minLon},${maxLat},${maxLon});
  relation["landuse"="forest"](${minLat},${minLon},${maxLat},${maxLon});
  relation["leisure"="park"](${minLat},${minLon},${maxLat},${maxLon});
);
out geom;`;
}

/** CLI flags that may appear bare (or with `1`/`true`). */
const BOOLEAN_FLAGS = new Set(['tiles', 'dem-bare', 'water-full', 'water-dem']);

/** Parse CLI argv into a record; `--tiles` is a boolean flag, other `--key`s require a value. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const name = tok.slice(2);
    const next = argv[i + 1];
    const nextIsFlag = next === undefined || next.startsWith('--');
    if (BOOLEAN_FLAGS.has(name) && nextIsFlag) {
      out[name] = true;
      continue;
    }
    if (nextIsFlag) {
      throw new Error(`unknown or valueless flag --${name}`);
    }
    out[name] = next;
    i++;
  }
  return out;
}

/** Parse `--origin lon,lat` → `{lon, lat}`. */
function parseOrigin(s) {
  const parts = s.split(',').map((p) => Number(p));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`bad --origin "${s}" (want lon,lat)`);
  }
  return { lon: parts[0], lat: parts[1] };
}

/** Parse `--bbox minLon,minLat,maxLon,maxLat` → array of four numbers. */
function parseBbox(s) {
  const parts = s.split(',').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`bad --bbox "${s}" (want minLon,minLat,maxLon,maxLat)`);
  }
  return parts;
}

/**
 * Split a WGS84 bbox into an N×M grid of sub-bboxes that tile it exactly
 * (shared edges, no gaps or overlaps). Pure — used by `--chunks NxM`.
 * @param {[number,number,number,number]} bbox [minLon,minLat,maxLon,maxLat]
 * @param {number} n columns (lon)
 * @param {number} m rows (lat)
 * @returns {Array<[number,number,number,number]>} n*m sub-bboxes, row-major
 */
export function splitBbox(bbox, n, m) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (!Number.isInteger(n) || n <= 0 || !Number.isInteger(m) || m <= 0) {
    throw new Error('--chunks: want NxM with N,M >= 1');
  }
  const lonStep = (maxLon - minLon) / n;
  const latStep = (maxLat - minLat) / m;
  const out = [];
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < n; c++) {
      out.push([
        minLon + c * lonStep,
        minLat + r * latStep,
        minLon + (c + 1) * lonStep,
        minLat + (r + 1) * latStep,
      ]);
    }
  }
  return out;
}

/**
 * Keep one copy of each Overpass element by `type` + `id` (first wins,
 * original order preserved) — a seam element is returned by every chunk of a
 * chunked fetch. Pure — used by `--chunks NxM` before conversion.
 * @param {Array<{type: string, id: number}>} elements
 * @returns {Array<{type: string, id: number}>} deduplicated, ordered
 */
export function dedupeElements(elements) {
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    const key = `${el.type}:${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
  }
  return out;
}

/** Parse `--chunks NxM` → `{n, m}`. */
function parseChunks(s) {
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (!m) {
    throw new Error(`bad --chunks "${s}" (want NxM, e.g. 3x3)`);
  }
  const n = Number(m[1]);
  const rows = Number(m[2]);
  if (n < 1 || rows < 1) {
    throw new Error(`bad --chunks "${s}" (N and M must be >= 1)`);
  }
  return { n, m: rows };
}

/**
 * Normalise the `--dem-bare` argument into a bare-earth mode (wave 14b).
 * Absent (or explicit `false`) means no filter; bare `--dem-bare` and the
 * value forms `1` / `true` mean the wave-13 erode mode (`true`); `ridge`
 * selects the directional-opening `ridge` mode; any other value is rejected
 * loudly. Pure — used by `main()` and by the tests.
 * @param {unknown} v parsed value of `--dem-bare` (absent ⇒ `false`)
 * @returns {boolean|'ridge'} `false` off, `true` (erode), or `'ridge'`
 */
export function resolveDemBare(v) {
  if (v === false || v === undefined) return false;
  if (v === true || v === '1' || v === 'true') return true;
  if (v === 'ridge') return 'ridge';
  throw new Error(
    `bad --dem-bare "${String(v)}" (want 1|true for erode, or ridge)`,
  );
}

/** POST the query to one endpoint; throws `QueryError` on non-200. */
class QueryError extends Error {
  constructor(status, body) {
    super(`Overpass HTTP ${status}: ${body.slice(0, 160)}`);
    this.status = status;
  }
}

async function post(query, endpoint, headers) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: 'data=' + encodeURIComponent(query),
    });
  } catch (err) {
    throw new QueryError(-1, `network error: ${err.message}`);
  }
  if (res.status !== 200) {
    const body = await res.text().catch(() => '');
    throw new QueryError(res.status, body);
  }
  return res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Query Overpass with the retry/fallback policy from data-format.md: retry
 * each endpoint once on 429/504 after 30 s, then try the next endpoint.
 * @param {string} query Overpass QL
 * @returns {Promise<{elements: unknown[]}>} parsed JSON response
 */
async function fetchJson(query) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'User-Agent': 'asciicity-fetch/1.0 (AsciiCity data pipeline)',
  };
  let lastErr;
  for (const endpoint of ENDPOINTS) {
    let attempts = 1;
    while (attempts <= 2) {
      try {
        return await post(query, endpoint, headers);
      } catch (err) {
        lastErr = err;
        if (attempts === 1 && (err.status === 429 || err.status === 504)) {
          process.stderr.write(
            `overpass ${err.status} on ${endpoint} — retrying in 30s...\n`,
          );
          await sleep(30000);
          attempts++;
          continue;
        }
        break; // not a retryable status — try the next endpoint
      }
    }
  }
  throw lastErr;
}

/** Ensure an object satisfies the basic city shape we're committing. */
function isCityShape(o) {
  return (
    o &&
    o.v === 1 &&
    Array.isArray(o.buildings) &&
    Array.isArray(o.roads) &&
    Array.isArray(o.places)
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bbox = args.bbox ? parseBbox(args.bbox) : DEFAULT_BBOX;
  const origin = args.origin ? parseOrigin(args.origin) : DEFAULT_ORIGIN;
  const out = args.out || DEFAULT_OUT;
  const lang = args.lang || undefined;
  const useDem = args.dem === '1' || args.dem === 'true';
  const tiles =
    args.tiles === true || args.tiles === '1' || args.tiles === 'true';
  const demBare = resolveDemBare(args['dem-bare'] ?? false);
  const waterFull =
    args['water-full'] === true ||
    args['water-full'] === '1' ||
    args['water-full'] === 'true';
  const waterDem =
    args['water-dem'] === true ||
    args['water-dem'] === '1' ||
    args['water-dem'] === 'true';
  const chunks = args.chunks !== undefined ? parseChunks(args.chunks) : null;
  const step = args.step !== undefined ? Number(args.step) : undefined;
  if (step !== undefined && (!Number.isFinite(step) || step <= 0)) {
    throw new Error(`bad --step "${args.step}" (want positive number)`);
  }
  // The Kyiv bbox is larger than the City of London — bump the Overpass
  // timeout so the server does not cut the response short.
  const timeoutSec = useDem ? 300 : 180;

  const query = buildQuery(bbox, timeoutSec);

  try {
    // Prefetch DEM tiles first so a converter failure never leaves a stale
    // half-downloaded cache; both errors are equally fatal (non-zero exit).
    let dem;
    if (useDem) {
      dem = await fetchDemTiles(bbox, { bareEarth: demBare });
    }
    // Chunked fetch: sequential sub-bboxes (5 s pause, same endpoint fallback
    // as a single query), concatenated and deduped by type+id BEFORE
    // conversion — a seam element is returned by every chunk it touches.
    let json;
    if (chunks) {
      const subs = splitBbox(bbox, chunks.n, chunks.m);
      const all = [];
      for (let k = 0; k < subs.length; k++) {
        if (k > 0) await sleep(5000);
        const res = await fetchJson(buildQuery(subs[k], timeoutSec));
        all.push(...res.elements);
      }
      json = { elements: dedupeElements(all) };
    } else {
      json = await fetchJson(query);
    }
    // --water-full (T-0116, Answers 4): the shipped bbox often clips a
    // shoreline-hugging harbour relation whose outer boundary closes through
    // open ocean OUTSIDE the box, leaving the peninsulas enclosed and
    // parity-wrong. Fetch the FULL member geometry of every water /
    // riverbank relation in one follow-up request and splice it back over
    // the (clipped) member geometries, then flag the converter so those
    // relations are assembled without bbox clipping. Standalone water WAYS
    // keep today's path unchanged.
    if (waterFull) {
      const relIds = [];
      for (const el of json.elements) {
        if (!el || typeof el !== 'object') continue;
        if (el.type !== 'relation') continue;
        const tags = el.tags || {};
        if (!(tags.natural === 'water' || tags.waterway === 'riverbank')) continue;
        relIds.push(el.id);
      }
      if (relIds.length > 0) {
        const followUp = `[out:json][timeout:${timeoutSec}];\nrelation(id:${relIds.join(',')});\n(._;way(r);>;);\nout geom;`;
        const fu = await fetchJson(followUp);
        const wayFullGeom = new Map();
        for (const el of fu.elements || []) {
          if (el && el.type === 'way' && Array.isArray(el.geometry)) {
            wayFullGeom.set(el.id, el.geometry);
          }
        }
        // Splice full-geometry ways back into every relation's members that
        // reference them; standalone water ways in json.elements are left alone.
        for (const el of json.elements) {
          if (!el || typeof el !== 'object') continue;
          if (el.type !== 'relation') continue;
          const tags = el.tags || {};
          if (!(tags.natural === 'water' || tags.waterway === 'riverbank')) continue;
          for (const m of el.members || []) {
            if (m && m.type === 'way' && wayFullGeom.has(m.ref)) {
              m.geometry = wayFullGeom.get(m.ref);
            }
          }
        }
      }
    }
    const city = convertOverpass(json, {
      origin,
      bbox,
      ...(lang ? { lang } : {}),
      ...(dem ? { dem } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(waterFull ? { waterFull: true } : {}),
      ...(waterDem ? { waterDem: true } : {}),
    });
    if (!isCityShape(city)) {
      process.stderr.write('fetch: converted result failed shape check\n');
      process.exit(1);
    }
    const bytes = Buffer.byteLength(JSON.stringify(city), 'utf8');
    const kb = Math.round(bytes / 1024);
    const outName = out.split('/').pop() || out;
    const base = `${outName}: ${city.buildings.length} buildings, ${
      city.roads.length
    } roads, ${city.places.length} places, ${city.water?.length ?? 0} water, ${
      city.rivers?.length ?? 0
    } rivers, ${city.trees?.length ?? 0} trees (${city.treesFilled ?? 0} filled, ${
      city.treesDropped ?? 0
    } dropped)`;
    const terrainPart = city.terrain
      ? `, terrain ${city.terrain.cols}x${city.terrain.rows} @ ${city.terrain.step} m (${dem?.voids ?? 0} voids)`
      : '';
    const line = `${base}${terrainPart}, ${kb} KB (skipped ${
      city.skippedRelations ?? 0
    } relations, dropped ${city.skippedOpenWaterChains ?? 0} open water chains)`;

    if (tiles) {
      // `--out` names the city DIRECTORY: index.json + tiles/<i>_<j>.json.
      const tiled = tileCity(city, DEFAULT_TILE_SIZE);
      mkdirSync(join(out, 'tiles'), { recursive: true });
      const write = (path, obj) => {
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(obj));
        renameSync(tmp, path); // atomic-ish: never a partial file at `path`
      };
      write(join(out, 'index.json'), tiled.index);
      let tileBytes = 0;
      for (const [key, tile] of tiled.tiles) {
        write(join(out, 'tiles', `${key}.json`), tile);
        tileBytes += tiled.index.tiles[key].bytes;
      }
      const totalKb = Math.round((bytes + tileBytes) / 1024);
      process.stdout.write(
        `${line}, ${tiled.tiles.size} tiles (${totalKb} KB tiled total)\n`,
      );
      return;
    }

    const tmp = `${out}.tmp`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(tmp, JSON.stringify(city));
    renameSync(tmp, out); // atomic-ish: never leaves a partial file at `out`
    process.stdout.write(line + '\n');
  } catch (err) {
    process.stderr.write(`fetch: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}

// Run the CLI only when this file is the entry point (not when imported by
// the tests for `parseArgs` / `splitBbox` / `dedupeElements`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
