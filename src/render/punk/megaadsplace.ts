/**
 * Pure placement + merged cell meshes for the cyberpunk `ads` layer (T-0172):
 * giant facade screens on highrises, roof billboards on mid-rises, red
 * aviation beacons and roofline LED strips. No `three/webgpu`, no DOM.
 * Contract: the T-0172 ticket (docs/styles/cyberpunk-megaads.md).
 */
import type { Building, HeightFn, Road, Vec2 } from '../../data/types';
import { FLAT_HEIGHT } from '../../data/types';
import { normalizeRing, ringHeights } from '../../world/buildings';
import { CELL_SIZE } from './cells';
import { NEON_TEXT_COLORS, neonLinear } from './neonplace';

/** Envelope height (m) from which a building is "tall" (facade screens possible). */
export const MEGA_MIN_H = 45;
/** From this height a building always carries one facade screen. */
export const MEGA_ALWAYS_H = 80;
/** From this height a building carries two screens on roughly opposite faces. */
export const MEGA_TWO_H = 150;
/** Screen probability for 45 ≤ h < 80. */
export const MEGA_SCREEN_P = 0.55;
/** Outward offset of a screen face from its wall, metres. */
export const MEGA_SCREEN_OFF = 0.8;
/** Minimum distance (m) between a screen's bottom edge line and any footprint edge. */
export const MEGA_SCREEN_CLEAR = 0.6;
/** Edges shorter than this never carry a screen. */
export const MEGA_MIN_EDGE = 10;
/** Edges at least this long may carry a landscape screen. */
export const MEGA_LANDSCAPE_EDGE = 40;
/** Roof billboards: 25 ≤ h < 45. */
export const BILLBOARD_MIN_H = 25;
/** Billboard leg height, metres. */
export const BILLBOARD_LEG = 3;
/** Beacons and roofline strips from this height. */
export const BEACON_MIN_H = 60;
/** Roofline strip probability (h ≥ 60). */
export const STRIP_P = 0.5;
/** Roofline strip band height, metres. */
export const STRIP_H = 0.35;
/** Per 250 m cell: screens + billboards. */
export const CAP_SIGNS = 24;
/** Per 250 m cell: beacons. */
export const CAP_BEACONS = 64;
/** Beacon box edge, metres. */
export const BEACON_SIZE = 0.9;
/** Portrait / landscape content slots in the atlas. */
export const MEGA_PORTRAIT_SLOTS = 16;
export const MEGA_LANDSCAPE_SLOTS = 8;
/** Atlas edge (px); portrait slots 256 × 512 (8 × 2, canvas top), landscape 512 × 256 (4 × 2, below). */
export const MEGA_ATLAS_SIZE = 2048;
export const MEGA_PORTRAIT_W = 256;
export const MEGA_PORTRAIT_H = 512;
export const MEGA_LANDSCAPE_W = 512;
export const MEGA_LANDSCAPE_H = 256;
/** Canvas y (px) of the first landscape row. */
export const MEGA_LANDSCAPE_Y = 2 * MEGA_PORTRAIT_H;
/** Emissive gain of screens (neon facade screens use 3, tubes 7). */
export const MEGA_SCREEN_GAIN = 2.6;
/** Emissive gain baked into beacon / strip vertex colours. */
export const MEGA_BEACON_GAIN = 9;
export const MEGA_STRIP_GAIN = 3.5;
/** Aviation red (sRGB). */
export const BEACON_COLOR = '#ff1a1a';

/** Billboard probability by city id (default 0.12). */
const BILLBOARD_P: Readonly<Record<string, number>> = { tokyo: 0.25, nyc: 0.25 };
/** Road search reach for "faces the nearest road", metres. */
const ROAD_REACH = 120;
/** Outward probe distance used to score an edge against the road network. */
const PROBE = 6;
const GRID = 40;

/** A facade screen or a roof billboard face. `(x, y, z)` is the face centre. */
export interface MegaScreen {
  kind: 'screen' | 'billboard';
  /** Stable id `<buildingId>:<kind>:<k>`. */
  id: string;
  buildingId: number;
  x: number;
  y: number;
  z: number;
  /** Unit outward normal in the xz plane (the face looks along it). */
  nx: number;
  nz: number;
  width: number;
  height: number;
  /** Landscape content (atlas landscape slots) vs portrait. */
  landscape: boolean;
  /** First atlas slot (0..15 portrait, 0..7 landscape). */
  slot: number;
  /** Seconds added to the clock for this screen's slot cycle. */
  phase: number;
  /** Slot switch period, 7–12 s. */
  period: number;
  /** Billboards: y of the roof the legs stand on. */
  legBase?: number;
}

