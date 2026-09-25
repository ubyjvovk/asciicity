/**
 * PLATEAU × OSM building merge and in-place retiling for the production
 * Tokyo converter (T-0163, `tokyo.mjs`). Pure functions, no I/O, so
 * `tests/plateau.test.ts` pins every rule on hand-made fixtures.
 *
 * Rules: docs/data-format.md "Tokyo from PLATEAU (wave 22)" items 1–6;
 * tiling: "Tiled datasets" rules 1, 4, 6 (same anchor as
 * `scripts/tile-city.mjs`). Measured numbers: docs/plateau.md
 * "Production converter".
 */

import { intersectionArea, lod2Tiers, pointInRing, ringArea, ringBounds, toBuilding } from './map.mjs';

/** Lowest PLATEAU building id: 2^48, far above OSM way ids (≈ 1.4·10⁹) and curated extras (−1000…−999999). */
export const PLATEAU_ID_BASE = 2 ** 48;

/** Cap on `Building.tiers` (data-format "Tokyo from PLATEAU" rule 2). */
export const MAX_TIERS = 64;

/**
 * Stable numeric `Building.id` of a PLATEAU building: the low 48 bits of the
 * 64-bit FNV-1a hash of its `gml:id`, offset by 2^48 → `[2^48, 2^49)` (exact
 * doubles; no overlap with OSM ids or curated extras). Collisions are
 * resolved by the caller (`assignIds`).
 * @param {string} gmlId
 * @returns {number}
 */
export function plateauId(gmlId) {
  let h = 0xcbf29ce484222325n;
  for (const c of Buffer.from(gmlId, 'utf8')) h = BigInt.asUintN(64, (h ^ BigInt(c)) * 0x100000001b3n);
  return PLATEAU_ID_BASE + Number(h & 0xffffffffffffn);
}

/**
 * True when an id is in the PLATEAU range of `plateauId`.
 * @param {number} id
 * @returns {boolean}
 */
export function isPlateauId(id) {
  return id >= PLATEAU_ID_BASE && id < 2 * PLATEAU_ID_BASE;
}

/**
 * Give every entry `plateauId(gmlId)`, walking in the given (sorted) order
 * and bumping a colliding id by +1 until free (deterministic for a fixed
 * input order).
 * @param {{ gmlId: string, building: { id: number } }[]} rows
 * @returns {number} number of collisions resolved
 */
export function assignIds(rows) {
  const used = new Set();
  let collisions = 0;
  for (const r of rows) {
    let id = plateauId(r.gmlId);
    while (used.has(id)) {
      id = id + 1 >= 2 * PLATEAU_ID_BASE ? PLATEAU_ID_BASE : id + 1;
      collisions++;
    }
    used.add(id);
    r.building.id = id;
  }
  return collisions;
}

/**
 * Arithmetic mean of a ring's vertices — the tiler's building anchor
 * (`scripts/tile-city.mjs` `vertexMean`, data-format "Tiled datasets"
 * rule 1), unrounded.
 * @param {number[][]} ring
 * @returns {[number, number]}
 */
export function vertexMean(ring) {
  let sx = 0;
  let sz = 0;
  for (const [x, z] of ring) {
    sx += x;
    sz += z;
  }
  return [sx / ring.length, sz / ring.length];
}

/**
 * Tile key `"i_j"` of a building by the tiler's rule: unrounded vertex-mean
 * centroid, `Math.floor(c / tileSize)`.
 * @param {number[][]} poly
 * @param {number} tileSize
 * @returns {string}
 */
export function buildingTileKey(poly, tileSize) {
  const [cx, cz] = vertexMean(poly);
  return `${Math.floor(cx / tileSize)}_${Math.floor(cz / tileSize)}`;
}

/** Bucket grid over ring bboxes (cell `G` m) for overlap candidate search. */
class RingGrid {
  /** @param {number[][][]} rings @param {number} [G] */
  constructor(rings, G = 50) {
    this.G = G;
    this.rings = rings;
    this.bounds = rings.map(ringBounds);
    /** @type {Map<string, number[]>} */
    this.cells = new Map();
    this.bounds.forEach(([x0, z0, x1, z1], j) => {
      for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) {
        for (let gz = Math.floor(z0 / G); gz <= Math.floor(z1 / G); gz++) {
          const k = `${gx},${gz}`;
          let c = this.cells.get(k);
          if (!c) this.cells.set(k, (c = []));
          c.push(j);
        }
      }
    });
  }

  /** Indices whose bbox overlaps `[x0, z0, x1, z1]` (strictly), ascending. */
  query([x0, z0, x1, z1]) {
    const G = this.G;
    const out = new Set();
    for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) {
      for (let gz = Math.floor(z0 / G); gz <= Math.floor(z1 / G); gz++) {
        for (const j of this.cells.get(`${gx},${gz}`) ?? []) {
          const b = this.bounds[j];
          if (b[0] < x1 && b[2] > x0 && b[1] < z1 && b[3] > z0) out.add(j);
        }
      }
    }
    return [...out].sort((p, q) => p - q);
  }
}

