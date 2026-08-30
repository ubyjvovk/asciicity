/**
 * OSM → AsciiCity JSON conversion (pure logic, zero dependencies, node ≥ 22).
 *
 * Mirrors `docs/data-format.md` "OSM → JSON conversion rules". This module is
 * pure: it takes an Overpass `[out:json]` response (a `{elements: [...]}`
 * object) plus the projection origin and returns a `CityData` object matching
 * `src/data/types.ts`. The browser never imports this — `fetch-osm.mjs` runs
 * it once at data-generation time.
 *
 * Every element is expected to carry its own coordinates (the Overpass
 * `out geom;` mode), so no node-id lookup is needed.
 *
 * @typedef {{lat:number, lon:number}} LatLon
 * @typedef {{v:1, origin:LatLon, bbox:[number,number,number,number],
 *   buildings:Array<Object>, roads:Array<Object>, places:Array<Object>}} CityData
 */

import { buildTerrain } from './dem.mjs';

const DEG = Math.PI / 180;

/** Default City of London bbox (minLon,minLat,maxLon,maxLat) per data-format. */
const DEFAULT_BBOX = [-0.130, 51.497, -0.070, 51.521];

/**
 * Project WGS84 lon/lat to local metres relative to `origin`
 * (equirectangular; fine for a few-km box).
 * @param {number} lon longitude in degrees
 * @param {number} lat latitude in degrees
 * @param {LatLon} origin projection origin
 * @returns {[number, number]} `[x, z]` — x east, z south (matches data-format)
 */
export function project(lon, lat, origin) {
  const x = (lon - origin.lon) * Math.cos(origin.lat * DEG) * 111320;
  const z = -(lat - origin.lat) * 110574;
  return [x, z];
}

/**
 * Round a local-metre value to 0.1 m (keeps the file small).
 * @param {number} v metres
 * @returns {number} value rounded to one decimal
 */
export function round1(v) {
  return Math.round(v * 10) / 10;
}

/** OSM `highway` value → `cls` per the data-format mapping table. */
const ROAD_CLASS = {
  trunk: 'primary',
  trunk_link: 'primary',
  motorway: 'primary',
  motorway_link: 'primary',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  unclassified: 'tertiary',
  residential: 'residential',
  living_street: 'residential',
  service: 'service',
  pedestrian: 'pedestrian',
  // footway and cycleway are deliberately unmapped (dropped like `steps`):
  // pedestrian/cycle paths are invisible at cell resolution and were ~40 % of
  // the old file. `footway`/`cycleway` stay in the `RoadClass` type/validator
  // for compatibility, just never emitted. Exception (wave 5): a footway or
  // cycleway with a `bridge` tag ≠ `no` is emitted as `pedestrian` +
  // `bridge: true` (Kyiv Park / Klitschko bridges are `highway=cycleway` +
  // `bridge=yes`); the per-element caller applies that rule.
};

/**
 * Map an OSM `highway` value to a `cls` RoadClass, or null when unmapped.
 * @param {string} highway OSM `highway` tag value
 * @returns {string|null} mapped RoadClass or null (caller drops the way)
 */
export function roadClassOf(highway) {
  return ROAD_CLASS[highway] ?? null;
}

/** Default height (metres) by `building` value; final fallback 14. */
const HEIGHT_BY_BUILDING = {
  cathedral: 30,
  church: 30,
  office: 20,
  commercial: 20,
  apartments: 15,
  residential: 15,
  retail: 10,
};

/**
 * Compute a building's height in metres from OSM tags per data-format rules:
 * `height` tag (ft honored) → `building:levels` (×3.3 + 2, plus roof levels)
 * → default by `building` value. Always clamped to [3, 650].
 * @param {Record<string, string>} tags OSM way/relation tags
 * @returns {number} height in metres
 */
export function heightOf(tags) {
  let h;
  const height = tags.height;
  if (height !== undefined && height !== null && height !== '') {
    const m = /^\s*([0-9]+(?:\.[0-9]+)?)/.exec(height);
    if (m) {
      h = parseFloat(m[1]);
      if (/ft\s*$/.test(height.trim())) h *= 0.3048;
    }
  }
  if (h === undefined) {
    const levels = tags['building:levels'];
    if (levels !== undefined && levels !== null && levels !== '') {
      const L = parseFloat(levels);
      if (Number.isFinite(L) && L > 0) {
        h = L * 3.3 + 2;
        const roof = tags['roof:levels'];
        if (roof !== undefined && roof !== null && roof !== '') {
          const R = parseFloat(roof);
          if (Number.isFinite(R)) h += R * 3;
        }
      }
    }
  }
  if (h === undefined) {
    const b = (tags.building || '').toLowerCase();
    h = HEIGHT_BY_BUILDING[b] ?? 14;
  }
  return Math.min(650, Math.max(3, h));
}

/**
 * Base height in metres for a `building:part` (`min_height` ft-aware like
 * `height`, else `building:min_level × 3.3`). Absent / unparseable → 0.
 * @param {Record<string, string>} tags OSM way/relation tags
 * @returns {number} metres above ground (0 when grounded)
 */
function minHeightOf(tags) {
  let h;
  const minHeight = tags.min_height;
  if (minHeight !== undefined && minHeight !== null && minHeight !== '') {
    const m = /^\s*([0-9]+(?:\.[0-9]+)?)/.exec(minHeight);
    if (m) {
      h = parseFloat(m[1]);
      if (/ft\s*$/.test(String(minHeight).trim())) h *= 0.3048;
    }
  }
  if (h === undefined) {
    const levels = tags['building:min_level'];
    if (levels !== undefined && levels !== null && levels !== '') {
      const L = parseFloat(levels);
      if (Number.isFinite(L) && L > 0) h = L * 3.3;
    }
  }
  if (h === undefined || !Number.isFinite(h) || h <= 0) return 0;
  return h;
}

/** True when tags mark an OSM `building:part` (any value other than `no`). */
function isBuildingPart(tags) {
  const v = tags['building:part'];
  return v !== undefined && v !== null && v !== '' && v !== 'no';
}

/**
 * True when the element is below grade — an OSM subway-station footprint or
 * similar underground structure. Data-format.md "Building parts" rule 3b:
 * such elements are not buildings for our render (they would surface as boxes
 * on the street) and must never be emitted or claim surface parts. Matches
 * `layer` < 0, `location=underground`, or `underground=yes`.
 * @param {Record<string, string>} tags OSM tags
 * @returns {boolean}
 */
function isBelowGrade(tags) {
  if (tags.location === 'underground') return true;
  if (tags.underground === 'yes') return true;
  const layer = tags.layer;
  if (layer !== undefined && layer !== null && layer !== '') {
    const n = parseFloat(layer);
    if (Number.isFinite(n) && n < 0) return true;
  }
  return false;
}