/** A blinking red aviation beacon (box centre). */
export interface MegaBeacon {
  kind: 'beacon';
  id: string;
  buildingId: number;
  x: number;
  y: number;
  z: number;
  /** Blink phase in [0, 1) (1 Hz). */
  phase: number;
}

/** An emissive roofline LED band along a (normalised) ring. */
export interface MegaStrip {
  kind: 'strip';
  id: string;
  buildingId: number;
  ring: Vec2[];
  /** Band bottom y. */
  y: number;
  height: number;
  /** sRGB `#rrggbb` from the neon palette. */
  color: string;
}

/** Everything the `ads` layer places. */
export type MegaAd = MegaScreen | MegaBeacon | MegaStrip;

/** Mulberry32: deterministic [0, 1) PRNG from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildingSeed(id: number, seed: number): number {
  let h = Math.imul(id ^ 0x5bd1e995, 0x9e3779b1) ^ Math.imul(seed + 0x3c6ef372, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 13)) >>> 0;
}

interface Seg {
  ax: number;
  az: number;
  abx: number;
  abz: number;
  ab2: number;
}

function distToSeg(px: number, pz: number, s: Seg): number {
  let t = s.ab2 > 0 ? ((px - s.ax) * s.abx + (pz - s.az) * s.abz) / s.ab2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (s.ax + s.abx * t), pz - (s.az + s.abz * t));
}

function segOf(a: Vec2, b: Vec2): Seg {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  return { ax: a[0], az: a[1], abx, abz, ab2: abx * abx + abz * abz };
}

/** Road segments bucketed by every grid cell their bbox touches. */
function indexRoads(roads: readonly Road[]): Map<string, Seg[]> {
  const map = new Map<string, Seg[]>();
  for (const road of roads) {
    for (let i = 0; i < road.pts.length - 1; i++) {
      const a = road.pts[i];
      const b = road.pts[i + 1];
      if (!a || !b) continue;
      const seg = segOf(a, b);
      const i0 = Math.floor(Math.min(a[0], b[0]) / GRID);
      const i1 = Math.floor(Math.max(a[0], b[0]) / GRID);
      const j0 = Math.floor(Math.min(a[1], b[1]) / GRID);
      const j1 = Math.floor(Math.max(a[1], b[1]) / GRID);
      for (let ci = i0; ci <= i1; ci++) {
        for (let cj = j0; cj <= j1; cj++) {
          const key = `${ci}_${cj}`;
          let list = map.get(key);
          if (!list) {
            list = [];
            map.set(key, list);
          }
          list.push(seg);
        }
      }
    }
  }
  return map;
}

/** Distance from (x, z) to the nearest indexed road within `reach` (Infinity if none). */
function roadDistance(index: Map<string, Seg[]>, x: number, z: number, reach: number): number {
  let best = Infinity;
  const i0 = Math.floor((x - reach) / GRID);
  const i1 = Math.floor((x + reach) / GRID);
  const j0 = Math.floor((z - reach) / GRID);
  const j1 = Math.floor((z + reach) / GRID);
  for (let ci = i0; ci <= i1; ci++) {
    for (let cj = j0; cj <= j1; cj++) {
      const list = index.get(`${ci}_${cj}`);
      if (!list) continue;
      for (const s of list) {
        const d = distToSeg(x, z, s);
        if (d < best) best = d;
      }
    }
  }
  return best <= reach ? best : Infinity;
}

/** Even-odd point-in-polygon test. */
export function insideRing(ring: readonly Vec2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Shortest distance from (x, z) to the ring's edges. */
export function ringDistance(ring: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = distToSeg(x, z, segOf(ring[i]!, ring[(i + 1) % ring.length]!));
    if (d < best) best = d;
  }
  return best;
}

function segsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Shortest distance between segment p–q and the ring (0 when they cross). */
export function segmentRingDistance(ring: readonly Vec2[], p: Vec2, q: Vec2): number {
  let best = Infinity;
  const pq = segOf(p, q);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (segsCross(p, q, a, b)) return 0;
    const ab = segOf(a, b);
    best = Math.min(best, distToSeg(p[0], p[1], ab), distToSeg(q[0], q[1], ab), distToSeg(a[0], a[1], pq), distToSeg(b[0], b[1], pq));
  }
  return best;
}

function ringArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function ringCentroid(ring: readonly Vec2[]): Vec2 {
  const A = ringArea(ring);
  if (Math.abs(A) < 1e-6) {
    let x = 0;
    let z = 0;
    for (const p of ring) {
      x += p[0];
      z += p[1];
    }
    return [x / ring.length, z / ring.length];
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f;
    cz += (p[1] + q[1]) * f;
  }
  return [cx / (6 * A), cz / (6 * A)];
}

/** The mass that carries the ads: the tallest tier (PLATEAU) or the envelope. */
export interface MegaMass {
  /** Normalised ring (outward normal of edge a→b is `(dz, −dx)/len`). */
  ring: Vec2[];
  /** Effective height above the building's ground top (max tier top, or `h`). */
  h: number;
  /** World y of the flat wall top (roof eaves for pitched roofs). */
  wallTop: number;
  /** World y of the wall base. */
  wallBase: number;
  /** Flat usable roof (no pitched OSM roof, no curated landmark cap). */
  flatRoof: boolean;
}

/** Ads mass of `b` (null for degenerate footprints). */
export function megaMass(b: Building, groundAt: HeightFn = FLAT_HEIGHT): MegaMass | null {
  if (b.poly.length < 3) return null;
  const env = normalizeRing(b.poly);
  const { base, top } = ringHeights(env, groundAt);
  const wallBase = base + (b.minH ?? 0);
  if (b.tiers && b.tiers.length > 0 && b.shape === undefined) {
    let best: { ring: Vec2[]; h: number } | null = null;
    for (const t of b.tiers) {
      if (t.poly.length < 3) continue;
      const ring = normalizeRing(t.poly);
      if (Math.abs(ringArea(ring)) < 1) continue;
      if (!best || t.h > best.h) best = { ring, h: t.h };
    }
    if (best) return { ring: best.ring, h: best.h, wallTop: top + best.h, wallBase, flatRoof: true };
  }
  const roofH = b.roof && b.shape === undefined ? b.roof.h : 0;
  return { ring: env, h: b.h, wallTop: top + b.h - roofH, wallBase, flatRoof: roofH === 0 && b.shape === undefined };
}

interface Cand {
  i: number;
  ax: number;
  az: number;
  len: number;
  nx: number;
  nz: number;
  score: number;
}

/** Edges of `ring` (≥ `minLen`) scored by road distance of an outward probe; best first, fallback longest first. */
function rankEdges(ring: readonly Vec2[], minLen: number, roads: Map<string, Seg[]>): Cand[] {
  const out: Cand[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < minLen) continue;
    const nx = dz / len;
    const nz = -dx / len;
    const px = (a[0] + b[0]) / 2 + nx * PROBE;
    const pz = (a[1] + b[1]) / 2 + nz * PROBE;
    out.push({ i, ax: a[0], az: a[1], len, nx, nz, score: roadDistance(roads, px, pz, ROAD_REACH) });
  }
  out.sort((p, q) => (p.score === q.score ? q.len - p.len || p.i - q.i : p.score - q.score));
  return out;
}

/** Try to seat a facade screen on edge `e`; null when it would touch the footprint. */
function seatScreen(
  e: Cand,
  mass: MegaMass,
  b: Building,
  k: number,
  rng: () => number,
): MegaScreen | null {
  const H = mass.h;
  const height = Math.min(70, Math.max(14, 0.3 * H));
  const gap = (0.04 + rng() * 0.06) * H;
  const top = mass.wallTop - gap;
  const aspectRoll = rng();
  const landRoll = rng();
  const slotRoll = rng();
  const period = 7 + rng() * 5;
  const phase = rng() * period;
  let landscape = false;
  let aspect = 0.45 + aspectRoll * 0.25;
  const landAspect = 1.6 + aspectRoll * 0.6;
  if (e.len >= MEGA_LANDSCAPE_EDGE && landRoll < 0.5 && e.len - 2 >= height * landAspect) {
    landscape = true;
    aspect = landAspect;
  }
  const width = Math.min(e.len - 2, height * aspect);
  if (width <= 0 || top - height < mass.wallBase) return null;
  const tx = -e.nz;
  const tz = e.nx;
  const mx = e.ax + (tx * e.len) / 2 + e.nx * MEGA_SCREEN_OFF;
  const mz = e.az + (tz * e.len) / 2 + e.nz * MEGA_SCREEN_OFF;
  const p: Vec2 = [mx - (tx * width) / 2, mz - (tz * width) / 2];
  const q: Vec2 = [mx + (tx * width) / 2, mz + (tz * width) / 2];
  if (insideRing(mass.ring, mx, mz)) return null;
  if (segmentRingDistance(mass.ring, p, q) < MEGA_SCREEN_CLEAR - 1e-6) return null;
  return {
    kind: 'screen',
    id: `${b.id}:screen:${k}`,
    buildingId: b.id,
    x: mx,
    y: top - height / 2,
    z: mz,
    nx: e.nx,
    nz: e.nz,
    width,
    height,
    landscape,
    slot: Math.floor(slotRoll * (landscape ? MEGA_LANDSCAPE_SLOTS : MEGA_PORTRAIT_SLOTS)),
    phase,
    period,
  };
}

