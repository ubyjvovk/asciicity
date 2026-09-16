#!/usr/bin/env node
/**
 * Deterministic Minas Tirith city generator (wave 16, architecture.md §4.23).
 *
 * Pure functions plus a CLI that tiles into `--out` (index.json + tiles/)
 * the same way `scripts/fetch-osm.mjs` does. Houses, landmarks and trees
 * come from `scripts/minas-tirith-buildings.mjs`.
 *
 *   node scripts/gen-minas-tirith.mjs --out <dir>
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TILE_SIZE, tileCity } from './tile-city.mjs';
import { buildHouses, buildLandmarks, buildTrees } from './minas-tirith-buildings.mjs';

const DEG = Math.PI / 180;
const EXTENT = 1500;
const STEP = 10;
const RAMP = 25;
const WALL_THICK = 6;
const SEGMENTS = 48;
const SEG_DEG = 360 / SEGMENTS;
const GATE_HALF_DEG = 6;
const GAP_M = 12;
const TOWER_M = 10;
const RING_INSET = 14;
const NOTCH_HALF = 6;
const PROW_INNER_W = 24;
const PROW_OUTER_W = 8;
const MINDOLLUIN_X = -520;
const NOISE_LATTICE = 60;
const NOISE_AMP = 1.5;
const COLOR_L1 = 0x2a2a30;
const COLOR_STONE = 0xd8d4c8;

/** Florence's latitude — the sun Tolkien's Gondor implies. */
const ORIGIN = { lat: 43.77, lon: 11.25 };

/**
 * The seven circles: wall radius (m) and plateau height above the Pelennor.
 * Index 0 is L1 (the Othram); index 6 is L7 (the Citadel).
 * @type {ReadonlyArray<{k: number, r: number, h: number, wallH: number, color: number}>}
 */
export const TIERS = Object.freeze([
  Object.freeze({ k: 1, r: 420, h: 0, wallH: 20, color: COLOR_L1 }),
  Object.freeze({ k: 2, r: 355, h: 32, wallH: 14, color: COLOR_STONE }),
  Object.freeze({ k: 3, r: 295, h: 64, wallH: 14, color: COLOR_STONE }),
  Object.freeze({ k: 4, r: 240, h: 96, wallH: 14, color: COLOR_STONE }),
  Object.freeze({ k: 5, r: 190, h: 128, wallH: 14, color: COLOR_STONE }),
  Object.freeze({ k: 6, r: 145, h: 160, wallH: 14, color: COLOR_STONE }),
  Object.freeze({ k: 7, r: 100, h: 200, wallH: 12, color: COLOR_STONE }),
]);

/**
 * Gate azimuths in degrees clockwise from north (`x = r·sin a`, `z = −r·cos a`).
 * Index 0 is L1 (the Great Gate, due east).
 * @type {ReadonlyArray<number>}
 */
export const GATE_AZ = Object.freeze([90, 135, 45, 135, 45, 135, 45]);

const R = TIERS.map((t) => t.r);
const H = TIERS.map((t) => t.h);
const R1 = R[0];
const R2 = R[1];
const R7 = R[6];

/**
 * Seeded 32-bit PRNG (mulberry32) returning floats in [0, 1).
 * Copied from `src/data/synthetic.ts` — this script cannot import TS.
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round a local-metre value to 0.1 m. */
function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Inverse of the data-format equirectangular projection (local metres → WGS84).
 * `lon = origin.lon + x / (cos(origin.lat°)·111320)`,
 * `lat = origin.lat − z / 110574`.
 * @param {number} x local metres east
 * @param {number} z local metres south
 * @param {{lat: number, lon: number}} origin
 * @returns {[number, number]} `[lon, lat]`
 */
function unproject(x, z, origin) {
  const lon = origin.lon + x / (Math.cos(origin.lat * DEG) * 111320);
  const lat = origin.lat - z / 110574;
  return [lon, lat];
}