/**
 * Share of `ring`'s area covered by the UNION of `others` (cell-centre
 * sampling of the ring's bbox, cell = √area / 20 clamped to [0.25, 2] m —
 * the `intersectionArea` resolution). Overlapping `others` count once.
 * @param {number[][]} ring
 * @param {number[][][]} others
 * @returns {number} in [0, 1]
 */
export function coveredShare(ring, others) {
  if (!others.length) return 0;
  const [x0, z0, x1, z1] = ringBounds(ring);
  const s = Math.min(2, Math.max(0.25, Math.sqrt(ringArea(ring)) / 20));
  const ob = others.map(ringBounds);
  let inside = 0;
  let hit = 0;
  for (let x = x0 + s / 2; x < x1; x += s) {
    for (let z = z0 + s / 2; z < z1; z += s) {
      if (!pointInRing(x, z, ring)) continue;
      inside++;
      for (let k = 0; k < others.length; k++) {
        const b = ob[k];
        if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && pointInRing(x, z, others[k])) {
          hit++;
          break;
        }
      }
    }
  }
  return inside ? hit / inside : 0;
}

/**
 * Flag the OSM buildings that are `building:part` massing (data-format
 * "Tokyo from PLATEAU" rule 5). Our tiles do not keep the OSM tag, so parts
 * are recognised by their geometry. A STACK is a set of OSM buildings
 * linked by plan overlaps ≥ 50 % of the smaller footprint (a lone building
 * is a stack of one). Every member of a stack with 3D massing is a part:
 * the stack holds a raised part (`minH > 0` — Skytree's decks) or ≥ 3
 * distinct heights (Tokyo Tower's concentric grounded tiers). Duplicated
 * outlines (same height) and outline + canopy pairs are NOT parts.
 * @param {{ poly: number[][], minH?: number }[]} osm
 * @returns {boolean[]}
 */
export function osmPartFlags(osm) {
  const rings = osm.map((b) => b.poly);
  const grid = new RingGrid(rings);
  const areas = rings.map(ringArea);
  const parent = osm.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  /** root → { raised, heights } of the stack */
  const stacks = new Map();
  osm.forEach((b, i) => {
    for (const j of grid.query(grid.bounds[i])) {
      if (j <= i) continue;
      const inter = intersectionArea(rings[i], rings[j]);
      if (inter >= 0.5 * Math.min(areas[i], areas[j])) parent[find(i)] = find(j);
    }
  });
  osm.forEach((b, i) => {
    const r = find(i);
    let st = stacks.get(r);
    if (!st) stacks.set(r, (st = { raised: false, heights: new Set() }));
    if ((b.minH ?? 0) > 0) st.raised = true;
    st.heights.add(b.h);
  });
  return osm.map((_, i) => {
    const st = stacks.get(find(i));
    return st.raised || st.heights.size >= 3;
  });
}

/**
 * Apply merge rules 3–5 of data-format "Tokyo from PLATEAU":
 *
 * - rule 5: OSM parts (`osmPartFlags`) are kept and SUPPRESS every PLATEAU
 *   building whose footprint is ≥ 30 % covered by the union of the parts;
 * - rule 4: non-part OSM buildings covered < 20 % by the union of the kept
 *   PLATEAU footprints are kept as they are;
 * - rule 3: each kept PLATEAU building is named after its best-IoU non-part
 *   OSM partner when IoU ≥ 0.5 and that partner has a name; else after the
 *   named non-part OSM building it covers ≥ 50 % (largest overlap wins);
 *   else its PLATEAU `gml:name` (`plateauName`); else no name.
 *
 * Output order: kept OSM buildings (input order: parts and rule-4 keeps
 * interleaved as given), then kept PLATEAU buildings (input order). Inputs
 * are not mutated; PLATEAU buildings are shallow-copied with the name set.
 * @param {{ building: object, plateauName?: string }[]} plateau
 * @param {object[]} osm OSM buildings (tile order)
 * @returns {{ buildings: object[], stats: Record<string, number> }}
 */
