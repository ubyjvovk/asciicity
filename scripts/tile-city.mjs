#!/usr/bin/env node
/**
 * Tiler for sector streaming (wave 11): turns a monolithic `CityData` into an
 * `index.json` + `tiles/<i>_<j>.json` city directory. Pure logic (`tileCity`,
 * `splitRoad`) is zero-dependency and unit-tested; the CLI
 * `node scripts/tile-city.mjs <city.json> <outdir>` is the deterministic
 * migration path (no Overpass).
 *
 * Format contract: docs/data-format.md "Tiled datasets (wave 11 — sector
 * streaming)"; shapes: `TileIndexData` / `TileData` / `TileStat` in
 * `src/data/types.ts` (PM-owned — imported, never edited).
 *
 * Input validation uses `validateCity` from `src/data/validate.ts`. Importing
 * the TS validator from an .mjs script works via Node's built-in type
 * stripping (node ≥ 22.18; the worker image ships 22.23.2, the host 24), so
 * the tiler and the validator share one height clamp ([3, 650]) and one set
 * of rules — no drift.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCity } from '../src/data/validate.ts';

/** Tile edge length in metres for shipped datasets (data-format.md). */
export const DEFAULT_TILE_SIZE = 1000;

/** `"i_j"` tile key, negative indices keeping their minus sign. */
function tileKey(i, j) {
  return `${i}_${j}`;
}

/** Tile `(i, j)` of a point `(x, z)` in local metres (`floor(x / tileSize)`). */
function tileOf(x, z, tileSize) {
  return [Math.floor(x / tileSize), Math.floor(z / tileSize)];
}

/**
 * Arithmetic mean of a ring's vertices — the building/woods assignment anchor
 * (data-format.md "Tiled datasets" rule 1). Computed on the stored (rounded)
 * ring with no further rounding so the anchor never flips a tile.
 * @param {Array<[number, number]>} ring closed or open ring
 * @returns {[number, number]} `[cx, cz]` vertex mean
 */
function vertexMean(ring) {
  let sx = 0;
  let sz = 0;
  for (const [x, z] of ring) {
    sx += x;
    sz += z;
  }
  const n = ring.length;
  return [sx / n, sz / n];
}

/**
 * Clip one road polyline against the tile grid (data-format.md rule 2). Every
 * piece lies entirely inside one tile; consecutive pieces share exactly the
 * boundary crossing point (computed once, appended to BOTH pieces), so the
 * road graph reconnects when both tiles load — independent of vertex order /
 * travel direction. Single-point pieces (a road that merely touches a tile at
 * a vertex/corner) are dropped. Bridges never reach here (rule 3).
 * @param {Array<[number, number]>} pts road centre-line
 * @param {number} tileSize tile edge in metres
 * @returns {Array<{tile: string, piece: Array<[number, number]>}>}
 */