/** Signed ring area (shoelace) in m²; used to drop degenerate footprints. */
function ringArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

/**
 * Convert a closed Overpass geometry list into a local-metre ring: drops the
 * repeated closing point, rounds to 0.1 m, cleans up points that collapse to
 * duplicates after rounding, and rejects open/short/degenerate (< 1 m²) rings.
 * @param {Array<LatLon>|undefined} geom Overpass `geometry` (lat/lon points)
 * @param {LatLon} origin projection origin
 * @returns {[number,number][]|null} ring of [x,z] pairs, or null if unusable
 */
function toRing(geom, origin) {
  if (!Array.isArray(geom) || geom.length < 4) return null;
  const first = geom[0];
  const last = geom[geom.length - 1];
  if (!(first.lat === last.lat && first.lon === last.lon)) return null; // open
  // (3) drop the ring if fewer than 3 points remain or |area| < 1 m².
  const cleaned = cleanRing(
    geom.slice(0, -1).map((p) => {
      const [x, z] = project(p.lon, p.lat, origin);
      return [round1(x), round1(z)];
    }),
  );
  if (cleaned.length < 3) return null;
  if (ringArea(cleaned) < 1) return null; // degenerate
  return cleaned;
}

/**
 * Clean a rounded local-metre ring: drop any point equal to the previous
 * point, and keep dropping the last point while it equals the first (this
 * also handles the closing-point collapse where `poly` repeats its first
 * point). Shared by buildings and water. Returns the cleaned ring (may be
 * < 3 points once degenerate input is filtered).
 * @param {Array<[number, number]>} poly rounded local-metre ring
 * @returns {Array<[number, number]>} cleaned ring
 */
function cleanRing(poly) {
  // Rounding to 0.1 m can collapse distinct source points onto the same cell;
  // drop those before emitting so the ring passes `validateCity` and has no
  // duplicated vertices.
  const cleaned = [];
  for (const pt of poly) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) cleaned.push(pt);
  }
  while (cleaned.length > 0) {
    const f0 = cleaned[0][0];
    const f1 = cleaned[0][1];
    const l0 = cleaned[cleaned.length - 1][0];
    const l1 = cleaned[cleaned.length - 1][1];
    if (f0 === l0 && f1 === l1) cleaned.pop();
    else break;
  }
  return cleaned;
}

/** True when two WGS84 points coincide within the chaining epsilon (1e-7°). */
function sameLatLon(a, b) {
  return (
    Math.abs(a.lon - b.lon) < 1e-7 && Math.abs(a.lat - b.lat) < 1e-7
  );
}

/**
 * Assemble water rings from a list of OSM ways/relation-outer members:
 * closed ways become rings directly; open ways are chained greedily by
 * matching endpoints (equal lon/lat within 1e-7) until they close. Returns
 * the assembled closed rings and how many open chains could not be closed.
 * @param {Array<{id: unknown, geometry: Array<{lon:number,lat:number}>}>} ways
 * @returns {{rings: Array<Array<{lon:number,lat:number}>>, dropped: number}}
 */
function assembleRingsInternal(ways) {
  const rings = [];
  const open = [];
  for (const w of ways) {
    const geom = Array.isArray(w.geometry) ? w.geometry : [];
    if (geom.length < 2) continue;
    if (sameLatLon(geom[0], geom[geom.length - 1])) rings.push(geom);
    else open.push({ id: w.id, geom });
  }
  let dropped = 0;
  const used = new Set();
  for (let i = 0; i < open.length; i++) {
    if (used.has(open[i].id)) continue;
    let chain = open[i].geom.slice();
    used.add(open[i].id);
    let isClosed = sameLatLon(chain[0], chain[chain.length - 1]);
    let progressed = true;
    while (!isClosed && progressed) {
      progressed = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      for (let j = 0; j < open.length; j++) {
        const o = open[j];
        if (used.has(o.id)) continue;
        const g = o.geom;
        const g0 = g[0];
        const gL = g[g.length - 1];
        let joined = null;
        if (sameLatLon(tail, g0)) joined = chain.concat(g.slice(1));
        else if (sameLatLon(tail, gL)) joined = chain.concat(g.slice(0, -1).reverse());
        else if (sameLatLon(head, gL)) joined = g.slice(0, -1).concat(chain);
        else if (sameLatLon(head, g0)) joined = g.slice(1).reverse().concat(chain);
        if (joined) {
          chain = joined;
          used.add(o.id);
          progressed = true;
          break;
        }
      }
      if (progressed) isClosed = sameLatLon(chain[0], chain[chain.length - 1]);
    }
    if (isClosed && chain.length >= 3) rings.push(chain);
    else dropped++;
  }
  return { rings, dropped };
}

/**
 * Assemble water rings from OSM ways/relation members: closed ways become
 * rings directly; open ways are chained greedily by matching endpoints
 * (equal lon/lat within 1e-7) until they close; unclosed chains are dropped.
 * @param {Array<{id: number, geometry: Array<{lon:number,lat:number}>}>} ways
 * @returns {Array<Array<{lon:number,lat:number}>>} assembled closed rings
 */
export function assembleRings(ways) {
  return assembleRingsInternal(ways).rings;
}

/** X-axis intersection of segment `(a,b)` with the vertical edge `x = c`. */
function intersectX(a, b, c) {
  const t = (c - a[0]) / (b[0] - a[0]);
  return [c, a[1] + t * (b[1] - a[1])];
}

/** Z-axis intersection of segment `(a,b)` with the horizontal edge `z = c`. */
function intersectZ(a, b, c) {
  const t = (c - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), c];
}