/** Everything one building would carry, before the cell caps. */
function placeBuilding(b: Building, mass: MegaMass, roads: Map<string, Seg[]>, cityId: string, seed: number): { signs: MegaScreen[]; beacons: MegaBeacon[]; strips: MegaStrip[] } {
  const rng = mulberry32(buildingSeed(b.id, seed));
  // Fixed roll order so one decision never shifts another.
  const rScreen = rng();
  const rBill = rng();
  const rStrip = rng();
  const rStripCol = rng();
  const rBeacons = rng();
  const rBeaconPhase = rng();
  const H = mass.h;
  const signs: MegaScreen[] = [];
  const beacons: MegaBeacon[] = [];
  const strips: MegaStrip[] = [];

  if (H >= MEGA_MIN_H) {
    const want = H >= MEGA_TWO_H ? 2 : H >= MEGA_ALWAYS_H || rScreen < MEGA_SCREEN_P ? 1 : 0;
    if (want > 0) {
      const edges = rankEdges(mass.ring, MEGA_MIN_EDGE, roads);
      let first: Cand | null = null;
      for (const e of edges) {
        const s = seatScreen(e, mass, b, 0, mulberry32(buildingSeed(b.id, seed + 1)));
        if (s) {
          signs.push(s);
          first = e;
          break;
        }
      }
      if (first && want > 1) {
        for (const e of edges) {
          if (e === first || e.nx * first.nx + e.nz * first.nz >= -0.05) continue;
          const s = seatScreen(e, mass, b, 1, mulberry32(buildingSeed(b.id, seed + 2)));
          if (s) {
            signs.push(s);
            break;
          }
        }
      }
    }
  } else if (H >= BILLBOARD_MIN_H && mass.flatRoof && rBill < (BILLBOARD_P[cityId] ?? 0.12)) {
    const brng = mulberry32(buildingSeed(b.id, seed + 3));
    const wRoll = 12 + brng() * 8;
    const height = 5 + brng() * 3;
    const slot = Math.floor(brng() * MEGA_LANDSCAPE_SLOTS);
    const period = 7 + brng() * 5;
    const phase = brng() * period;
    for (const e of rankEdges(mass.ring, 13, roads)) {
      const width = Math.min(wRoll, e.len - 1);
      const tx = -e.nz;
      const tz = e.nx;
      const mx = e.ax + (tx * e.len) / 2 - e.nx * 2;
      const mz = e.az + (tz * e.len) / 2 - e.nz * 2;
      const hw = width / 2 - 0.5;
      // Both leg feet (and a point behind them) must stand on this roof.
      if (!insideRing(mass.ring, mx + tx * hw, mz + tz * hw) || !insideRing(mass.ring, mx - tx * hw, mz - tz * hw)) continue;
      if (!insideRing(mass.ring, mx - e.nx * 1.5, mz - e.nz * 1.5)) continue;
      signs.push({
        kind: 'billboard',
        id: `${b.id}:billboard:0`,
        buildingId: b.id,
        x: mx,
        y: mass.wallTop + BILLBOARD_LEG + height / 2,
        z: mz,
        nx: e.nx,
        nz: e.nz,
        width,
        height,
        landscape: true,
        slot,
        phase,
        period,
        legBase: mass.wallTop,
      });
      break;
    }
  }

  if (H >= BEACON_MIN_H) {
    const [cx, cz] = ringCentroid(mass.ring);
    const n = 1 + Math.floor(rBeacons * 4);
    const corners = mass.ring
      .map((p, i) => ({ p, i, d: Math.hypot(p[0] - cx, p[1] - cz) }))
      .sort((a, c) => c.d - a.d || a.i - c.i);
    const chosen: Vec2[] = [];
    for (const c of corners) {
      if (chosen.length >= n) break;
      if (chosen.some((q) => Math.hypot(q[0] - c.p[0], q[1] - c.p[1]) < 8)) continue;
      const k = c.d > 0 ? Math.min(0.6, c.d) / c.d : 0;
      chosen.push([c.p[0] + (cx - c.p[0]) * k, c.p[1] + (cz - c.p[1]) * k]);
    }
    chosen.forEach((p, i) =>
      beacons.push({
        kind: 'beacon',
        id: `${b.id}:beacon:${i}`,
        buildingId: b.id,
        x: p[0],
        y: mass.wallTop + BEACON_SIZE / 2,
        z: p[1],
        phase: (rBeaconPhase + i * 0.5) % 1,
      }),
    );
    // One more on top of every other tier tower that reaches beacon height.
    if (b.tiers && b.shape === undefined) {
      const groundTop = mass.wallTop - mass.h;
      let t = 0;
      for (const tier of b.tiers) {
        if (tier.h < BEACON_MIN_H || tier.poly.length < 3) continue;
        const ring = normalizeRing(tier.poly);
        if (ring.length === mass.ring.length && ring.every((p, i) => p[0] === mass.ring[i]![0] && p[1] === mass.ring[i]![1])) continue;
        let [tx, tz] = ringCentroid(ring);
        if (!insideRing(ring, tx, tz)) [tx, tz] = ring[0]!;
        beacons.push({
          kind: 'beacon',
          id: `${b.id}:beacon:t${t++}`,
          buildingId: b.id,
          x: tx,
          y: groundTop + tier.h + BEACON_SIZE / 2,
          z: tz,
          phase: (rBeaconPhase + 0.25 + t * 0.37) % 1,
        });
      }
    }
    if (rStrip < STRIP_P) {
      strips.push({
        kind: 'strip',
        id: `${b.id}:strip:0`,
        buildingId: b.id,
        ring: mass.ring,
        y: mass.wallTop - 0.15 - STRIP_H,
        height: STRIP_H,
        color: NEON_TEXT_COLORS[Math.floor(rStripCol * NEON_TEXT_COLORS.length)] ?? '#05d9e8',
      });
    }
  }
  return { signs, beacons, strips };
}