function splitRoad(pts, tileSize) {
  const out = [];
  let i = Math.floor(pts[0][0] / tileSize);
  let j = Math.floor(pts[0][1] / tileSize);
  let piece = [pts[0]];
  let cx = pts[0][0];
  let cz = pts[0][1];

  for (let k = 1; k < pts.length; k++) {
    const x1 = pts[k][0];
    const z1 = pts[k][1];
    // A vertex can sit exactly on a shared edge; the floor of the current
    // point re-locates us before walking the next segment (a boundary-parallel
    // continuation would otherwise stay tagged with the previous tile).
    const ni = Math.floor(cx / tileSize);
    const nj = Math.floor(cz / tileSize);
    if (ni !== i || nj !== j) {
      if (piece.length >= 2) out.push({ tile: tileKey(i, j), piece });
      i = ni;
      j = nj;
      piece = [[cx, cz]];
    }
    // Walk the segment, splitting at every grid-line crossing (a segment may
    // cross a tile that holds none of its vertices — rule 2 / criterion 4).
    for (;;) {
      if (cx === x1 && cz === z1) break;
      const dx = x1 - cx;
      const dz = z1 - cz;
      let tx = Infinity;
      let tz = Infinity;
      let ni2 = i;
      let nj2 = j;
      if (dx > 0) {
        const bx = (i + 1) * tileSize;
        tx = (bx - cx) / dx;
        ni2 = i + 1;
      } else if (dx < 0) {
        const bx = i * tileSize;
        tx = (bx - cx) / dx;
        ni2 = i - 1;
      }
      if (dz > 0) {
        const bz = (j + 1) * tileSize;
        tz = (bz - cz) / dz;
        nj2 = j + 1;
      } else if (dz < 0) {
        const bz = j * tileSize;
        tz = (bz - cz) / dz;
        nj2 = j - 1;
      }
      const t = Math.min(tx, tz, 1);
      const px = cx + t * dx;
      const pz = cz + t * dz;
      const last = piece[piece.length - 1];
      if (last[0] !== px || last[1] !== pz) piece.push([px, pz]);
      if (t === 1) {
        cx = px;
        cz = pz;
        break;
      }
      // Crossing a grid line: the crossing point (computed once) is the last
      // point of the outgoing piece and the first of the incoming one.
      if (piece.length >= 2) out.push({ tile: tileKey(i, j), piece });
      if (tx === tz) {
        i = ni2;
        j = nj2;
      } else if (tx < tz) {
        i = ni2;
      } else {
        j = nj2;
      }
      piece = [[px, pz]];
      cx = px;
      cz = pz;
    }
  }
  if (piece.length >= 2) out.push({ tile: tileKey(i, j), piece });
  return out;
}

/** Build the per-tile `TileData` object (v first, optional keys only when non-empty). */
function makeTileData(buildings, roads, trees, woods) {
  return {
    v: 1,
    buildings,
    roads,
    ...(trees.length > 0 ? { trees } : {}),
    ...(woods.length > 0 ? { woods } : {}),
  };
}

/**
 * Tile a monolithic `CityData` into a tiled dataset (docs/data-format.md
 * "Tiled datasets"). Validates the input with `validateCity` first (rule 7).
 * Elements are assigned to exactly one tile by their anchor (rule 1); roads
 * are split at tile boundaries except bridges (rules 2–3); landmarks come out
 * in tile scan order (rule 4); `tiles[key].bytes` is the byte length of the
 * tile file as written (rule 6); empty tiles are absent (data-format).
 * Deterministic: the same input yields the same `index` and `tiles`.
 *
 * @param {object} city validated `CityData`
 * @param {number} tileSize metres per tile edge (> 0)
 * @returns {{index: object, tiles: Map<string, object>}}
 *   `index` = `TileIndexData`; `tiles` = Map of `"i_j"` → `TileData`
 */