/** Bbox of the ±1500 m extent corners (minLon, minLat, maxLon, maxLat). */
function extentBbox() {
  const corners = [
    unproject(-EXTENT, -EXTENT, ORIGIN),
    unproject(-EXTENT, EXTENT, ORIGIN),
    unproject(EXTENT, -EXTENT, ORIGIN),
    unproject(EXTENT, EXTENT, ORIGIN),
  ];
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  return [
    Math.min(...lons),
    Math.min(...lats),
    Math.max(...lons),
    Math.max(...lats),
  ];
}

/**
 * Point at radius `r` and azimuth `deg` (clockwise from north).
 * @param {number} r metres
 * @param {number} deg degrees
 * @returns {[number, number]}
 */
function atAz(r, deg) {
  const a = deg * DEG;
  return [round1(r * Math.sin(a)), round1(-r * Math.cos(a))];
}

/** Shortest signed delta `to − from` in (−180, 180]. */
function shortestDelta(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * Progress in `[0, 360)` from `from` toward `dir` (+1 clockwise).
 * @param {number} from
 * @param {number} ang
 * @param {number} dir
 */
function angProgress(from, ang, dir) {
  let d = (ang - from) * dir;
  d = ((d % 360) + 360) % 360;
  return d;
}

/**
 * Azimuths along the shorter arc, a vertex every 6° plus both ends.
 * Inserts due-east (90°) when the arc crosses the prow.
 * @param {number} fromDeg
 * @param {number} toDeg
 * @returns {number[]}
 */
function arcAngles(fromDeg, toDeg) {
  const delta = shortestDelta(fromDeg, toDeg);
  const dir = Math.sign(delta) || 1;
  const total = Math.abs(delta);
  const raw = [0, total];
  for (let d = 6; d < total - 1e-9; d += 6) raw.push(d);
  const d90 = angProgress(fromDeg, 90, dir);
  if (d90 > 1e-9 && d90 < total - 1e-9) raw.push(d90);
  raw.sort((a, b) => a - b);
  const uniq = [];
  for (const d of raw) {
    if (uniq.length && Math.abs(d - uniq[uniq.length - 1]) < 1e-9) continue;
    uniq.push(d);
  }
  return uniq.map((d) => fromDeg + dir * d);
}

/** Smoothstep fade for value-noise interpolation. */
function fade(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Deterministic lattice hash in `[0, 1)` (mulberry32-shaped, no stream).
 * @param {number} ix
 * @param {number} iz
 * @param {number} seed
 */
function hashNoise(ix, iz, seed) {
  let a = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + (seed | 0)) | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * ±1.5 m value-noise on a 60 m lattice.
 * @param {number} x
 * @param {number} z
 * @param {number} seed
 */
function valueNoise(x, z, seed) {
  const s = NOISE_LATTICE;
  const ix = Math.floor(x / s);
  const iz = Math.floor(z / s);
  const fx = fade(x / s - ix);
  const fz = fade(z / s - iz);
  const n00 = hashNoise(ix, iz, seed) * 2 * NOISE_AMP - NOISE_AMP;
  const n10 = hashNoise(ix + 1, iz, seed) * 2 * NOISE_AMP - NOISE_AMP;
  const n01 = hashNoise(ix, iz + 1, seed) * 2 * NOISE_AMP - NOISE_AMP;
  const n11 = hashNoise(ix + 1, iz + 1, seed) * 2 * NOISE_AMP - NOISE_AMP;
  return n00 + (n10 - n00) * fx + (n01 - n00) * fz + (n00 - n10 - n01 + n11) * fx * fz;
}

/** Seed number from `rand` (function, number, or omitted). */
function seedOf(rand) {
  if (typeof rand === 'number' && Number.isFinite(rand)) return rand | 0;
  return 1;
}

/**
 * Band index 1..7 for radius `r`, or 0 outside L1.
 * Band k is `R_{k+1} < r ≤ R_k` (k = 7 for `r ≤ R_7`).
 * @param {number} r
 * @returns {number}
 */
function bandOf(r) {
  if (r > R1) return 0;
  if (r <= R7) return 7;
  for (let k = 1; k <= 6; k++) {
    if (r > R[k] && r <= R[k - 1]) return k;
  }
  return 7;
}

/**
 * Plateau / ramp height for radius `r` (no prow, noise, or Mindolluin).
 * `H_k` on `R_{k+1}+25 < r ≤ R_k`; linear ramp `H_{k+1} → H_k` over
 * `R_{k+1} < r ≤ R_{k+1}+25`; `H_7` inside `R_7`; `0` outside `R_1`.
 * @param {number} r
 */
function plateauHeight(r) {
  if (r > R1) return 0;
  if (r <= R7) return H[6];
  for (let k = 0; k < 6; k++) {
    if (r > R[k]) continue;
    const inner = R[k + 1];
    if (r > inner + RAMP) return H[k];
    if (r > inner) {
      const t = (r - inner) / RAMP;
      return H[k + 1] + t * (H[k] - H[k + 1]);
    }
  }
  return H[6];
}

/**
 * Prow half-width in metres: 24 m at `R_7` down to 8 m at `R_2`.
 * @param {number} r
 */
function prowHalfWidth(r) {
  const t = (r - R7) / (R2 - R7);
  return PROW_INNER_W + t * (PROW_OUTER_W - PROW_INNER_W);
}

/**
 * True when `(x, z)` sits in the eastern rock prow (`R_7 ≤ r ≤ R_2`,
 * `|z| ≤ w(r)`, `x ≥ 0`).
 * @param {number} x
 * @param {number} z
 * @param {number} r
 */
function inProw(x, z, r) {
  if (x < 0) return false;
  if (r < R7 || r > R2) return false;
  return Math.abs(z) <= prowHalfWidth(r);
}

/**
 * Tier k (2..6) whose ring-road notch contains `r`, or 0.
 * The 12 m-wide tunnel cuts the prow at `R_k − 14` (architecture.md §4.23).
 * @param {number} r
 */
function notchTier(r) {
  for (let k = 2; k <= 6; k++) {
    if (Math.abs(r - (R[k - 1] - RING_INSET)) <= NOTCH_HALF) return k;
  }
  return 0;
}

/**
 * Ground height at `(x, z)` in metres (architecture.md §4.23 Terrain).
 * `rand` is a mulberry32 stream or a numeric seed; Pelennor noise is a
 * hash of lattice coordinates so a point query does not depend on call order.
 * @param {number} x east (m)
 * @param {number} z south (m)
 * @param {(() => number)|number} [rand]
 * @returns {number} height rounded to 0.1 m
 */
export function terrainHeight(x, z, rand) {
  const r = Math.hypot(x, z);
  let h = plateauHeight(r);
  const k = bandOf(r);

  if (inProw(x, z, r)) {
    const nk = notchTier(r);
    if (nk > 0) {
      h = H[nk - 1];
    } else if (k >= 1 && k <= 6) {
      h = H[k];
    }
  }

  if (r > R1) {
    h = valueNoise(x, z, seedOf(rand));
  }

  if (x < MINDOLLUIN_X) {
    h += Math.min(700, (MINDOLLUIN_X - x) * 0.9);
  }

  return round1(h);
}

/**
 * Height grid covering the ±1500 m extent plus one margin cell
 * (`step` 10, `datum` 0, row 0 = north). `cols === rows === 302`.
 * @param {number} seed mulberry32 seed (Pelennor noise)
 * @returns {{x0: number, z0: number, step: number, cols: number, rows: number, datum: number, heights: number[]}}
 */
export function buildTerrain(seed) {
  const x0 = -EXTENT - STEP;
  const z0 = -EXTENT - STEP;
  const cols = (2 * EXTENT) / STEP + 2;
  const rows = cols;
  const heights = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = x0 + col * STEP;
      const z = z0 + row * STEP;
      heights.push(terrainHeight(x, z, seed));
    }
  }
  return { x0, z0, step: STEP, cols, rows, datum: 0, heights };
}