/** Sutherland–Hodgman clip of `poly` against one half-plane. */
function clipEdge(poly, inside, intersect) {
  if (poly.length === 0) return poly;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

/**
 * Clip a local-metre ring to an axis-aligned box with Sutherland–Hodgman.
 * Clips against all four edges; may return fewer than 3 points (including an
 * empty array) when the ring lies entirely outside the box.
 * @param {Array<[number, number]>} ring closed ring of `[x, z]` pairs
 * @param {{minX:number,minZ:number,maxX:number,maxZ:number}} box clip box
 * @returns {Array<[number, number]>} clipped ring (may be < 3 points)
 */
export function clipRingToBox(ring, box) {
  let poly = ring.map((p) => [p[0], p[1]]);
  poly = clipEdge(poly, (p) => p[0] >= box.minX, (a, b) => intersectX(a, b, box.minX));
  poly = clipEdge(poly, (p) => p[0] <= box.maxX, (a, b) => intersectX(a, b, box.maxX));
  poly = clipEdge(poly, (p) => p[1] >= box.minZ, (a, b) => intersectZ(a, b, box.minZ));
  poly = clipEdge(poly, (p) => p[1] <= box.maxZ, (a, b) => intersectZ(a, b, box.maxZ));
  return poly;
}

/**
 * Signed polygon area (shoelace). Positive for counterclockwise winding with
 * `y` axis pointing up (i.e. the lat/lon frame used by the coastline
 * pipeline); negative for clockwise. Zero for a degenerate ring.
 * @param {Array<[number, number]>} ring polygon vertices (first not repeated last)
 * @returns {number} signed area in the ring's coordinate units squared
 */
export function signedArea(ring) {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Liang–Barsky clip of one segment to an axis-aligned bbox. */
function clipSegmentLB(a, b, bbox) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const ps = [-dx, dx, -dy, dy];
  const qs = [
    a[0] - bbox.minX,
    bbox.maxX - a[0],
    a[1] - bbox.minY,
    bbox.maxY - a[1],
  ];
  for (let i = 0; i < 4; i++) {
    const p = ps[i];
    const q = qs[i];
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return {
    a: [a[0] + t0 * dx, a[1] + t0 * dy],
    b: [a[0] + t1 * dx, a[1] + t1 * dy],
  };
}

/**
 * Clip an open polyline to an axis-aligned bbox, returning the interior
 * sub-polylines in input vertex order (data-format.md "Coastline water"
 * rule 2). Vertices strictly inside the bbox are preserved as-is; boundary
 * crossings introduce Liang–Barsky intersection points. Each output piece is
 * a polyline (≥ 2 points), and a new piece begins every time the polyline
 * leaves the bbox and re-enters.
 * @param {Array<[number, number]>} points polyline vertices
 * @param {{minX:number, minY:number, maxX:number, maxY:number}} bbox
 * @returns {Array<Array<[number, number]>>} interior pieces
 */
export function clipPolylineToBbox(points, bbox) {
  const pieces = [];
  if (!Array.isArray(points) || points.length < 2) return pieces;
  const inside = (p) =>
    p[0] >= bbox.minX &&
    p[0] <= bbox.maxX &&
    p[1] >= bbox.minY &&
    p[1] <= bbox.maxY;
  const eq = (a, b) =>
    Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  let current = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const aIn = inside(a);
    const bIn = inside(b);
    if (aIn && bIn) {
      if (current === null) current = [a];
      current.push(b);
    } else if (aIn && !bIn) {
      const clip = clipSegmentLB(a, b, bbox);
      if (!clip) continue; // shouldn't happen when aIn
      if (current === null) current = [a];
      current.push(clip.b);
      pieces.push(current);
      current = null;
    } else if (!aIn && bIn) {
      const clip = clipSegmentLB(a, b, bbox);
      if (!clip) continue;
      if (current === null) current = [clip.a];
      else if (!eq(current[current.length - 1], clip.a)) current.push(clip.a);
      current.push(b);
    } else {
      const clip = clipSegmentLB(a, b, bbox);
      if (clip) {
        if (current !== null) {
          pieces.push(current);
          current = null;
        }
        pieces.push([clip.a, clip.b]);
      } else if (current !== null) {
        pieces.push(current);
        current = null;
      }
    }
  }
  if (current !== null) pieces.push(current);
  return pieces;
}

/**
 * Stitch coastline polyline pieces end-to-start on coinciding endpoints
 * (tolerance 1e-7, matching `assembleRings`) — data-format.md "Coastline
 * water" rule 3. A piece whose start and end coincide is a closed loop (an
 * island coastline that stayed within the bbox); otherwise the chain stays
 * open, with both endpoints on the bbox boundary, and is fed to
 * `closeCoastline` next. Closed rings have their repeated closing point
 * dropped so they match the water ring schema.
 *
 * Stitching is independent of array order: on coinciding endpoints a piece
 * may attach AFTER the chain (piece start = chain end) or BEFORE it (piece
 * end = chain start), looping until no unused piece matches either end (or
 * the chain closes). Pieces are never reversed — way direction carries the
 * land-left/water-right side the clockwise closure depends on.
 * @param {Array<Array<[number, number]>>} pieces polyline pieces from clip
 * @returns {{closed: Array<Array<[number, number]>>, open: Array<Array<[number, number]>>}}
 */
export function stitchChains(pieces) {
  const eps = 1e-7;
  const same = (a, b) =>
    Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
  const remaining = pieces.map((p) => p.slice());
  const used = new Set();
  const closed = [];
  const open = [];
  for (let i = 0; i < remaining.length; i++) {
    if (used.has(i)) continue;
    let chain = remaining[i].slice();
    used.add(i);
    let progressed = true;
    while (progressed && !same(chain[0], chain[chain.length - 1])) {
      progressed = false;
      const start = chain[0];
      const tail = chain[chain.length - 1];
      for (let j = 0; j < remaining.length; j++) {
        if (used.has(j)) continue;
        const o = remaining[j];
        if (same(tail, o[0])) {
          // piece starts where the chain ends → attach AFTER the chain.
          chain = chain.concat(o.slice(1));
          used.add(j);
          progressed = true;
          break;
        }
        if (same(start, o[o.length - 1])) {
          // piece ends where the chain starts → attach BEFORE the chain.
          chain = o.slice(0, -1).concat(chain);
          used.add(j);
          progressed = true;
          break;
        }
      }
    }
    if (chain.length < 2) continue;
    if (same(chain[0], chain[chain.length - 1])) {
      chain.pop(); // drop the repeated closing point
      if (chain.length >= 3) closed.push(chain);
    } else {
      open.push(chain);
    }
  }
  return { closed, open };
}

/**
 * Close open coastline chains into water rings by walking the bbox perimeter
 * CLOCKWISE from each chain's END to the START of some open chain, inserting
 * bbox corners as passed (data-format.md "Coastline water" rule 4). The walk
 * order — down the east edge, west across the south, up the west, east
 * across the north — keeps water (right of the coastline way's direction)
 * on the inside of the emitted rings. Coordinates are treated as
 * `(x = lon east+, y = lat north+)`. Every open chain is consumed exactly
 * once; the output rings have no repeated closing point.
 * @param {Array<Array<[number, number]>>} openChains chains with both
 *   endpoints on the bbox perimeter, in the order they should be considered
 * @param {{minX:number, minY:number, maxX:number, maxY:number}} bbox
 * @returns {Array<Array<[number, number]>>} closed water rings
 */
export function closeCoastline(openChains, bbox) {
  if (!Array.isArray(openChains) || openChains.length === 0) return [];
  const eps = 1e-7;
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  const same = (a, b) =>
    Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
  // Parameterise the bbox perimeter CW starting at the NE corner:
  //   t ∈ [0, 1) east edge (y = maxY → minY, x = maxX)
  //   t ∈ [1, 2) south edge (x = maxX → minX, y = minY)
  //   t ∈ [2, 3) west edge (y = minY → maxY, x = minX)
  //   t ∈ [3, 4) north edge (x = minX → maxX, y = maxY)
  // Corners belong to the edge they start CW (NE→east, SE→south, ...).
  const perim = (p) => {
    const x = p[0];
    const y = p[1];
    const onEast = Math.abs(x - bbox.maxX) < eps;
    const onSouth = Math.abs(y - bbox.minY) < eps;
    const onWest = Math.abs(x - bbox.minX) < eps;
    const onNorth = Math.abs(y - bbox.maxY) < eps;
    if (onEast && onNorth) return 0;
    if (onSouth && onEast) return 1;
    if (onWest && onSouth) return 2;
    if (onNorth && onWest) return 3;
    if (onEast) return (bbox.maxY - y) / height;
    if (onSouth) return 1 + (bbox.maxX - x) / width;
    if (onWest) return 2 + (y - bbox.minY) / height;
    if (onNorth) return 3 + (x - bbox.minX) / width;
    throw new Error(
      `closeCoastline: point (${x}, ${y}) is not on the bbox perimeter`,
    );
  };
  const corners = [
    { t: 1, pt: [bbox.maxX, bbox.minY] }, // SE
    { t: 2, pt: [bbox.minX, bbox.minY] }, // SW
    { t: 3, pt: [bbox.minX, bbox.maxY] }, // NW
    { t: 4, pt: [bbox.maxX, bbox.maxY] }, // NE (0 mod 4)
  ];
  const rings = [];
  const used = new Set();
  for (let i = 0; i < openChains.length; i++) {
    if (used.has(i)) continue;
    const ring = [];
    let cur = i;
    do {
      used.add(cur);
      const chain = openChains[cur];
      for (const pt of chain) ring.push(pt);
      const endT = perim(chain[chain.length - 1]);
      let bestDist = Infinity;
      let bestIdx = -1;
      for (let j = 0; j < openChains.length; j++) {
        if (used.has(j) && j !== i) continue;
        const startT = perim(openChains[j][0]);
        let dist = startT - endT;
        if (dist <= eps) dist += 4;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = j;
        }
      }
      if (bestIdx === -1) break; // no chain to walk to (shouldn't happen)
      const target = endT + bestDist;
      // Collect qualifying corners and sort by the SHIFTED parameter so the
      // insertion order matches the CW walk order — the fixed `corners` array
      // ([SE, SW, NW, NE]) does not, once any corner has been shifted past
      // `endT` (e.g. `endT ≥ 1` puts SE at `ct ≥ 5` while NW/NE stay at 3/4).
      const passing = [];
      for (const corner of corners) {
        let ct = corner.t;
        while (ct <= endT + eps) ct += 4;
        if (ct < target - eps) passing.push({ ct, pt: corner.pt });
      }
      passing.sort((a, b) => a.ct - b.ct);
      for (const c of passing) ring.push(c.pt);
      cur = bestIdx;
    } while (cur !== i);
    // Dedupe consecutive equal points and drop any closing repeat.
    const cleaned = [];
    for (const pt of ring) {
      const prev = cleaned[cleaned.length - 1];
      if (!prev || !same(prev, pt)) cleaned.push(pt);
    }
    while (cleaned.length > 1 && same(cleaned[0], cleaned[cleaned.length - 1])) {
      cleaned.pop();
    }
    if (cleaned.length >= 3) rings.push(cleaned);
  }
  return rings;
}