export function tileCity(city, tileSize) {
  if (!Number.isFinite(tileSize) || tileSize <= 0) {
    throw new Error('tileSize: must be a positive number');
  }
  validateCity(city);

  // Rule 3: bridge roads are global — whole polylines, never split.
  const bridgeRoads = city.roads.filter((r) => r.bridge);

  const tiles = new Map(); // "i_j" -> { buildings, roads, trees, woods }
  const getTile = (key) => {
    let t = tiles.get(key);
    if (!t) {
      t = { buildings: [], roads: [], trees: [], woods: [] };
      tiles.set(key, t);
    }
    return t;
  };

  // Rule 1: buildings by unrounded vertex-mean centroid; woods by vertex mean;
  // trees by their (x, z). Input order preserved within each tile.
  for (const b of city.buildings) {
    const [cx, cz] = vertexMean(b.poly);
    const [i, j] = tileOf(cx, cz, tileSize);
    getTile(tileKey(i, j)).buildings.push(b);
  }
  if (city.woods) {
    for (const ring of city.woods) {
      const [cx, cz] = vertexMean(ring);
      const [i, j] = tileOf(cx, cz, tileSize);
      getTile(tileKey(i, j)).woods.push(ring);
    }
  }
  if (city.trees) {
    for (const tree of city.trees) {
      const [i, j] = tileOf(tree[0], tree[1], tileSize);
      getTile(tileKey(i, j)).trees.push(tree);
    }
  }

  // Rules 2–3: split non-bridge roads; bridges are already in bridgeRoads.
  for (const r of city.roads) {
    if (r.bridge) continue;
    for (const { tile, piece } of splitRoad(r.pts, tileSize)) {
      getTile(tile).roads.push({
        id: r.id,
        ...(r.name !== undefined ? { name: r.name } : {}),
        cls: r.cls,
        pts: piece,
      });
    }
  }

  // Rule 4: one landmark per named building, in tile scan order
  // (j ascending, then i, then input order), anchored by the same centroid.
  const named = [];
  city.buildings.forEach((b, idx) => {
    if (b.name !== undefined) {
      const [cx, cz] = vertexMean(b.poly);
      const [i, j] = tileOf(cx, cz, tileSize);
      named.push({ b, idx, i, j, cx, cz });
    }
  });
  named.sort((a, c) => a.j - c.j || a.i - c.i || a.idx - c.idx);
  const landmarks = named.map((n) => ({ name: n.b.name, x: n.cx, z: n.cz }));

  // Rule 6: per-tile stats, bytes = serialized tile length as written.
  const tileMap = new Map();
  const stats = {};
  for (const [key, t] of tiles) {
    const tileData = makeTileData(t.buildings, t.roads, t.trees, t.woods);
    tileMap.set(key, tileData);
    stats[key] = {
      buildings: t.buildings.length,
      roads: t.roads.length,
      trees: t.trees.length,
      bytes: Buffer.byteLength(JSON.stringify(tileData), 'utf8'),
    };
  }

  const index = {
    v: 1,
    tiled: true,
    origin: city.origin,
    bbox: city.bbox,
    tileSize,
    bridgeRoads,
    landmarks,
    // Rule 5: places are global.
    places: city.places,
    tiles: stats,
    ...(city.terrain ? { terrain: city.terrain } : {}),
    ...(city.water ? { water: city.water } : {}),
    ...(city.waterLevels ? { waterLevels: city.waterLevels } : {}),
    ...(city.rivers ? { rivers: city.rivers } : {}),
  };
  return { index, tiles: tileMap };
}

/** Write a tiled dataset to a directory (`index.json` + `tiles/<key>.json`). */
function writeTiled(outDir, tiled) {
  mkdirSync(join(outDir, 'tiles'), { recursive: true });
  const write = (path, obj) => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, path); // atomic-ish: never a partial file at `path`
  };
  write(join(outDir, 'index.json'), tiled.index);
  for (const [key, tile] of tiled.tiles) {
    write(join(outDir, 'tiles', `${key}.json`), tile);
  }
}

function main() {
  const [inPath, outDir] = process.argv.slice(2);
  if (!inPath || !outDir) {
    process.stderr.write('usage: node scripts/tile-city.mjs <city.json> <outdir>\n');
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(inPath, 'utf8'));
  // Rule 7: validate the monolithic input (throws with a JSON-ish path).
  const city = validateCity(raw);
  const tiled = tileCity(city, DEFAULT_TILE_SIZE);
  writeTiled(outDir, tiled);

  let totalBytes = Buffer.byteLength(JSON.stringify(tiled.index), 'utf8');
  for (const key of tiled.tiles.keys()) totalBytes += tiled.index.tiles[key].bytes;
  const buildings = city.buildings.length;
  const roads = city.roads.length;
  const places = city.places.length;
  process.stdout.write(
    `${outDir}: ${tiled.tiles.size} tiles, ${buildings} buildings, ${roads} roads ` +
      `(${tiled.index.bridgeRoads.length} bridges), ${places} places, ` +
      `${tiled.index.landmarks.length} landmarks, ` +
      `${Math.round(totalBytes / 1024)} KB\n`,
  );
}

// Run the CLI only when this file is the entry point (not when imported by
// fetch-osm.mjs or the tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