/**
 * 10×10 m square centred at `(cx, cz)`, aligned to unit radial `ur`
 * and unit clockwise-tangent `ut`.
 * @param {number} cx
 * @param {number} cz
 * @param {[number, number]} ur
 * @param {[number, number]} ut
 * @param {number} half
 * @returns {Array<[number, number]>}
 */
function orientedSquare(cx, cz, ur, ut, half) {
  const corners = [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ];
  return corners.map(([a, b]) => [
    round1(cx + a * half * ur[0] + b * half * ut[0]),
    round1(cz + a * half * ur[1] + b * half * ut[1]),
  ]);
}

/**
 * Seven 48-segment wall rings (gate-azimuth ±6° segments omitted) plus
 * 14 gate towers flanking each 12 m gap. L1 towers are the Great Gate.
 * @returns {Array<Object>}
 */
export function buildWalls() {
  const buildings = [];
  for (let t = 0; t < TIERS.length; t++) {
    const tier = TIERS[t];
    const k = t + 1;
    const gate = GATE_AZ[t];
    const outer = tier.r;
    const inner = outer - WALL_THICK;
    for (let i = 0; i < SEGMENTS; i++) {
      const a0 = i * SEG_DEG;
      const a1 = (i + 1) * SEG_DEG;
      if (a0 < gate + GATE_HALF_DEG && a1 > gate - GATE_HALF_DEG) continue;
      buildings.push({
        id: k * 1000 + i,
        h: tier.wallH,
        color: tier.color,
        poly: [atAz(outer, a0), atAz(outer, a1), atAz(inner, a1), atAz(inner, a0)],
      });
    }
    const rad = gate * DEG;
    const ur = [Math.sin(rad), -Math.cos(rad)];
    const ut = [Math.cos(rad), Math.sin(rad)];
    const cr = outer - TOWER_M / 2;
    const offset = GAP_M / 2 + TOWER_M / 2;
    for (const side of [-1, 1]) {
      const cx = cr * ur[0] + side * offset * ut[0];
      const cz = cr * ur[1] + side * offset * ut[1];
      /** @type {{id: number, h: number, color: number, poly: Array<[number, number]>, name?: string, shape?: string}} */
      const tower = {
        id: k * 1000 + (side < 0 ? 48 : 49),
        h: tier.wallH + 10,
        color: tier.color,
        poly: orientedSquare(cx, cz, ur, ut, TOWER_M / 2),
      };
      if (k === 1) {
        tower.name = 'Great Gate';
        tower.shape = 'tower';
      }
      buildings.push(tower);
    }
  }
  return buildings;
}