/** Project a lat/lon point to rounded local [x, z]. */
function toXY(p, origin) {
  const [x, z] = project(p.lon, p.lat, origin);
  return [round1(x), round1(z)];
}

/**
 * Pick the display name for an element per the `--lang` rule: with `lang`
 * set, prefer `name:<lang>` (trimmed) and fall back to plain `name`; without
 * `lang`, use `name`. Returns undefined when neither yields a non-empty
 * string.
 * @param {Record<string, string>} tags OSM tags
 * @param {string|undefined} lang two-letter language code, e.g. `'en'`
 * @returns {string|undefined} trimmed display name, or undefined
 */
export function pickName(tags, lang) {
  if (lang) {
    const localised = tags[`name:${lang}`];
    if (typeof localised === 'string') {
      const t = localised.trim();
      if (t) return t;
    }
  }
  const n = tags.name;
  if (typeof n === 'string') {
    const t = n.trim();
    if (t) return t;
  }
  return undefined;
}

/**
 * Seeded 32-bit PRNG (mulberry32) returning floats in [0, 1). Byte-identical
 * copy of `src/data/synthetic.ts` — this script cannot import TypeScript.
 * @param {number} seed integer seed
 * @returns {() => number} generator
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hard cap on emitted trees (data-format.md §Trees). Exposed for tests. */
export const TREE_CAP = 40000;

const TREE_PRNG_SEED = 42;
const TREE_ROW_SPACING = 8;
const WOOD_FILL_STEP = Math.sqrt(150); // one tree per 150 m²
const PARK_FILL_STEP = 20; // one tree per 400 m²
const FILL_JITTER = 0.45;
const EXCLUDE_CELL = 50;
const ROAD_CLEAR_M = 6;
const TREE_H_MIN = 3;
const TREE_H_MAX = 40;
const TREE_R_MIN = 1;
const TREE_R_MAX = 15;
const WOOD_MIN_AREA = 25;

/**
 * Ray-casting point-in-polygon test (copied from `src/world/collision.ts` —
 * scripts cannot import TS); correct for either winding.
 * @param {[number, number]} p point `[x, z]`
 * @param {Array<[number, number]>} poly closed ring of `[x, z]` pairs
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
 * Shortest Euclidean distance from `p` to the segment `a→b` (copied from
 * `src/world/collision.ts`).
 * @param {[number, number]} p
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number} metres
 */