/**
 * Place mega-ads for `buildings` (T-0172 rules). Deterministic per building
 * id and `seed`; caps are enforced per 250 m cell (by the building's first
 * footprint vertex, like `bucketSources`), tallest buildings first. Screens
 * face the edge whose outward probe is nearest to a road in `roads`
 * (fallback: longest edge). Output order: screens/billboards, beacons, strips.
 */
export function placeMegaAds(
  buildings: readonly Building[],
  roads: readonly Road[],
  groundAt: HeightFn = FLAT_HEIGHT,
  cityId = 'london',
  seed = 0,
): MegaAd[] {
  const index = indexRoads(roads);
  const tall: { b: Building; mass: MegaMass }[] = [];
  for (const b of buildings) {
    // Cheap pre-filter before the ground sampler runs (tier tops are ≤ h).
    if ((b.minH ?? 0) >= 2.5 || b.h < BILLBOARD_MIN_H) continue;
    const mass = megaMass(b, groundAt);
    if (!mass || mass.h < BILLBOARD_MIN_H) continue;
    tall.push({ b, mass });
  }
  tall.sort((p, q) => q.mass.h - p.mass.h || p.b.id - q.b.id);
  const signCount = new Map<string, number>();
  const beaconCount = new Map<string, number>();
  const signs: MegaScreen[] = [];
  const beacons: MegaBeacon[] = [];
  const strips: MegaStrip[] = [];
  for (const { b, mass } of tall) {
    const p0 = b.poly[0]!;
    const cell = `${Math.floor(p0[0] / CELL_SIZE)}_${Math.floor(p0[1] / CELL_SIZE)}`;
    const placed = placeBuilding(b, mass, index, cityId, seed);
    let ns = signCount.get(cell) ?? 0;
    for (const s of placed.signs) {
      if (ns >= CAP_SIGNS) break;
      signs.push(s);
      ns++;
    }
    signCount.set(cell, ns);
    let nb = beaconCount.get(cell) ?? 0;
    for (const bc of placed.beacons) {
      if (nb >= CAP_BEACONS) break;
      beacons.push(bc);
      nb++;
    }
    beaconCount.set(cell, nb);
    strips.push(...placed.strips);
  }
  return [...signs, ...beacons, ...strips];
}

