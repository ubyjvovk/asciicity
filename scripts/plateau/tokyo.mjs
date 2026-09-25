#!/usr/bin/env node
/**
 * Production PLATEAU converter for Tokyo (T-0163, wave 22). Rebuilds the
 * BUILDINGS of an existing OSM-built tiled Tokyo dataset from Project
 * PLATEAU in place; roads / bridges / trees / woods / water / places stay
 * as they are.
 *
 *   node scripts/plateau/tokyo.mjs --data public/data/tokyo [--cache .cache/plateau]
 *   (npm run fetch-data:tokyo-plateau)
 *
 * Steps (docs/data-format.md "Tokyo from PLATEAU (wave 22)", docs/plateau.md
 * "Production converter"):
 * 1. read `index.json` + every tile; refuse a dataset that already holds
 *    PLATEAU ids (re-run from the OSM dataset instead);
 * 2. every JIS 3rd-order mesh intersecting `index.bbox` → catalog API →
 *    cached CityGML (`<cache>/raw/`), each distinct ward copy parsed,
 *    buildings (and `BuildingPart`s) de-duplicated by `gml:id`;
 * 3. `convertBuilding` (LOD1 envelope + measuredHeight + schema roofs;
 *    stepped / complex LOD2 roofs → `tiers`, never together with `roof`)
 *    for every building whose anchor lies in the bbox; ids = `plateauId`;
 * 4. merge rules 3–5 against the OSM buildings (`mergeBuildings`);
 * 5. retile with the tiler's anchor rule, rebuild landmarks, write the
 *    tiles + index (atomic per file), delete emptied tiles;
 * 6. validate the result with the repo's `validateTileIndex` /
 *    `validateCity` (all buildings as one city, and each tile's buildings)
 *    plus `checkBuildings` (tiers rules) — exit 1 on any error.
 *
 * Deterministic: meshes, ward copies and PLATEAU buildings are processed in
 * sorted order, so a re-run on the same OSM dataset + cache is byte-identical.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCity, validateTileIndex } from '../../src/data/validate.ts';
import { buildingChunks, meshesForBbox, parseBuilding } from './citygml.mjs';
import { distinctCopies, meshFiles, meshGml } from './fetch.mjs';
import { checkBuildings } from './map.mjs';
import { assignIds, convertBuilding, isPlateauId, mergeBuildings, retile, vertexMean } from './merge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Local metres → `[lon, lat]` (inverse of osm-convert `project`). */
function unproject(x, z, origin) {
  return [origin.lon + x / (Math.cos((origin.lat * Math.PI) / 180) * 111320), origin.lat - z / 110574];
}

/**
 * A fresh copy of a string. Regex captures are V8 slices of the whole mesh
 * document (100+ MB); keeping one alive would retain every parsed file.
 */
function detach(s) {
  return Buffer.from(s, 'utf8').toString('utf8');
}

