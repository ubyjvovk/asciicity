/**
 * PLATEAU → AsciiCity `Building` mapping, roof inference and OSM matching.
 * Pure functions (no I/O) so `tests/plateau.test.ts` can pin them on inline
 * fixtures. See docs/plateau.md for the rules and the measured numbers.
 */

import { project, round1 } from '../osm-convert.mjs';

const DEG = 180 / Math.PI;

/** Shapes `classifyRoof` can emit that exist in `RoofShape` (types.ts). */
const SCHEMA_SHAPES = new Set(['gabled', 'hipped', 'pyramidal', 'skillion']);

/**
 * Project `[lat, lon, h]` triples to local `[x, z, y]` metres.
 * @param {number[][]} ring file-CRS triples
 * @param {{ lat: number, lon: number }} origin
 * @returns {number[][]}
 */
export function ringToLocal(ring, origin) {
  return ring.map(([lat, lon, h]) => {
    const [x, z] = project(lon, lat, origin);
    return [x, z, h];
  });
}

/**
 * Absolute shoelace area of a 2D ring (`[x, z]`, closed or open).
 * @param {number[][]} ring
 * @returns {number}
 */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/**
 * Normalise a footprint to our `poly` rules: 0.1 m rounding, no repeated
 * closing point, no consecutive duplicates, no collinear vertices (a
 * vertex is dropped when it is < 0.05 m off the line through its
 * neighbours). Returns `[]` when fewer than 3 vertices survive.
 * @param {number[][]} ring `[x, z, …]` points
 * @returns {[number, number][]}
 */
export function cleanRing(ring) {
  let pts = ring.map((p) => [round1(p[0]), round1(p[1])]);
  pts = pts.filter((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return i === pts.length - 1 ? !(p[0] === pts[0][0] && p[1] === pts[0][1]) : !(p[0] === q[0] && p[1] === q[1]);
  });
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      if (len === 0 || cross / len < 0.05) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return pts.length >= 3 && ringArea(pts) > 0 ? pts : [];
}

/** Newell normal (unnormalised, |N| = 2·area) of a 3D `[x, z, y]` ring. */
function newell(ring) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1, y1] = ring[i];
    const [x2, z2, y2] = ring[(i + 1) % ring.length];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  return [nx, ny, nz];
}

/** Degrees normalised to `[0, 360)`. */
function norm360(d) {
  return ((d % 360) + 360) % 360;
}

/**
 * Classify a LOD2 roof from its facets (local `[x, z, y]` rings).
 *
 * Facets < 0.5 m² or steeper than 75° are ignored; facets tilted ≥ 8° are
 * "sloped". Flat-dominated roofs (sloped < 25 % of roof area) are `flat`,
 * or `stepped` when their flat facets sit on ≥ 2 levels (2 m clustering)
 * spanning > 3 m and the top level holds < 70 % of the flat area. Mixed
 * roofs (25–75 % sloped) are `complex`. Sloped roofs bin their facets'
 * downslope bearings into 4 directions around the dominant axis (circular
 * mean of 4θ); > 25 % off-axis area → `complex`; 1 bin → `skillion`,
 * 2 opposite → `gabled`, 3 → `hipped`, 4 → `pyramidal` when the apex
 * vertices lie within 1.5 m of each other, else `hipped`.
 *
 * Flat-family results also carry `topShare` (area share of the highest
 * level), `mainY` (height of the largest level) and `topY`.
 *
 * `h` = highest sloped vertex − lowest sloped vertex (eave). `dir` follows
 * `roofFrame` in src/world/buildings.ts: the ridge axis bearing (degrees
 * clockwise from north); for skillion the roof rises towards `dir + 90`.
 * @param {number[][][]} facets
 * @returns {{ kind: string, h?: number, dir?: number, levels: number, slopedShare: number, topShare?: number, mainY?: number, topY?: number }}
 */