/** One merged mesh (typed arrays). Empty attributes have length 0. */
export interface MegaMesh {
  position: Float32Array;
  normal: Float32Array;
  /** Screens: face-local uv in [0, 1]². */
  uv: Float32Array;
  /** Screens: `(slot, phase, period, landscape 0|1)` per vertex. */
  info: Float32Array;
  /** Lights: linear RGB × gain per vertex. */
  glow: Float32Array;
  /** Lights: blink phase in [0, 1), or −1 for steady (strips). */
  blink: Float32Array;
  index: Uint32Array;
}

/** The three merged meshes of one cell (≤ 3 draw calls). */
export interface MegaCellMeshes {
  screens: MegaMesh;
  frames: MegaMesh;
  lights: MegaMesh;
}

type V3 = [number, number, number];

class Soup {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly info: number[] = [];
  readonly glow: number[] = [];
  readonly blink: number[] = [];
  readonly idx: number[] = [];

  /** Quad c0..c3 = bottom-left, bottom-right, top-right, top-left as seen from `n`. */
  quad(c0: V3, c1: V3, c2: V3, c3: V3, n: V3, extra?: (i: number) => void): void {
    const b = this.pos.length / 3;
    for (const [i, p] of [c0, c1, c2, c3].entries()) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      extra?.(i);
    }
    // Counter-clockwise seen from n when (c1 − c0) × (c3 − c0) · n > 0.
    const e1: V3 = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
    const e2: V3 = [c3[0] - c0[0], c3[1] - c0[1], c3[2] - c0[2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    else this.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }

  /** Oriented box: centre, unit axes, half extents. */
  box(c: V3, xu: V3, yu: V3, zu: V3, hx: number, hy: number, hz: number, extra?: (i: number) => void): void {
    const P = (sx: number, sy: number, sz: number): V3 => [
      c[0] + xu[0] * hx * sx + yu[0] * hy * sy + zu[0] * hz * sz,
      c[1] + xu[1] * hx * sx + yu[1] * hy * sy + zu[1] * hz * sz,
      c[2] + xu[2] * hx * sx + yu[2] * hy * sy + zu[2] * hz * sz,
    ];
    const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
    this.quad(P(1, -1, -1), P(1, -1, 1), P(1, 1, 1), P(1, 1, -1), xu, extra);
    this.quad(P(-1, -1, 1), P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), neg(xu), extra);
    this.quad(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1), yu, extra);
    this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, -1, -1), P(-1, -1, -1), neg(yu), extra);
    this.quad(P(-1, -1, 1), P(-1, 1, 1), P(1, 1, 1), P(1, -1, 1), zu, extra);
    this.quad(P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), P(-1, -1, -1), neg(zu), extra);
  }

  mesh(): MegaMesh {
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nrm),
      uv: new Float32Array(this.uv),
      info: new Float32Array(this.info),
      glow: new Float32Array(this.glow),
      blink: new Float32Array(this.blink),
      index: new Uint32Array(this.idx),
    };
  }
}

const UV_CORNERS: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * Merge a cell's ads into three meshes: emissive screen faces (uv + slot
 * info), dark frames / backplates / billboard legs, and beacons + strips
 * (per-vertex glow colour and blink phase).
 */
