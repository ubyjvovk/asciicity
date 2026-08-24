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
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertOverpass } from './osm-convert.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_BBOX = [-0.106, 51.506, -0.070, 51.521]; // City of London
const DEFAULT_ORIGIN = { lon: -0.0887, lat: 51.5133 }; // Bank junction
const DEFAULT_OUT = 'public/data/city.json';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Build the Overpass QL query string for the given bbox. */
function buildQuery(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return `[out:json][timeout:180];
(
  way["building"](${minLat},${minLon},${maxLat},${maxLon});
  relation["building"]["type"="multipolygon"](${minLat},${minLon},${maxLat},${maxLon});
  way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|primary_link|secondary_link|trunk_link)$"](${minLat},${minLon},${maxLat},${maxLon});
  node["place"](${minLat},${minLon},${maxLat},${maxLon});
  node["railway"="station"](${minLat},${minLon},${maxLat},${maxLon});
  node["tourism"="attraction"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  way["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});
  way["waterway"="riverbank"](${minLat},${minLon},${maxLat},${maxLon});
  relation["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});
  relation["waterway"="riverbank"](${minLat},${minLon},${maxLat},${maxLon});
);
out geom;`;
}

/** Parse `--k v` style CLI args into a record (duplicates → later wins). */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key.startsWith('--') && val !== undefined) {
      out[key.slice(2)] = val;
      i++;
    }
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bbox = args.bbox ? parseBbox(args.bbox) : DEFAULT_BBOX;
  const origin = args.origin ? parseOrigin(args.origin) : DEFAULT_ORIGIN;
  const out = args.out || DEFAULT_OUT;

  const query = buildQuery(bbox);

  fetchJson(query)
    .then((json) => {
      const city = convertOverpass(json, { origin, bbox });
      if (!isCityShape(city)) {
        process.stderr.write('fetch: converted result failed shape check\n');
        process.exit(1);
      }
      const bytes = Buffer.byteLength(JSON.stringify(city), 'utf8');
      const kb = Math.round(bytes / 1024);
      const line = `city.json: ${city.buildings.length} buildings, ${
        city.roads.length
      } roads, ${city.places.length} places, ${city.water?.length ?? 0} water, ${kb} KB (skipped ${
        city.skippedRelations ?? 0
      } relations, dropped ${city.skippedOpenWaterChains ?? 0} open water chains)`;

      const tmp = `${out}.tmp`;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(tmp, JSON.stringify(city));
      renameSync(tmp, out); // atomic-ish: never leaves a partial file at `out`
      process.stdout.write(line + '\n');
    })
    .catch((err) => {
      process.stderr.write(`fetch: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}

main();