function distToSegment(p, a, b) {
  const ax = a[0];
  const ay = a[1];
  const dx = b[0] - ax;
  const dy = b[1] - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = p[0] - cx;
  const ey = p[1] - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Vertex-average centroid of a ring of `[x, z]` points. */
function ringCentroid(ring) {
  let x = 0;
  let z = 0;
  const n = ring.length;
  if (n === 0) return [0, 0];
  for (const p of ring) {
    x += p[0];
    z += p[1];
  }
  return [x / n, z / n];
}

/**
 * Outline replacement (data-format.md "Building parts" rule 3): a part
 * BELONGS to the SMALLEST (by area) outline containing its centroid so a
 * large station/complex outline cannot claim the parts of a tower that has
 * its own outline. Any outline that CONTAINS the centroid of at least one
 * part is dropped (its parts represent it); the outline `name` transfers to
 * the tallest part that belongs to it and has no name of its own. An outline
 * whose parts all belong to smaller outlines is dropped without transferring
 * anything. Ring area is computed once per outline. Parts whose centroid
 * lies in no outline are kept. Outlines are bucketed by bbox so 52 k × 15 k
 * stays linear. When `parts` is empty the outlines array is returned
 * unchanged (byte-identical London / Kyiv / SF conversion).
 * @param {Array<Object>} outlines `building=*` entries
 * @param {Array<Object>} parts `building:part` entries
 * @returns {Array<Object>} surviving outlines followed by every part
 */
function applyBuildingParts(outlines, parts) {
  if (parts.length === 0) return outlines;
  const CELL = 50;
  const buckets = new Map();
  const push = (key, item) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(item);
  };
  const items = [];
  for (const o of outlines) {
    const bb = ringBBox(o.poly);
    const item = { o, bb, area: ringArea(o.poly) };
    items.push(item);
    const cxMin = Math.floor(bb.minX / CELL);
    const cxMax = Math.floor(bb.maxX / CELL);
    const czMin = Math.floor(bb.minZ / CELL);
    const czMax = Math.floor(bb.maxZ / CELL);
    for (let cx = cxMin; cx <= cxMax; cx++) {
      for (let cz = czMin; cz <= czMax; cz++) {
        push(`${cx},${cz}`, item);
      }
    }
  }
  // `contained` maps an outline to the parts whose centroid lies inside it
  // (any containing outline — drives the drop decision). `home` maps a part
  // to its SMALLEST (by area) containing outline (drives name transfer).
  const contained = new Map();
  const home = new Map();
  for (const part of parts) {
    const c = ringCentroid(part.poly);
    const key = `${Math.floor(c[0] / CELL)},${Math.floor(c[1] / CELL)}`;
    const candidates = buckets.get(key);
    if (!candidates) continue;
    const containing = [];
    for (const item of candidates) {
      const { o, bb } = item;
      if (
        c[0] < bb.minX ||
        c[0] > bb.maxX ||
        c[1] < bb.minZ ||
        c[1] > bb.maxZ
      ) {
        continue;
      }
      if (!pointInPolygon(c, o.poly)) continue;
      containing.push(item);
      let list = contained.get(item);
      if (!list) {
        list = [];
        contained.set(item, list);
      }
      list.push(part);
    }
    if (containing.length > 0) {
      let smallest = containing[0];
      for (let i = 1; i < containing.length; i++) {
        if (containing[i].area < smallest.area) smallest = containing[i];
      }
      home.set(part, smallest);
    }
  }
  const kept = [];
  for (const item of items) {
    const o = item.o;
    const inside = contained.get(item);
    if (!inside || inside.length === 0) {
      kept.push(o);
      continue;
    }
    if (!o.name) continue;
    // Only parts that belong to THIS outline (it is their smallest container)
    // may take its name, and only when they have no name of their own.
    let target = null;
    for (const part of inside) {
      if (home.get(part) !== item) continue; // belongs to a smaller outline
      if (part.name) continue; // a named part keeps its own name
      if (target === null || part.h > target.h) target = part;
    }
    if (target !== null) target.name = o.name;
  }
  return kept.concat(parts);
}

/** Axis-aligned bbox of a ring of `[x, z]` points. */
function ringBBox(ring) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, maxX, minZ, maxZ };
}

/** `'wood'` | `'park'` | null from OSM tags (data-format.md §Trees). */
function woodKind(tags) {
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'wood';
  if (tags.leisure === 'park') return 'park';
  return null;
}

/**
 * Parse a tree `height` tag to metres (leading number; `ft` honored), or
 * `undefined` when absent/unparseable.
 * @param {Record<string, string>} tags
 * @returns {number|undefined}
 */
function parseTreeHeight(tags) {
  const height = tags && tags.height;
  if (height === undefined || height === null || height === '') return undefined;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)/.exec(String(height));
  if (!m) return undefined;
  let h = parseFloat(m[1]);
  if (/ft\s*$/.test(String(height).trim())) h *= 0.3048;
  return Number.isFinite(h) ? h : undefined;
}

/**
 * Build one `[x, z, h, r]` tree quad: metres rounded to 0.1, `h` clamped to
 * `[3, 40]`, `r = 0.35·h` clamped to `[1, 15]`.
 * @param {number} x
 * @param {number} z
 * @param {number} h
 * @returns {[number, number, number, number]}
 */
function emitTree(x, z, h) {
  const hh = round1(Math.min(TREE_H_MAX, Math.max(TREE_H_MIN, h)));
  const r = round1(Math.min(TREE_R_MAX, Math.max(TREE_R_MIN, 0.35 * hh)));
  return [round1(x), round1(z), hh, r];
}

/**
 * Sample a local-metre polyline every `spacing` metres, starting at 0.
 * @param {Array<[number, number]>} pts
 * @param {number} spacing
 * @returns {Array<[number, number]>}
 */
function samplePolyline(pts, spacing) {
  const out = [];
  if (pts.length < 2) return out;
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, len, start: total });
    total += len;
  }
  if (total < 1e-9) return out;
  for (let d = 0; d < total; d += spacing) {
    let seg = segs[segs.length - 1];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (d <= s.start + s.len) {
        seg = s;
        break;
      }
    }
    const t = seg.len > 0 ? (d - seg.start) / seg.len : 0;
    const tt = t < 0 ? 0 : t > 1 ? 1 : t;
    out.push([
      seg.a[0] + (seg.b[0] - seg.a[0]) * tt,
      seg.a[1] + (seg.b[1] - seg.a[1]) * tt,
    ]);
  }
  return out;
}

/**
 * Project, clean, bbox-clip and area-filter assembled lat/lon rings the same
 * way water rings are processed (data-format.md §Trees: "clipped like water").
 * @param {Array<Array<{lon:number,lat:number}>>} latlonRings
 * @param {LatLon} origin
 * @param {{minX:number,minZ:number,maxX:number,maxZ:number}} clipBox
 * @param {number} minArea
 * @returns {Array<Array<[number, number]>>}
 */
function projectClipRings(latlonRings, origin, clipBox, minArea) {
  const out = [];
  for (const ring of latlonRings) {
    if (ring.length < 4) continue;
    const poly = ring.slice(0, -1).map((p) => {
      const [x, z] = project(p.lon, p.lat, origin);
      return [round1(x), round1(z)];
    });
    const cleaned = cleanRing(poly);
    if (cleaned.length < 3) continue;
    const clipped = cleanRing(clipRingToBox(cleaned, clipBox));
    if (clipped.length < 3) continue;
    if (ringArea(clipped) < minArea) continue;
    out.push(clipped);
  }
  return out;
}