export function mergeBuildings(plateau, osm) {
  const isPart = osmPartFlags(osm);
  const partIdx = osm.map((_, i) => i).filter((i) => isPart[i]);
  const partGrid = new RingGrid(partIdx.map((i) => osm[i].poly));

  // Rule 5.
  const suppressed = plateau.map(({ building }) => {
    const ring = building.poly;
    const cand = partGrid.query(ringBounds(ring)).map((k) => osm[partIdx[k]].poly);
    return cand.length > 0 && coveredShare(ring, cand) >= 0.3;
  });
  const kept = plateau.filter((_, k) => !suppressed[k]);
  const plateauRings = kept.map((r) => r.building.poly);
  const pGrid = new RingGrid(plateauRings);

  // Rule 4 + the overlap pairs for rule 3 (non-part OSM only).
  const osmKeep = osm.map((_, i) => isPart[i]);
  /** best IoU partner per kept PLATEAU building: [iou, osmIndex] */
  const best = kept.map(() => [0, -1]);
  /** rule-3b candidate per kept PLATEAU building: [overlap m², osmIndex] */
  const cover = kept.map(() => [0, -1]);
  let osmKept = 0;
  osm.forEach((b, i) => {
    if (isPart[i]) return;
    const cand = pGrid.query(ringBounds(b.poly));
    const area = ringArea(b.poly);
    for (const k of cand) {
      const inter = intersectionArea(b.poly, plateauRings[k]);
      if (inter === 0) continue;
      const u = Math.min(1, inter / (area + ringArea(plateauRings[k]) - inter));
      if (u > best[k][0]) best[k] = [u, i];
      if (b.name !== undefined && inter >= 0.5 * area && inter > cover[k][0]) cover[k] = [inter, i];
    }
    if (coveredShare(b.poly, cand.map((k) => plateauRings[k])) < 0.2) {
      osmKeep[i] = true;
      osmKept++;
    }
  });

  let byIou = 0;
  let byCover = 0;
  let byPlateau = 0;
  const out = kept.map((r, k) => {
    const b = { ...r.building };
    delete b.name;
    let name;
    const [u, j] = best[k];
    if (u >= 0.5 && osm[j].name !== undefined) {
      name = osm[j].name;
      byIou++;
    } else if (cover[k][1] >= 0) {
      name = osm[cover[k][1]].name;
      byCover++;
    } else if (r.plateauName) {
      name = r.plateauName;
      byPlateau++;
    }
    // Keep the Building key order of `toBuilding`: id, h, name, …, poly.
    return name === undefined ? b : { id: b.id, h: b.h, name, ...b };
  });

  return {
    buildings: [...osm.filter((_, i) => osmKeep[i]), ...out],
    stats: {
      plateauIn: plateau.length,
      plateauKept: kept.length,
      suppressedByParts: plateau.length - kept.length,
      osmIn: osm.length,
      osmParts: partIdx.length,
      osmKeptUncovered: osmKept,
      osmDropped: osm.length - osmKept - partIdx.length,
      namesByIou: byIou,
      namesByCover: byCover,
      namesFromPlateau: byPlateau,
    },
  };
}

/**
 * LOD2 massing → `Building.tiers` (rule 2) for a stepped / complex roof:
 * `lod2Tiers` clusters (1.5 m) unioned per level with holes cut open
 * (`splitHoles`), ids dropped, each tier `h`
 * clamped to `[1, h]`. Returns `null` (keep the plain envelope) when fewer
 * than 2 tiers survive, more than `MAX_TIERS`, or two tiers overlap in plan
 * by > 5 % of the smaller one (overhanging facets).
 * @param {import('./citygml').PlateauBuilding} pb
 * @param {{ lat: number, lon: number }} origin
 * @param {number} base LOD1 base height (file datum)
 * @param {number} h the envelope height (`Building.h`)
 * @returns {{ tiers: { h: number, poly: number[][] }[] | null, reason?: string }}
 */
export function buildTiers(pb, origin, base, h) {
  const { tiers } = lod2Tiers(pb, origin, base, 0, { splitHoles: true });
  if (tiers.length < 2) return { tiers: null, reason: 'single' };
  if (tiers.length > MAX_TIERS) return { tiers: null, reason: 'overCap' };
  const out = tiers.map((t) => ({ h: Math.min(h, Math.max(1, t.h)), poly: t.poly }));
  const bounds = out.map((t) => ringBounds(t.poly));
  const areas = out.map((t) => ringArea(t.poly));
  for (let a = 0; a < out.length; a++) {
    for (let b = a + 1; b < out.length; b++) {
      const p = bounds[a];
      const q = bounds[b];
      if (p[0] >= q[2] || q[0] >= p[2] || p[1] >= q[3] || q[1] >= p[3]) continue;
      if (intersectionArea(out[a].poly, out[b].poly) > 0.05 * Math.min(areas[a], areas[b])) {
        return { tiers: null, reason: 'overlap' };
      }
    }
  }
  return { tiers: out };
}