/** `{ key: count }` sorted by count desc, then key. */
function tally(keys) {
  const m = new Map();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

/** Write JSON through `<path>.tmp` + rename (never a partial file). */
function writeJson(path, obj) {
  writeFileSync(`${path}.tmp`, JSON.stringify(obj));
  renameSync(`${path}.tmp`, path);
}

/** Parse `--flag value` arguments. */
function parseArgs(argv) {
  const out = { data: undefined, cache: join(ROOT, '.cache/plateau') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') out.data = argv[++i];
    else if (argv[i] === '--cache') out.cache = resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out.data) throw new Error('usage: node scripts/plateau/tokyo.mjs --data <tiled city dir> [--cache <dir>]');
  out.data = resolve(out.data);
  return out;
}

/**
 * Convert every PLATEAU building of the bbox's meshes (steps 2–3).
 * @returns {Promise<{ rows: { gmlId: string, building: object, plateauName?: string }[], stats: object }>}
 */
async function convertPlateau(index, cache) {
  const { origin, bbox } = index;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const meshes = meshesForBbox(bbox);
  const seen = new Set();
  const rows = [];
  const skipped = [];
  const roofKinds = [];
  const tierRejects = [];
  let copies = 0;
  let chunks = 0;
  let parts = 0;
  let outside = 0;
  let gmlBytes = 0;
  for (const code of meshes) {
    const files = distinctCopies(await meshFiles(code, cache));
    for (const file of files) {
      copies++;
      const xml = readFileSync(await meshGml(file, cache, console.log), 'utf8');
      gmlBytes += xml.length;
      for (const chunk of buildingChunks(xml)) {
        chunks++;
        const top = parseBuilding(chunk);
        const pbs = [top, ...top.parts];
        parts += top.parts.length;
        for (const pb of pbs) {
          if (!pb.gmlId || seen.has(pb.gmlId)) continue;
          const gmlId = detach(pb.gmlId);
          seen.add(gmlId);
          // A building with parts but no own geometry is represented by its parts.
          if (pb === top && top.parts.length && !pb.lod0.length && !pb.lod1.length) continue;
          const conv = convertBuilding(pb, origin);
          if (!conv.building) {
            skipped.push(conv.skip);
            continue;
          }
          const [ax, az] = vertexMean(conv.building.poly);
          const [lon, lat] = unproject(ax, az, origin);
          if (lon < minLon || lon >= maxLon || lat < minLat || lat >= maxLat) {
            outside++;
            continue;
          }
          roofKinds.push(conv.kind);
          if (conv.tierReject) tierRejects.push(conv.tierReject);
          const { building, plateauName: name } = conv;
          rows.push({ gmlId, building, ...(name ? { plateauName: detach(name) } : {}) });
        }
      }
    }
  }
  rows.sort((a, b) => (a.gmlId < b.gmlId ? -1 : a.gmlId > b.gmlId ? 1 : 0));
  const collisions = assignIds(rows);
  return {
    rows,
    stats: {
      meshes: meshes.length,
      copies,
      gmlBytes,
      chunks,
      buildingParts: parts,
      unique: seen.size,
      skipped: tally(skipped),
      outsideBbox: outside,
      converted: rows.length,
      roofKinds: tally(roofKinds),
      tierRejects: tally(tierRejects),
      idCollisions: collisions,
    },
  };
}

/**
 * Validate the written dataset (step 6).
 * @returns {{ errors: string[], tiles: number }}
 */
function validateOutput(index, tiles) {
  const errors = [];
  const tryV = (what, fn) => {
    try {
      fn();
    } catch (err) {
      errors.push(`${what}: ${err instanceof Error ? err.message : err}`);
    }
  };
  tryV('index', () => validateTileIndex(index));
  const all = [];
  for (const [key, tile] of tiles) {
    if (tile.v !== 1 || !Array.isArray(tile.buildings) || !Array.isArray(tile.roads)) errors.push(`tile ${key}: shape`);
    tryV(`tile ${key}`, () =>
      validateCity({ v: 1, origin: index.origin, bbox: index.bbox, buildings: tile.buildings, roads: [], places: [] }),
    );
    for (const e of checkBuildings(tile.buildings)) errors.push(`tile ${key}: ${e}`);
    all.push(...tile.buildings);
  }
  tryV('all buildings', () =>
    validateCity({
      v: 1,
      origin: index.origin,
      bbox: index.bbox,
      buildings: all,
      roads: index.bridgeRoads,
      places: index.places,
    }),
  );
  return { errors, tiles: tiles.size };
}

async function main() {
  const t0 = Date.now();
  const { data, cache } = parseArgs(process.argv.slice(2));
  const indexPath = join(data, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const tiles = new Map();
  let bytesBefore = readFileSync(indexPath).length;
  let maxBefore = 0;
  const osm = [];
  for (const key of Object.keys(index.tiles)) {
    const raw = readFileSync(join(data, 'tiles', `${key}.json`));
    bytesBefore += raw.length;
    maxBefore = Math.max(maxBefore, raw.length);
    const tile = JSON.parse(raw.toString('utf8'));
    tiles.set(key, tile);
    osm.push(...tile.buildings);
  }
  if (osm.some((b) => isPlateauId(b.id))) {
    throw new Error(`${data} already holds PLATEAU buildings — re-run on the OSM dataset (npm run fetch-data:tokyo)`);
  }
  console.log(`${data}: ${tiles.size} tiles, ${osm.length} OSM buildings, ${bytesBefore} B`);

  const plateau = await convertPlateau(index, cache);
  const p = plateau.stats;
  console.log(`PLATEAU: ${p.meshes} meshes (${p.copies} ward copies, ${(p.gmlBytes / 1e9).toFixed(2)} GB GML), ${p.chunks} building chunks, ${p.unique} unique gml:ids, ${p.converted} in bbox (${p.outsideBbox} outside, skipped ${JSON.stringify(p.skipped)}), id collisions ${p.idCollisions}`);
  const tParse = Date.now();

  const merged = mergeBuildings(plateau.rows, osm);
  const m = merged.stats;
  const tMerge = Date.now();
  const out = retile(index, tiles, merged.buildings);

  for (const key of out.removed) rmSync(join(data, 'tiles', `${key}.json`), { force: true });
  for (const [key, tile] of out.tiles) writeJson(join(data, 'tiles', `${key}.json`), tile);
  writeJson(indexPath, out.index);

  let bytesAfter = readFileSync(indexPath).length;
  let maxAfter = 0;
  let maxKey = '';
  for (const [key, st] of Object.entries(out.index.tiles)) {
    bytesAfter += st.bytes;
    if (st.bytes > maxAfter) [maxAfter, maxKey] = [st.bytes, key];
  }
  const plateauOut = merged.buildings.filter((b) => isPlateauId(b.id));
  const withTiers = plateauOut.filter((b) => b.tiers);
  const stats = {
    plateau: p,
    merge: m,
    output: {
      buildings: merged.buildings.length,
      plateauBuildings: plateauOut.length,
      roofs: tally(plateauOut.filter((b) => b.roof).map((b) => b.roof.shape)),
      buildingsWithTiers: withTiers.length,
      tiers: withTiers.reduce((s, b) => s + b.tiers.length, 0),
      maxTiers: withTiers.reduce((s, b) => Math.max(s, b.tiers.length), 0),
      landmarks: out.index.landmarks.length,
      tiles: out.tiles.size,
      tilesCreated: out.created,
      tilesRemoved: out.removed,
      bytesBefore,
      bytesAfter,
      maxTileBytesBefore: maxBefore,
      maxTileBytes: maxAfter,
      maxTile: maxKey,
    },
    seconds: { plateau: (tParse - t0) / 1000, merge: (tMerge - tParse) / 1000, total: 0 },
  };
  const o = stats.output;
  console.log(`merge: PLATEAU kept ${m.plateauKept} / ${m.plateauIn} (suppressed by OSM parts ${m.suppressedByParts}); OSM parts kept ${m.osmParts}, OSM kept (< 20 % covered) ${m.osmKeptUncovered}, OSM replaced ${m.osmDropped}; names: IoU ${m.namesByIou}, cover ${m.namesByCover}, PLATEAU gml:name ${m.namesFromPlateau}, fallback 3b ${m.namesByFallback} (unplaced ${m.namesUnplaced})`);
  console.log(`roofs ${JSON.stringify(o.roofs)}; tiers: ${o.buildingsWithTiers} buildings, ${o.tiers} tiers (max ${o.maxTiers}; rejected ${JSON.stringify(p.tierRejects)})`);
  console.log(`output: ${o.buildings} buildings, ${o.landmarks} landmarks, ${o.tiles} tiles (created ${o.tilesCreated.join(',') || '-'}, removed ${o.tilesRemoved.join(',') || '-'})`);
  console.log(`bytes: ${bytesBefore} → ${bytesAfter} (${(bytesAfter / 1e6).toFixed(2)} MB); max tile ${maxBefore} → ${maxAfter} (${maxKey})`);

  const v = validateOutput(out.index, out.tiles);
  stats.validation = { tiles: v.tiles, errors: v.errors.length, first: v.errors.slice(0, 20) };
  stats.seconds.total = (Date.now() - t0) / 1000;
  writeFileSync(join(cache, 'tokyo.stats.json'), JSON.stringify(stats, null, 2));
  console.log(`validation: ${v.tiles} tiles + index + all ${o.buildings} buildings → ${v.errors.length ? `${v.errors.length} errors: ${v.errors.slice(0, 5).join('; ')}` : 'OK (0 errors)'}`);
  console.log(`wall time ${stats.seconds.total.toFixed(1)} s (PLATEAU ${stats.seconds.plateau.toFixed(1)} s, merge ${stats.seconds.merge.toFixed(1)} s); stats → ${join(cache, 'tokyo.stats.json')}`);
  if (v.errors.length) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