/**
 * 50 m spatial hash of building footprints and road segments, plus water
 * rings, used to drop fill trees (data-format.md §Trees).
 * @param {Array<{poly: Array<[number, number]>}>} buildings
 * @param {Array<{pts: Array<[number, number]>}>} roads
 * @param {Array<Array<[number, number]>>} water
 * @returns {(x: number, z: number) => boolean}
 */
function makeFillBlocked(buildings, roads, water) {
  const bCells = new Map();
  const rCells = new Map();
  const push = (map, key, item) => {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(item);
  };
  for (const b of buildings) {
    const poly = b.poly;
    if (!poly || poly.length < 3) continue;
    const bb = ringBBox(poly);
    const fp = { poly, ...bb };
    const cxMin = Math.floor(bb.minX / EXCLUDE_CELL);
    const cxMax = Math.floor(bb.maxX / EXCLUDE_CELL);
    const czMin = Math.floor(bb.minZ / EXCLUDE_CELL);
    const czMax = Math.floor(bb.maxZ / EXCLUDE_CELL);
    for (let cx = cxMin; cx <= cxMax; cx++) {
      for (let cz = czMin; cz <= czMax; cz++) {
        push(bCells, `${cx},${cz}`, fp);
      }
    }
  }
  for (const r of roads) {
    const pts = r.pts;
    if (!pts || pts.length < 2) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const minX = Math.min(a[0], b[0]) - ROAD_CLEAR_M;
      const maxX = Math.max(a[0], b[0]) + ROAD_CLEAR_M;
      const minZ = Math.min(a[1], b[1]) - ROAD_CLEAR_M;
      const maxZ = Math.max(a[1], b[1]) + ROAD_CLEAR_M;
      const seg = { a, b };
      const cxMin = Math.floor(minX / EXCLUDE_CELL);
      const cxMax = Math.floor(maxX / EXCLUDE_CELL);
      const czMin = Math.floor(minZ / EXCLUDE_CELL);
      const czMax = Math.floor(maxZ / EXCLUDE_CELL);
      for (let cx = cxMin; cx <= cxMax; cx++) {
        for (let cz = czMin; cz <= czMax; cz++) {
          push(rCells, `${cx},${cz}`, seg);
        }
      }
    }
  }
  const waterIndexed = water.map((ring) => ({ ring, bbox: ringBBox(ring) }));
  return (x, z) => {
    for (const w of waterIndexed) {
      const bb = w.bbox;
      if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
      if (pointInPolygon([x, z], w.ring)) return true;
    }
    const key = `${Math.floor(x / EXCLUDE_CELL)},${Math.floor(z / EXCLUDE_CELL)}`;
    const fps = bCells.get(key);
    if (fps) {
      for (const fp of fps) {
        if (
          x >= fp.minX &&
          x <= fp.maxX &&
          z >= fp.minZ &&
          z <= fp.maxZ &&
          pointInPolygon([x, z], fp.poly)
        ) {
          return true;
        }
      }
    }
    const segs = rCells.get(key);
    if (segs) {
      for (const s of segs) {
        if (distToSegment([x, z], s.a, s.b) < ROAD_CLEAR_M) return true;
      }
    }
    return false;
  };
}

/**
 * Jittered-grid fill of one wood/park ring (data-format.md §Trees).
 * PRNG is consumed in grid order (z then x) for every cell: two jitter
 * samples always, plus one height sample when the point is kept.
 * @param {Array<[number, number]>} ring
 * @param {number} step
 * @param {() => number} rand
 * @param {(x: number, z: number) => boolean} blocked
 * @returns {Array<[number, number, number, number]>}
 */
function fillRing(ring, step, rand, blocked) {
  const trees = [];
  if (ring.length < 3) return trees;
  const bb = ringBBox(ring);
  const amp = FILL_JITTER * step;
  for (let gz = bb.minZ; gz <= bb.maxZ + 1e-9; gz += step) {
    for (let gx = bb.minX; gx <= bb.maxX + 1e-9; gx += step) {
      const x = round1(gx + (rand() * 2 - 1) * amp);
      const z = round1(gz + (rand() * 2 - 1) * amp);
      if (!pointInPolygon([x, z], ring)) continue;
      if (blocked(x, z)) continue;
      trees.push(emitTree(x, z, 6 + rand() * 8));
    }
  }
  return trees;
}

/**
 * Thin fill trees so the file stays at `cap`: keep every k-th fill tree
 * (`k = ceil(n / cap)`), never drop mapped nodes/rows.
 * @param {Array<[number, number, number, number]>} mapped
 * @param {Array<[number, number, number, number]>} fills
 * @param {number} cap
 * @returns {{trees: Array<[number, number, number, number]>, filled: number, dropped: number}}
 */
function thinFills(mapped, fills, cap) {
  const n = mapped.length + fills.length;
  if (!(cap > 0) || n <= cap) {
    return { trees: mapped.concat(fills), filled: fills.length, dropped: 0 };
  }
  const k = Math.ceil(n / cap);
  const kept = [];
  let dropped = 0;
  for (let i = 0; i < fills.length; i++) {
    if (i % k === 0) kept.push(fills[i]);
    else dropped++;
  }
  return { trees: mapped.concat(kept), filled: kept.length, dropped };
}

/**
 * Convert an Overpass `[out:json]` response into a `CityData` object.
 * @param {{elements: unknown[]}} json Overpass response (`out geom;`)
 * @param {{origin: LatLon, bbox?: [number,number,number,number],
 *   lang?: string,
 *   dem?: {elevationAt(lat:number, lon:number): number},
 *   step?: number,
 *   treeCap?: number}} opts
 * @returns {CityData} city model (see `src/data/types.ts`)
 */