/**
 * Re-assign a city's buildings to tiles in place of the old ones
 * (data-format "Tiled datasets" rules 1, 4, 6): every building goes to
 * `buildingTileKey`; each tile keeps its roads / trees / woods and key
 * order, gets the new `buildings` (input order), and its `TileStat` is
 * recomputed (`bytes` = serialized length). Tiles that gain buildings but
 * did not exist are created (`{ v, buildings, roads: [] }`, appended to
 * `index.tiles` in (j, i) order); tiles left with no content at all are
 * dropped. `index.landmarks` is rebuilt from the named buildings in tile
 * scan order (j, then i, then input order). Inputs are not mutated.
 * @param {object} index `TileIndexData`
 * @param {Map<string, object>} tiles key → `TileData`
 * @param {object[]} buildings the complete new building set, in order
 * @returns {{ index: object, tiles: Map<string, object>, removed: string[], created: string[] }}
 */
export function retile(index, tiles, buildings) {
  const S = index.tileSize;
  const byTile = new Map();
  const named = [];
  buildings.forEach((b, idx) => {
    const [cx, cz] = vertexMean(b.poly);
    const i = Math.floor(cx / S);
    const j = Math.floor(cz / S);
    const key = `${i}_${j}`;
    if (!byTile.has(key)) byTile.set(key, []);
    byTile.get(key).push(b);
    if (b.name !== undefined) named.push({ name: b.name, x: cx, z: cz, i, j, idx });
  });
  named.sort((a, c) => a.j - c.j || a.i - c.i || a.idx - c.idx);

  const parse = (k) => k.split('_').map(Number);
  const created = [...byTile.keys()]
    .filter((k) => !tiles.has(k))
    .sort((a, c) => parse(a)[1] - parse(c)[1] || parse(a)[0] - parse(c)[0]);
  const outTiles = new Map();
  const stats = {};
  const removed = [];
  for (const key of [...Object.keys(index.tiles), ...created]) {
    const old = tiles.get(key) ?? { v: 1, buildings: [], roads: [] };
    const tile = { ...old, buildings: byTile.get(key) ?? [] };
    const empty =
      tile.buildings.length === 0 &&
      tile.roads.length === 0 &&
      !(tile.trees?.length > 0) &&
      !(tile.woods?.length > 0);
    if (empty) {
      removed.push(key);
      continue;
    }
    outTiles.set(key, tile);
    stats[key] = {
      buildings: tile.buildings.length,
      roads: tile.roads.length,
      trees: tile.trees?.length ?? 0,
      bytes: Buffer.byteLength(JSON.stringify(tile), 'utf8'),
    };
  }
  const outIndex = {
    ...index,
    landmarks: named.map(({ name, x, z }) => ({ name, x, z })),
    tiles: stats,
  };
  return { index: outIndex, tiles: outTiles, removed, created };
}

/**
 * One PLATEAU building → our `Building` (data-format "Tokyo from PLATEAU"
 * rules 1–2): `toBuilding` (LOD1 envelope, `measuredHeight`, schema roofs),
 * then `buildTiers` for stepped / complex LOD2 roofs. A building never
 * carries both `roof` and `tiers`. The PLATEAU `gml:name` is returned as
 * `plateauName` (not set on the building — naming is merge rule 3); the id
 * is a placeholder until `assignIds`. Key order: id, h, roof | tiers, poly.
 * @param {import('./citygml').PlateauBuilding} pb
 * @param {{ lat: number, lon: number }} origin
 * @returns {{ building?: object, plateauName?: string, kind: string, skip?: string, tierReject?: string }}
 */
export function convertBuilding(pb, origin) {
  const conv = toBuilding(pb, origin);
  if (!conv.building) return { kind: conv.roof.kind, skip: conv.skip };
  const { poly, name, ...rest } = conv.building;
  const building = { ...rest };
  let tierReject;
  if ((conv.roof.kind === 'stepped' || conv.roof.kind === 'complex') && conv.base !== undefined) {
    const t = buildTiers(pb, origin, conv.base, building.h);
    if (t.tiers) {
      delete building.roof;
      building.tiers = t.tiers;
    } else tierReject = t.reason;
  }
  building.poly = poly;
  return { building, kind: conv.roof.kind, ...(name ? { plateauName: name } : {}), ...(tierReject ? { tierReject } : {}) };
}