export function classifyRoof(facets) {
  let total = 0;
  let slopedA = 0;
  const sloped = [];
  const flats = [];
  for (const f of facets) {
    if (f.length < 3) continue;
    let [nx, ny, nz] = newell(f);
    const len = Math.hypot(nx, ny, nz);
    const area = len / 2;
    if (area < 0.5) continue;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const tilt = Math.acos(Math.min(1, ny / len)) * DEG;
    if (tilt > 75) continue;
    total += area;
    const ys = f.map((p) => p[2]);
    if (tilt >= 8) {
      slopedA += area;
      sloped.push({ area, bearing: norm360(Math.atan2(nx, -nz) * DEG), pts: f });
    } else {
      flats.push({ area, y: ys.reduce((s, v) => s + v, 0) / ys.length });
    }
  }
  if (total === 0) return { kind: 'none', levels: 0, slopedShare: 0 };
  const slopedShare = slopedA / total;
  const levels = flatLevels(flats);
  if (slopedShare < 0.25) {
    const flatA = flats.reduce((s, f) => s + f.area, 0);
    const span = levels.length ? levels[0].y - levels[levels.length - 1].y : 0;
    const topShare = levels.length ? levels[0].area / flatA : 1;
    const stepped = levels.length >= 2 && span > 3 && topShare < 0.7;
    const main = levels.reduce((m, l) => (l.area > m.area ? l : m), levels[0] ?? { y: NaN, area: 0 });
    return {
      kind: stepped ? 'stepped' : 'flat',
      levels: levels.length,
      slopedShare,
      topShare,
      mainY: main.y,
      topY: levels.length ? levels[0].y : NaN,
    };
  }
  if (slopedShare < 0.75) return { kind: 'complex', levels: levels.length, slopedShare };

  let s4 = 0;
  let c4 = 0;
  for (const s of sloped) {
    s4 += s.area * Math.sin((4 * s.bearing) / DEG);
    c4 += s.area * Math.cos((4 * s.bearing) / DEG);
  }
  const a0 = (Math.atan2(s4, c4) * DEG) / 4;
  const bins = [0, 0, 0, 0];
  let irregular = 0;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of sloped) {
    const d = s.bearing - a0;
    const k = Math.round(d / 90);
    if (Math.abs(d - 90 * k) > 20) irregular += s.area;
    else bins[((k % 4) + 4) % 4] += s.area;
    for (const p of s.pts) {
      yMin = Math.min(yMin, p[2]);
      yMax = Math.max(yMax, p[2]);
    }
  }
  const base = { h: round1(yMax - yMin), levels: levels.length, slopedShare };
  if (irregular / slopedA > 0.25) return { kind: 'complex', ...base };
  const occ = [0, 1, 2, 3].filter((k) => bins[k] >= 0.1 * slopedA);
  const dirOf = (k) => Math.round(norm360(a0 + 90 * k + 90)) % 360;
  if (occ.length === 1) return { kind: 'skillion', dir: dirOf(occ[0]), ...base };
  if (occ.length === 2) {
    return (occ[1] - occ[0]) === 2
      ? { kind: 'gabled', dir: dirOf(occ[0]), ...base }
      : { kind: 'complex', ...base };
  }
  if (occ.length === 3) {
    const k = occ.find((b) => occ.includes((b + 2) % 4));
    return { kind: 'hipped', dir: dirOf(k), ...base };
  }
  const apex = [];
  for (const s of sloped) for (const p of s.pts) if (p[2] >= yMax - 0.3) apex.push(p);
  let spread = 0;
  for (const p of apex) for (const q of apex) spread = Math.max(spread, Math.hypot(p[0] - q[0], p[1] - q[1]));
  if (spread < 1.5) return { kind: 'pyramidal', dir: dirOf(0), ...base };
  return { kind: 'hipped', dir: dirOf(bins[0] + bins[2] >= bins[1] + bins[3] ? 0 : 1), ...base };
}

/** Area-weighted greedy clustering of flat facets into levels (2 m), highest first. */
function flatLevels(flats) {
  const sorted = [...flats].sort((a, b) => b.y - a.y);
  const levels = [];
  for (const f of sorted) {
    const l = levels.find((v) => Math.abs(v.y - f.y) <= 2);
    if (l) {
      l.y = (l.y * l.area + f.y * f.area) / (l.area + f.area);
      l.area += f.area;
    } else levels.push({ y: f.y, area: f.area });
  }
  return levels.sort((a, b) => b.y - a.y);
}

/**
 * Stable numeric `Building.id` for a PLATEAU building: `"13102-bldg-3711"`
 * → `13102 × 10⁷ + 3711` (≥ 1.3·10¹¹, far above today's OSM way ids ≈
 * 1.4·10⁹); without a buildingID, a 40-bit FNV-1a hash of the gml:id
 * offset by 2·10¹².
 * @param {string | undefined} buildingId `uro:buildingID`
 * @param {string} gmlId
 * @returns {number}
 */