export function convertOverpass(json, opts) {
  const { origin } = opts;
  const bbox = opts.bbox ?? DEFAULT_BBOX;
  const { lang, dem, step } = opts;
  const treeCap = opts.treeCap !== undefined ? opts.treeCap : TREE_CAP;
  const outlines = [];
  const parts = [];
  const roads = [];
  const places = [];
  const rivers = [];
  const seenPlace = new Set();
  const treeNodes = [];
  const treeRows = [];
  const woodWays = [];
  const parkWays = [];
  const elements = Array.isArray(json?.elements) ? json.elements : [];

  let skippedRelations = 0;

  // --- Water (the Thames, docks): standalone `natural=water`/`waterway`
  // `riverbank` ways plus the outer members of water relations. All are
  // assembled into closed rings, projected to local metres, clipped to the
  // bbox expanded by 300 m (the Thames relation extends far beyond it) and
  // cleaned/dropped like building rings.
  const waterWays = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const tags = el.tags || {};
    if (!(tags.natural === 'water' || tags.waterway === 'riverbank')) continue;
    if (el.type === 'way') {
      waterWays.push({ id: el.id, geometry: el.geometry });
    } else if (el.type === 'relation') {
      const members = Array.isArray(el.members) ? el.members : [];
      members.forEach((m, k) => {
        if (m && typeof m === 'object' && m.role === 'outer') {
          waterWays.push({ id: `${el.id}:${k}`, geometry: m.geometry });
        }
      });
    }
  }
  const { rings: waterRings, dropped: droppedOpenWaterChains } =
    assembleRingsInternal(waterWays);

  // Local-metre bbox of the source query, expanded by 300 m for clipping.
  const boxP = {
    minX: project(bbox[0], origin.lat, origin)[0], // west (minLon)
    maxX: project(bbox[2], origin.lat, origin)[0], // east (maxLon)
    minZ: project(bbox[0], bbox[3], origin)[1], // north (maxLat)
    maxZ: project(bbox[0], bbox[1], origin)[1], // south (minLat)
  };
  const clipBox = {
    minX: boxP.minX - 300,
    minZ: boxP.minZ - 300,
    maxX: boxP.maxX + 300,
    maxZ: boxP.maxZ + 300,
  };
  const water = [];
  for (const ring of waterRings) {
    if (ring.length < 4) continue;
    const poly = ring.slice(0, -1).map((p) => {
      const [x, z] = project(p.lon, p.lat, origin);
      return [round1(x), round1(z)];
    });
    const cleaned = cleanRing(poly);
    if (cleaned.length < 3) continue;
    const clipped = cleanRing(clipRingToBox(cleaned, clipBox));
    if (clipped.length < 3) continue;
    if (ringArea(clipped) < 25) continue; // degenerate / sliver
    water.push(clipped);
  }

  // Coastline (data-format.md "Coastline water" — bays/seas as OSM
  // `natural=coastline` ways, not polygons). Pipeline in lat/lon:
  //   1. clip each way's polyline to the bbox segment-by-segment
  //   2. stitch pieces end-to-start on coinciding endpoints → closed loops
  //      (islands) + open chains whose endpoints lie on the bbox boundary
  //   3. close each open chain by walking the bbox perimeter CLOCKWISE
  //      (this keeps water — right of the way direction — inside the ring)
  //   4. warn (do not fail) if a closed island ring is CW instead of CCW
  //   5. project to local metres and append to `water`; the DEM parity rule
  //      distinguishes island rings from outer rings at flattening time.
  const coastPolylines = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const tags = el.tags || {};
    if (el.type !== 'way' || tags.natural !== 'coastline') continue;
    const geom = Array.isArray(el.geometry) ? el.geometry : [];
    if (geom.length < 2) continue;
    coastPolylines.push(geom.map((p) => [p.lon, p.lat]));
  }
  if (coastPolylines.length > 0) {
    const coastBbox = {
      minX: bbox[0],
      minY: bbox[1],
      maxX: bbox[2],
      maxY: bbox[3],
    };
    const pieces = [];
    for (const line of coastPolylines) {
      for (const piece of clipPolylineToBbox(line, coastBbox)) pieces.push(piece);
    }
    const { closed: coastClosed, open: coastOpen } = stitchChains(pieces);
    for (const ring of coastClosed) {
      // Rule 5: an island's coastline should be CCW in lat/lon (land on the
      // left). Positive signed area = CCW; warn on the opposite winding.
      if (signedArea(ring) < 0) {
        console.warn(
          `coastline: closed ring (${ring.length} pts) is clockwise — expected CCW (land on the left)`,
        );
      }
    }
    const coastFromWalk = closeCoastline(coastOpen, coastBbox);
    for (const latlonRing of [...coastClosed, ...coastFromWalk]) {
      const poly = latlonRing.map(([lon, lat]) => {
        const [x, z] = project(lon, lat, origin);
        return [round1(x), round1(z)];
      });
      const cleaned = cleanRing(poly);
      if (cleaned.length < 3) continue;
      water.push(cleaned);
    }
  }

  // Woods / forests / parks: standalone ways plus relation outer members,
  // assembled and clipped like water (data-format.md §Trees).
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const tags = el.tags || {};
    const kind = woodKind(tags);
    if (!kind) continue;
    const dest = kind === 'park' ? parkWays : woodWays;
    if (el.type === 'way') {
      dest.push({ id: el.id, geometry: el.geometry });
    } else if (el.type === 'relation') {
      const members = Array.isArray(el.members) ? el.members : [];
      members.forEach((m, k) => {
        if (m && typeof m === 'object' && m.role === 'outer') {
          dest.push({ id: `${el.id}:${k}`, geometry: m.geometry });
        }
      });
    }
  }
  const woodRings = projectClipRings(
    assembleRingsInternal(woodWays).rings,
    origin,
    clipBox,
    WOOD_MIN_AREA,
  );
  const parkRings = projectClipRings(
    assembleRingsInternal(parkWays).rings,
    origin,
    clipBox,
    WOOD_MIN_AREA,
  );
  const woods = woodRings.concat(parkRings);

  const buildEntry = (id, tags, poly) => {
    const name = pickName(tags, lang);
    return {
      id,
      h: heightOf(tags),
      ...(name ? { name } : {}),
      poly,
    };
  };

  /** Outline entry plus `minH` when the part starts above ground. */
  const buildPartEntry = (id, tags, poly) => {
    const entry = buildEntry(id, tags, poly);
    const minH = minHeightOf(tags);
    if (minH > 0 && minH < entry.h - 1) entry.minH = minH;
    return entry;
  };

  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const tags = el.tags || {};

    if (el.type === 'way') {
      if (isBuildingPart(tags)) {
        if (isBelowGrade(tags)) continue;
        const poly = toRing(el.geometry, origin);
        if (poly) parts.push(buildPartEntry(el.id, tags, poly));
      } else if (tags.building !== undefined) {
        if (tags.building === 'no' || tags.building === 'part') continue;
        if (isBelowGrade(tags)) continue;
        const poly = toRing(el.geometry, origin);
        if (poly) outlines.push(buildEntry(el.id, tags, poly));
      } else if (tags.highway !== undefined) {
        let cls = roadClassOf(tags.highway);
        // Wave-5 exception: a `footway` or `cycleway` with a `bridge` tag ≠
        // `no` becomes a `pedestrian` bridge (Kyiv Parkovyi + Klitschko
        // bridges are `highway=cycleway` + `bridge=yes`). Plain footways /
        // cycleways stay dropped.
        const bridged = tags.bridge !== undefined && tags.bridge !== 'no';
        if (
          cls === null &&
          (tags.highway === 'footway' || tags.highway === 'cycleway') &&
          bridged
        ) {
          cls = 'pedestrian';
        }
        if (cls === null) continue;
        const pts = [];
        for (const p of el.geometry || []) {
          const xy = toXY(p, origin);
          const last = pts[pts.length - 1];
          if (!last || last[0] !== xy[0] || last[1] !== xy[1]) pts.push(xy);
        }
        if (pts.length < 2) continue;
        const name = pickName(tags, lang);
        roads.push({
          id: el.id,
          ...(name ? { name } : {}),
          cls,
          // Bridges are walkable corridors over water (T-0030): set the flag
          // when the `bridge` tag exists and is not `no`; omit the key otherwise.
          ...(bridged ? { bridge: true } : {}),
          pts,
        });
      } else if (tags.waterway === 'river') {
        // River centre-lines become boat paths (T-0036): projected to local
        // metres, rounded to 0.1 m, and consecutive duplicates dropped exactly
        // like road polylines; keep polylines with >= 2 distinct points.
        const pts = [];
        for (const p of el.geometry || []) {
          const xy = toXY(p, origin);
          const last = pts[pts.length - 1];
          if (!last || last[0] !== xy[0] || last[1] !== xy[1]) pts.push(xy);
        }
        if (pts.length >= 2) rivers.push(pts);
      } else if (tags.natural === 'tree_row') {
        treeRows.push(el);
      }
    } else if (el.type === 'relation') {
      if (isBuildingPart(tags) && tags['type'] === 'multipolygon') {
        if (isBelowGrade(tags)) continue;
        let emitted = 0;
        for (const m of el.members || []) {
          if (m.role === 'outer') {
            const poly = toRing(m.geometry, origin);
            if (poly) {
              const id = emitted === 0 ? el.id : el.id * 1000 + emitted;
              parts.push(buildPartEntry(id, tags, poly));
              emitted++;
            }
          }
        }
        if (emitted === 0) skippedRelations++;
      } else if (tags.building !== undefined && tags['type'] === 'multipolygon') {
        if (isBelowGrade(tags)) continue;
        let emitted = 0;
        for (const m of el.members || []) {
          if (m.role === 'outer') {
            const poly = toRing(m.geometry, origin);
            if (poly) {
              // A relation may hold several disjunct outer rings; give each a
              // unique id (the first keeps the relation id) so all emitted
              // rings pass `validateCity`'s per-array id-uniqueness rule.
              const id = emitted === 0 ? el.id : el.id * 1000 + emitted;
              outlines.push(buildEntry(id, tags, poly));
              emitted++;
            }
          }
        }
        if (emitted === 0) skippedRelations++; // ring assembly across ways not done
      }
    } else if (el.type === 'node') {
      if (tags.natural === 'tree') {
        treeNodes.push(el);
      }
      const isPlace =
        tags.place !== undefined ||
        tags.railway === 'station' ||
        (tags.tourism === 'attraction' && tags.name);
      if (isPlace) {
        const name = pickName(tags, lang);
        if (name && !seenPlace.has(name)) {
          seenPlace.add(name);
          const [x, z] = toXY(el, origin);
          places.push({ name, x, z });
        }
      }
    }
  }

  // Trees (data-format.md §Trees): mapped nodes, tree_row samples, then a
  // seeded jittered-grid fill of every wood/forest ring and every park ring.
  const rand = mulberry32(TREE_PRNG_SEED);
  const mappedTrees = [];
  for (const el of treeNodes) {
    const [x, z] = toXY(el, origin);
    const tagged = parseTreeHeight(el.tags || {});
    const h = tagged !== undefined ? tagged : 6 + rand() * 8;
    mappedTrees.push(emitTree(x, z, h));
  }
  for (const el of treeRows) {
    const pts = [];
    for (const p of el.geometry || []) {
      const xy = toXY(p, origin);
      const last = pts[pts.length - 1];
      if (!last || last[0] !== xy[0] || last[1] !== xy[1]) pts.push(xy);
    }
    if (pts.length >= 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
      pts.pop();
    }
    const tagged = parseTreeHeight(el.tags || {});
    for (const [x, z] of samplePolyline(pts, TREE_ROW_SPACING)) {
      const h = tagged !== undefined ? tagged : 6 + rand() * 8;
      mappedTrees.push(emitTree(x, z, h));
    }
  }
  const buildings = applyBuildingParts(outlines, parts);
  const blocked = makeFillBlocked(buildings, roads, water);
  const fillTrees = [];
  for (const ring of woodRings) {
    fillTrees.push(...fillRing(ring, WOOD_FILL_STEP, rand, blocked));
  }
  for (const ring of parkRings) {
    fillTrees.push(...fillRing(ring, PARK_FILL_STEP, rand, blocked));
  }
  const thinned = thinFills(mappedTrees, fillTrees, treeCap);
  const trees = thinned.trees;

  let terrain;
  let waterLevels;
  if (dem) {
    const built = buildTerrain({
      bbox,
      origin,
      dem,
      ...(step !== undefined ? { step } : {}),
      waterRings: water,
    });
    terrain = built.terrain;
    // Omit waterLevels when there is no water (data-format.md §Terrain step 4).
    if (water.length > 0) waterLevels = built.waterLevels;
  }

  const result = {
    v: 1,
    origin: { lat: origin.lat, lon: origin.lon },
    bbox,
    buildings,
    roads,
    places,
    ...(water.length > 0 ? { water } : {}),
    ...(rivers.length > 0 ? { rivers } : {}),
    ...(trees.length > 0 ? { trees } : {}),
    ...(woods.length > 0 ? { woods } : {}),
    ...(terrain ? { terrain } : {}),
    ...(waterLevels ? { waterLevels } : {}),
  };
  // Non-enumerable escape hatch for the fetch summary line; not serialized.
  Object.defineProperty(result, 'skippedRelations', {
    value: skippedRelations,
    writable: false,
    enumerable: false,
  });
  Object.defineProperty(result, 'skippedOpenWaterChains', {
    value: droppedOpenWaterChains,
    writable: false,
    enumerable: false,
  });
  Object.defineProperty(result, 'treesFilled', {
    value: thinned.filled,
    writable: false,
    enumerable: false,
  });
  Object.defineProperty(result, 'treesDropped', {
    value: thinned.dropped,
    writable: false,
    enumerable: false,
  });
  return result;
}