export function buildMegaAdMeshes(ads: readonly MegaAd[]): MegaCellMeshes {
  const screens = new Soup();
  const frames = new Soup();
  const lights = new Soup();
  const Y: V3 = [0, 1, 0];
  const beaconRgb = neonLinear(BEACON_COLOR).map((c) => c * MEGA_BEACON_GAIN) as V3;
  for (const ad of ads) {
    if (ad.kind === 'screen' || ad.kind === 'billboard') {
      const N: V3 = [ad.nx, 0, ad.nz];
      // Viewer's right when looking at the face (along −N).
      const R: V3 = [ad.nz, 0, -ad.nx];
      const hw = ad.width / 2;
      const hh = ad.height / 2;
      const C: V3 = [ad.x, ad.y, ad.z];
      const at = (sr: number, sy: number, sn = 0): V3 => [C[0] + R[0] * sr + N[0] * sn, C[1] + sy, C[2] + R[2] * sr + N[2] * sn];
      const info = [ad.slot, ad.phase, ad.period, ad.landscape ? 1 : 0];
      screens.quad(at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh), N, (i) => {
        const t = UV_CORNERS[i]!;
        screens.uv.push(t[0], t[1]);
        screens.info.push(info[0]!, info[1]!, info[2]!, info[3]!);
      });
      if (ad.kind === 'screen') {
        // Backplate bridging the 0.8 m gap to the wall, 0.3 m rim.
        const depth = MEGA_SCREEN_OFF - 0.08;
        frames.box(at(0, 0, -0.02 - depth / 2), R, Y, N, hw + 0.3, hh + 0.3, depth / 2);
      } else {
        frames.box(at(0, 0, -0.2), R, Y, N, hw + 0.3, hh + 0.3, 0.17);
        const base = ad.legBase ?? ad.y - hh - BILLBOARD_LEG;
        const legTop = ad.y + hh;
        const legs = ad.width > 16 ? [-1, 0, 1] : [-1, 1];
        for (const s of legs) {
          const lx = s * (hw - 0.8);
          frames.box(at(lx, (base + legTop) / 2 - ad.y, -0.55), R, Y, N, 0.15, (legTop - base) / 2, 0.15);
        }
      }
    } else if (ad.kind === 'beacon') {
      const s = BEACON_SIZE / 2;
      lights.box([ad.x, ad.y, ad.z], [1, 0, 0], Y, [0, 0, 1], s, s, s, () => {
        lights.glow.push(beaconRgb[0], beaconRgb[1], beaconRgb[2]);
        lights.blink.push(ad.phase);
      });
    } else if (ad.kind === 'strip') {
      const rgb = neonLinear(ad.color).map((c) => c * MEGA_STRIP_GAIN);
      const n = ad.ring.length;
      for (let i = 0; i < n; i++) {
        const a = ad.ring[i]!;
        const b = ad.ring[(i + 1) % n]!;
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < 0.5) continue;
        const nx = dz / len;
        const nz = -dx / len;
        const o = 0.06;
        const y0 = ad.y;
        const y1 = ad.y + ad.height;
        // Seen from outside, a → b runs right to left (outward normal on the right of a→b).
        lights.quad(
          [b[0] + nx * o, y0, b[1] + nz * o],
          [a[0] + nx * o, y0, a[1] + nz * o],
          [a[0] + nx * o, y1, a[1] + nz * o],
          [b[0] + nx * o, y1, b[1] + nz * o],
          [nx, 0, nz],
          () => {
            lights.glow.push(rgb[0]!, rgb[1]!, rgb[2]!);
            lights.blink.push(-1);
          },
        );
      }
    }
  }
  return { screens: screens.mesh(), frames: frames.mesh(), lights: lights.mesh() };
}

/** Counts by kind (stats / tests). */
export function countMegaAds(ads: readonly MegaAd[]): { screens: number; billboards: number; beacons: number; strips: number } {
  const c = { screens: 0, billboards: 0, beacons: 0, strips: 0 };
  for (const a of ads) {
    if (a.kind === 'screen') c.screens++;
    else if (a.kind === 'billboard') c.billboards++;
    else if (a.kind === 'beacon') c.beacons++;
    else c.strips++;
  }
  return c;
}

/** Atlas UV rect (texture v up, canvas row 0 at v = 1) of a content slot. */
export function megaSlotUv(landscape: boolean, slot: number): { u0: number; v0: number; u1: number; v1: number } {
  const w = landscape ? MEGA_LANDSCAPE_W : MEGA_PORTRAIT_W;
  const h = landscape ? MEGA_LANDSCAPE_H : MEGA_PORTRAIT_H;
  const cols = MEGA_ATLAS_SIZE / w;
  const x = (slot % cols) * w;
  const y = (landscape ? MEGA_LANDSCAPE_Y : 0) + Math.floor(slot / cols) * h;
  return { u0: x / MEGA_ATLAS_SIZE, u1: (x + w) / MEGA_ATLAS_SIZE, v1: 1 - y / MEGA_ATLAS_SIZE, v0: 1 - (y + h) / MEGA_ATLAS_SIZE };
}