export function numericId(buildingId, gmlId) {
  const m = /^(\d{5})-bldg-(\d{1,7})$/.exec(buildingId ?? '');
  if (m) return Number(m[1]) * 1e7 + Number(m[2]);
  let h = 0xcbf29ce484222325n;
  for (const c of Buffer.from(gmlId, 'utf8')) h = BigInt.asUintN(64, (h ^ BigInt(c)) * 0x100000001b3n);
  return 2e12 + Number(h & 0xffffffffffn);
}

/**
 * Map a parsed PLATEAU building onto our `Building`.
 * Footprint: largest LOD0 ring (`lod0FootPrint`, else `lod0RoofEdge`),
 * else the LOD1 solid's lowest face, else the largest LOD2 ground surface.
 * `h`: `measuredHeight`, else LOD1 top − base; clamped to [3, 650].
 * `roof` only for LOD2 roofs classified as a schema shape.
 * @param {import('./citygml').PlateauBuilding} pb
 * @param {{ lat: number, lon: number }} origin
 * @returns {{ building?: object, roof: ReturnType<typeof classifyRoof> | { kind: 'lod1' }, base?: number, skip?: string }}
 */
export function toBuilding(pb, origin) {
  const lod1 = pb.lod1.map((r) => ringToLocal(r, origin));
  const allY = lod1.flat().map((p) => p[2]);
  const base = allY.length ? Math.min(...allY) : undefined;
  const top = allY.length ? Math.max(...allY) : undefined;
  let src = pb.lod0.map((r) => ringToLocal(r, origin));
  if (!src.length && base !== undefined) {
    src = lod1.filter((r) => r.every((p) => Math.abs(p[2] - base) < 0.01));
  }
  if (!src.length) src = pb.grounds.map((r) => ringToLocal(r, origin));
  const ring = src.sort((a, b) => ringArea(b) - ringArea(a))[0];
  const roof = pb.roofs.length
    ? classifyRoof(pb.roofs.map((r) => ringToLocal(r.ring, origin)))
    : { kind: 'lod1' };
  if (!ring) return { roof, skip: 'noFootprint' };
  const poly = cleanRing(ring);
  if (poly.length < 3 || ringArea(poly) < 2) return { roof, skip: 'tinyFootprint' };
  let h = pb.measuredHeight;
  if (!(h > 0) && top !== undefined && base !== undefined) h = top - base;
  if (!(h > 0)) return { roof, skip: 'noHeight' };
  h = Math.min(650, Math.max(3, round1(h)));
  /** @type {Record<string, unknown>} */
  const building = { id: numericId(pb.buildingId, pb.gmlId), h };
  if (pb.name) building.name = pb.name;
  if (SCHEMA_SHAPES.has(roof.kind) && roof.h !== undefined && h - 1 >= 0.5 && roof.h >= 0.5) {
    const r = { shape: roof.kind, h: round1(Math.min(Math.max(roof.h, 0.5), h - 1)) };
    if (roof.dir !== undefined) r.dir = roof.dir;
    building.roof = r;
  }
  building.poly = poly;
  return { building, roof, base };
}

/** Signed shoelace area of an open `[x, z]` ring (> 0 = counter-clockwise on the x/z axes). */
function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Union of edge-sharing facets (a roof partition): orient every ring the
 * same way, cancel each edge that appears in both directions, chain what
 * is left into rings and keep the outer (positively oriented) ones — holes
 * are dropped, which is harmless for tiers because a higher tier fills
 * them. Vertices are keyed at 5 cm. Returns `null` when the leftover edges
 * do not chain into closed rings (T-junctions between facets).
 * @param {number[][][]} rings open `[x, z, …]` rings
 * @returns {number[][][] | null}
 */
