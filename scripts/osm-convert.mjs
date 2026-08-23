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

const DEG = Math.PI / 180;

/** Default City of London bbox (minLon,minLat,maxLon,maxLat) per data-format. */
const DEFAULT_BBOX = [-0.106, 51.506, -0.070, 51.521];

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
  footway: 'footway',
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
 * → default by `building` value. Always clamped to [3, 320].
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
  return Math.min(320, Math.max(3, h));
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
  const poly = geom.slice(0, -1).map((p) => {
    const [x, z] = project(p.lon, p.lat, origin);
    return [round1(x), round1(z)];
  });
  // Rounding to 0.1 m can collapse distinct source points onto the same cell;
  // drop those before emitting so the ring passes `validateCity` and has no
  // duplicated vertices. (1) any point equal to the previous point; (2) the
  // last point while it equals the first (this also handles the closing-point
  // collapse that made buildings[].poly repeat its first point).
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
  // (3) drop the ring if fewer than 3 points remain or |area| < 1 m².
  if (cleaned.length < 3) return null;
  if (ringArea(cleaned) < 1) return null; // degenerate
  return cleaned;
}

/** Project a lat/lon point to rounded local [x, z]. */
function toXY(p, origin) {
  const [x, z] = project(p.lon, p.lat, origin);
  return [round1(x), round1(z)];
}

/**
 * Convert an Overpass `[out:json]` response into a `CityData` object.
 * @param {{elements: unknown[]}} json Overpass response (`out geom;`)
 * @param {{origin: LatLon, bbox?: [number,number,number,number]}} opts
 * @returns {CityData} city model (see `src/data/types.ts`)
 */
export function convertOverpass(json, opts) {
  const { origin } = opts;
  const bbox = opts.bbox ?? DEFAULT_BBOX;
  const buildings = [];
  const roads = [];
  const places = [];
  const seenPlace = new Set();
  const elements = Array.isArray(json?.elements) ? json.elements : [];

  let skippedRelations = 0;

  const buildEntry = (id, tags, poly) => ({
    id,
    h: heightOf(tags),
    ...(tags.name ? { name: String(tags.name).trim() } : {}),
    poly,
  });

  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const tags = el.tags || {};

    if (el.type === 'way') {
      if (tags.building !== undefined) {
        if (tags.building === 'no' || tags.building === 'part') continue;
        const poly = toRing(el.geometry, origin);
        if (poly) buildings.push(buildEntry(el.id, tags, poly));
      } else if (tags.highway !== undefined) {
        const cls = roadClassOf(tags.highway);
        if (cls === null) continue;
        const pts = [];
        for (const p of el.geometry || []) {
          const xy = toXY(p, origin);
          const last = pts[pts.length - 1];
          if (!last || last[0] !== xy[0] || last[1] !== xy[1]) pts.push(xy);
        }
        if (pts.length < 2) continue;
        roads.push({
          id: el.id,
          ...(tags.name ? { name: String(tags.name).trim() } : {}),
          cls,
          pts,
        });
      }
    } else if (el.type === 'relation') {
      if (tags.building !== undefined && tags['type'] === 'multipolygon') {
        let emitted = 0;
        for (const m of el.members || []) {
          if (m.role === 'outer') {
            const poly = toRing(m.geometry, origin);
            if (poly) {
              // A relation may hold several disjunct outer rings; give each a
              // unique id (the first keeps the relation id) so all emitted
              // rings pass `validateCity`'s per-array id-uniqueness rule.
              const id = emitted === 0 ? el.id : el.id * 1000 + emitted;
              buildings.push(buildEntry(id, tags, poly));
              emitted++;
            }
          }
        }
        if (emitted === 0) skippedRelations++; // ring assembly across ways not done
      }
    } else if (el.type === 'node') {
      const isPlace =
        tags.place !== undefined ||
        tags.railway === 'station' ||
        (tags.tourism === 'attraction' && tags.name);
      if (isPlace && tags.name) {
        const name = String(tags.name).trim();
        if (name && !seenPlace.has(name)) {
          seenPlace.add(name);
          const [x, z] = toXY(el, origin);
          places.push({ name, x, z });
        }
      }
    }
  }

  const result = {
    v: 1,
    origin: { lat: origin.lat, lon: origin.lon },
    bbox,
    buildings,
    roads,
    places,
  };
  // Non-enumerable escape hatch for the fetch summary line; not serialized.
  Object.defineProperty(result, 'skippedRelations', {
    value: skippedRelations,
    writable: false,
    enumerable: false,
  });
  return result;
}