/**
 * The Climbing Way, seven ring roads, radial lanes, and the three Pelennor roads.
 * @returns {Array<Object>}
 */
export function buildRoads() {
  const roads = [];
  let id = 1;
  const addPt = (pts, p) => {
    if (pts.length) {
      const q = pts[pts.length - 1];
      if (q[0] === p[0] && q[1] === p[1]) return;
    }
    pts.push(p);
  };

  const main = [];
  addPt(main, [round1(R1 + 60), 0]);
  addPt(main, [round1(R1), 0]);
  addPt(main, atAz(R1 - RING_INSET, GATE_AZ[0]));
  for (let t = 0; t < 6; t++) {
    const rRing = TIERS[t].r - RING_INSET;
    const from = GATE_AZ[t];
    const to = GATE_AZ[t + 1];
    for (const a of arcAngles(from, to)) addPt(main, atAz(rRing, a));
    addPt(main, atAz(TIERS[t + 1].r - RING_INSET, to));
  }
  addPt(main, [10, 0]);
  roads.push({ id: id++, name: 'The Climbing Way', cls: 'primary', pts: main });

  for (let t = 0; t < TIERS.length; t++) {
    const r = TIERS[t].r - RING_INSET;
    const name = t === 6 ? 'Citadel Ring' : `Ring ${t + 1}`;
    const pts = [];
    for (let a = 0; a <= 360; a += 6) pts.push(atAz(r, a % 360));
    roads.push({ id: id++, name, cls: 'secondary', pts });
  }

  const laneAz = [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5];
  for (let t = 0; t < 6; t++) {
    const rOuter = TIERS[t].r - RING_INSET;
    const rInner = TIERS[t + 1].r + 30;
    let n = 0;
    for (const az of laneAz) {
      if (t >= 1) {
        const d = Math.abs(((((az - 90) % 360) + 540) % 360) - 180);
        if (d <= 12) continue;
      }
      n += 1;
      roads.push({
        id: id++,
        name: `Lane ${t + 1}.${n}`,
        cls: 'residential',
        pts: [atAz(rOuter, az), atAz(rInner, az)],
      });
    }
  }

  roads.push({
    id: id++,
    name: 'East Road',
    cls: 'primary',
    pts: [
      [round1(R1), 0],
      [round1(EXTENT), 0],
    ],
  });
  roads.push({
    id: id++,
    name: 'North Road',
    cls: 'secondary',
    pts: [atAz(R1 + 20, 0), [0, round1(-EXTENT)]],
  });
  roads.push({
    id: id++,
    name: 'South Road',
    cls: 'secondary',
    pts: [atAz(R1 + 20, 180), [0, round1(EXTENT)]],
  });

  return roads;
}