export function unionFacets(rings) {
  const key = (p) => `${Math.round(p[0] * 20)},${Math.round(p[1] * 20)}`;
  const pts = new Map();
  const edges = new Map();
  for (const ring of rings) {
    const r = signedArea(ring) < 0 ? [...ring].reverse() : ring;
    for (let i = 0; i < r.length; i++) {
      const a = key(r[i]);
      const b = key(r[(i + 1) % r.length]);
      if (a === b) continue;
      pts.set(a, [r[i][0], r[i][1]]);
      const rev = `${b}|${a}`;
      if (edges.get(rev) > 0) edges.set(rev, edges.get(rev) - 1);
      else edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  const out = new Map();
  let left = 0;
  for (const [e, n] of edges) {
    if (n <= 0) continue;
    const [a, b] = e.split('|');
    for (let k = 0; k < n; k++) {
      if (!out.has(a)) out.set(a, []);
      out.get(a).push(b);
      left++;
    }
  }
  const result = [];
  while (left > 0) {
    const start = [...out.keys()].find((k) => out.get(k).length > 0);
    const ring = [];
    let cur = start;
    do {
      const next = out.get(cur)?.pop();
      if (next === undefined) return null;
      left--;
      ring.push(pts.get(cur));
      cur = next;
    } while (cur !== start);
    if (ring.length >= 3 && signedArea(ring) > 0) result.push(ring);
  }
  return result;
}

/**
 * "What-if" LOD2 tiers: represent a stepped / complex roof with the
 * CURRENT schema as several grounded prisms. Roof facets (≤ 75°, ≥ 0.5 m²)
 * are clustered by their top height (1.5 m, highest first); each cluster
 * is unioned (`unionFacets`, falling back to the raw facets) and every
 * resulting ring ≥ 2 m² becomes `{ id: id × 1000 + k, h: top − base, poly }`.
 * @param {import('./citygml').PlateauBuilding} pb
 * @param {{ lat: number, lon: number }} origin
 * @param {number} base ground height (LOD1 base) in the file's height datum
 * @param {number} id parent building id
 * @returns {{ tiers: object[], fallback: boolean }}
 */
export function lod2Tiers(pb, origin, base, id) {
  const facets = [];
  for (const { ring } of pb.roofs) {
    const local = ringToLocal(ring, origin);
    const [nx, ny, nz] = newell(local);
    const len = Math.hypot(nx, ny, nz);
    if (len / 2 < 0.5 || Math.acos(Math.min(1, Math.abs(ny) / len)) * DEG > 75) continue;
    facets.push({ top: Math.max(...local.map((p) => p[2])), ring: local });
  }
  facets.sort((a, b) => b.top - a.top);
  const clusters = [];
  for (const f of facets) {
    const c = clusters.find((k) => k.top - f.top <= 1.5);
    if (c) c.rings.push(f.ring);
    else clusters.push({ top: f.top, rings: [f.ring] });
  }
  const tiers = [];
  let fallback = false;
  for (const c of clusters) {
    let rings = unionFacets(c.rings);
    if (!rings) {
      fallback = true;
      rings = c.rings;
    }
    const h = Math.min(650, Math.max(3, round1(c.top - base)));
    for (const r of rings) {
      const poly = cleanRing(r);
      if (poly.length < 3 || ringArea(poly) < 2 || tiers.length >= 999) continue;
      tiers.push({ id: id * 1000 + tiers.length, h, poly });
    }
  }
  return { tiers, fallback };
}

/**
 * Even-odd point-in-polygon test.
 * @param {number} x
 * @param {number} z
 * @param {number[][]} ring
 */
export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** `[minX, minZ, maxX, maxZ]` of a ring. */
export function ringBounds(ring) {
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const [x, z] of ring) {
    a = Math.min(a, x);
    b = Math.min(b, z);
    c = Math.max(c, x);
    d = Math.max(d, z);
  }
  return [a, b, c, d];
}

/**
 * Intersection area of two simple polygons by cell-centre sampling of
 * their bbox overlap (cell = √(min area)/20, clamped to [0.25, 2] m).
 * @param {number[][]} a
 * @param {number[][]} b
 * @returns {number} m²
 */
export function intersectionArea(a, b) {
  const [a0, a1, a2, a3] = ringBounds(a);
  const [b0, b1, b2, b3] = ringBounds(b);
  const x0 = Math.max(a0, b0);
  const z0 = Math.max(a1, b1);
  const x1 = Math.min(a2, b2);
  const z1 = Math.min(a3, b3);
  if (x1 <= x0 || z1 <= z0) return 0;
  const s = Math.min(2, Math.max(0.25, Math.sqrt(Math.min(ringArea(a), ringArea(b))) / 20));
  let n = 0;
  for (let x = x0 + s / 2; x < x1; x += s) {
    for (let z = z0 + s / 2; z < z1; z += s) if (pointInRing(x, z, a) && pointInRing(x, z, b)) n++;
  }
  return n * s * s;
}

/**
 * Intersection over union of two footprints (see `intersectionArea`).
 * @param {number[][]} a
 * @param {number[][]} b
 * @returns {number} in [0, 1]
 */
export function iou(a, b) {
  const i = intersectionArea(a, b);
  if (i === 0) return 0;
  return Math.min(1, i / (ringArea(a) + ringArea(b) - i));
}

/**
 * Match every PLATEAU footprint against OSM footprints: best-IoU partner
 * (`j = -1` when nothing overlaps) and `covered` = share of the PLATEAU
 * footprint lying under ANY OSM footprint (capped at 1 — OSM parts overlap
 * their neighbours). Uses a 50 m bucket grid over the OSM bboxes.
 * @param {number[][][]} plateau footprints
 * @param {number[][][]} osm footprints
 * @returns {{ j: number, iou: number, covered: number }[]}
 */
export function matchFootprints(plateau, osm) {
  const G = 50;
  const grid = new Map();
  osm.forEach((ring, j) => {
    const [x0, z0, x1, z1] = ringBounds(ring);
    for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) {
      for (let gz = Math.floor(z0 / G); gz <= Math.floor(z1 / G); gz++) {
        const k = `${gx},${gz}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(j);
      }
    }
  });
  return plateau.map((ring) => {
    const [x0, z0, x1, z1] = ringBounds(ring);
    const cand = new Set();
    for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) {
      for (let gz = Math.floor(z0 / G); gz <= Math.floor(z1 / G); gz++) {
        for (const j of grid.get(`${gx},${gz}`) ?? []) cand.add(j);
      }
    }
    const area = ringArea(ring);
    let best = { j: -1, iou: 0, covered: 0 };
    let inter = 0;
    for (const j of [...cand].sort((p, q) => p - q)) {
      const i = intersectionArea(ring, osm[j]);
      if (i === 0) continue;
      inter += i;
      const u = Math.min(1, i / (area + ringArea(osm[j]) - i));
      if (u > best.iou) best = { j, iou: u, covered: 0 };
    }
    best.covered = area > 0 ? Math.min(1, inter / area) : 0;
    return best;
  });
}

/**
 * TS-free re-check of the `validateCity` building rules (validate.ts):
 * unique finite ids, `h` in [3, 650], `minH` in [0, h − 1), `roof` shape /
 * `h` in [0.5, h − minH − 1] / `dir` in [0, 360), `poly` ≥ 3 finite points.
 * @param {object[]} buildings
 * @returns {string[]} error messages (empty = valid)
 */
export function checkBuildings(buildings) {
  const errs = [];
  const ids = new Set();
  const shapes = new Set(['gabled', 'hipped', 'pyramidal', 'skillion', 'dome', 'onion', 'round']);
  buildings.forEach((b, i) => {
    const at = `buildings[${i}]`;
    if (!Number.isFinite(b.id)) errs.push(`${at}.id: not finite`);
    else if (ids.has(b.id)) errs.push(`${at}.id: duplicate`);
    ids.add(b.id);
    if (!(Number.isFinite(b.h) && b.h >= 3 && b.h <= 650)) errs.push(`${at}.h: out of [3, 650]`);
    const minH = b.minH ?? 0;
    if (!(Number.isFinite(minH) && minH >= 0 && minH < b.h - 1)) errs.push(`${at}.minH: out of range`);
    if (b.roof !== undefined) {
      const r = b.roof;
      if (!shapes.has(r.shape)) errs.push(`${at}.roof.shape: unknown`);
      if (!(Number.isFinite(r.h) && r.h >= 0.5 && r.h <= b.h - minH - 1)) errs.push(`${at}.roof.h: out of range`);
      if (r.dir !== undefined && !(Number.isFinite(r.dir) && r.dir >= 0 && r.dir < 360)) {
        errs.push(`${at}.roof.dir: out of [0, 360)`);
      }
    }
    if (!Array.isArray(b.poly) || b.poly.length < 3) errs.push(`${at}.poly: < 3 points`);
    else if (!b.poly.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) {
      errs.push(`${at}.poly: non-finite point`);
    }
  });
  return errs;
}