/**
 * Named landmarks for the HUD / floating tags (architecture.md §4.23 Places).
 * @type {ReadonlyArray<{name: string, x: number, z: number}>}
 */
export const PLACES = Object.freeze([
  Object.freeze({ name: 'Great Gate', x: R1, z: 0 }),
  Object.freeze({ name: 'Rath Celerdain', ...ptPlace(400, 110) }),
  Object.freeze({ name: 'Fen Hollen', ...ptPlace(150, 250) }),
  Object.freeze({ name: 'Court of the Fountain', x: 10, z: 0 }),
  Object.freeze({ name: 'Houses of Healing', ...ptPlace(165, 150) }),
  Object.freeze({ name: 'Rath Dínen', ...ptPlace(150, 270) }),
  Object.freeze({ name: 'The Citadel', x: 0, z: 0 }),
  Object.freeze({ name: 'Pelennor Fields', x: 800, z: 0 }),
]);

function ptPlace(r, az) {
  const [x, z] = atAz(r, az);
  return { x, z };
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isFiniteVec2(v) {
  return Array.isArray(v) && v.length === 2 && isFiniteNum(v[0]) && isFiniteNum(v[1]);
}

/**
 * Copy of the schema rules this producer must honour (unique ids, ≥ 3 poly
 * points, first ≠ last, finite numbers, h in [3, 650]). Does not import
 * `src/data/validate.ts`.
 * @param {object} city
 */
function assertCity(city) {
  if (city.v !== 1) throw new Error('v: schema version must be 1');
  const ids = new Set();
  city.buildings.forEach((b, i) => {
    if (!isFiniteNum(b.h) || b.h < 3 || b.h > 650) {
      throw new Error(`buildings[${i}].h: height must be in [3, 650]`);
    }
    if (!Array.isArray(b.poly) || b.poly.length < 3) {
      throw new Error(`buildings[${i}].poly: polygon must have at least 3 points`);
    }
    b.poly.forEach((pt, k) => {
      if (!isFiniteVec2(pt)) {
        throw new Error(`buildings[${i}].poly: point ${k} must be a finite [x, z]`);
      }
    });
    const first = b.poly[0];
    const last = b.poly[b.poly.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      throw new Error(`buildings[${i}].poly: first point must not repeat last`);
    }
    if (!isFiniteNum(b.id)) throw new Error(`buildings[${i}].id: must be a finite number`);
    if (ids.has(b.id)) throw new Error(`buildings[${i}].id: duplicate id`);
    ids.add(b.id);
  });
  const roadIds = new Set();
  city.roads.forEach((r, i) => {
    if (!Array.isArray(r.pts) || r.pts.length < 2) {
      throw new Error(`roads[${i}].pts: polyline must have at least 2 points`);
    }
    r.pts.forEach((pt, k) => {
      if (!isFiniteVec2(pt)) {
        throw new Error(`roads[${i}].pts: point ${k} must be a finite [x, z]`);
      }
    });
    if (!isFiniteNum(r.id)) throw new Error(`roads[${i}].id: must be a finite number`);
    if (roadIds.has(r.id)) throw new Error(`roads[${i}].id: duplicate id`);
    roadIds.add(r.id);
  });
  city.places.forEach((p, i) => {
    if (typeof p.name !== 'string' || p.name.length === 0) {
      throw new Error(`places[${i}].name: must be a non-empty string`);
    }
    if (!isFiniteNum(p.x)) throw new Error(`places[${i}].x: must be a finite number`);
    if (!isFiniteNum(p.z)) throw new Error(`places[${i}].z: must be a finite number`);
  });
  const t = city.terrain;
  if (!t || t.cols * t.rows !== t.heights.length) {
    throw new Error('terrain.heights: must have cols*rows entries');
  }
  t.heights.forEach((hv, i) => {
    if (!isFiniteNum(hv)) throw new Error(`terrain.heights[${i}]: must be a finite number`);
  });
}

/**
 * Assemble the monolithic city (`v: 1`) for `seed` (default 1).
 * Buildings are walls + gate towers + houses + landmarks; trees include
 * the White Tree and the Houses of Healing garden.
 * @param {number} [seed=1]
 * @returns {object}
 */
export function buildCity(seed = 1) {
  const rand = mulberry32(seed);
  const city = {
    v: 1,
    origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
    bbox: extentBbox(),
    buildings: [...buildWalls(), ...buildHouses(TIERS, GATE_AZ, rand), ...buildLandmarks()],
    roads: buildRoads(),
    places: PLACES.map((p) => ({ name: p.name, x: p.x, z: p.z })),
    terrain: buildTerrain(seed),
    trees: buildTrees(),
  };
  assertCity(city);
  return city;
}

/** Parse `--out <dir>` (other flags ignored). */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out.out = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/**
 * Build seed-1 Minas Tirith and tile it into `--out` (`index.json` + `tiles/`).
 * Never writes a monolithic `*.city.json`.
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out;
  if (!out) {
    process.stderr.write('usage: node scripts/gen-minas-tirith.mjs --out <dir>\n');
    process.exit(1);
  }
  try {
    const city = buildCity(1);
    const tiled = tileCity(city, DEFAULT_TILE_SIZE);
    mkdirSync(join(out, 'tiles'), { recursive: true });
    const write = (path, obj) => {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, path);
    };
    write(join(out, 'index.json'), tiled.index);
    for (const [key, tile] of tiled.tiles) {
      write(join(out, 'tiles', `${key}.json`), tile);
    }
    const indexBytes = Buffer.byteLength(JSON.stringify(tiled.index), 'utf8');
    process.stdout.write(
      `${out}: ${city.buildings.length} buildings, ${city.roads.length} roads, ` +
        `${city.places.length} places, ${city.trees.length} trees, ` +
        `terrain ${city.terrain.cols}x${city.terrain.rows}` +
        ` @ ${city.terrain.step} m, ${tiled.tiles.size} tiles, ` +
        `index ${indexBytes} B\n`,
    );
  } catch (err) {
    process.stderr.write(`gen-minas-tirith: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
