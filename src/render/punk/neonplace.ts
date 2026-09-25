/**
 * Pure neon-sign placement for the cyberpunk layer (wave 20b).
 * No `three/webgpu`, no DOM. Contract: docs/architecture.md §4.11
 * "`cyberpunk` v2" → "Neon signs".
 */
import type { Building, HeightFn, Road } from '../../data/types';
import { exteriorWalls, type WallSeg } from '../../world/buildings';

/** Tube colours (§4.11). Signs never use anything else. */
export const NEON_COLORS: readonly string[] = ['#ff2a6d', '#05d9e8', '#b967ff', '#ffb000', '#39ff14', '#ff073a'];

const ENGLISH: readonly string[] = [
  'BAR',
  'HOTEL',
  'NOODLES',
  '24H',
  'KARAOKE',
  'PHARMACY',
  'CINEMA',
  'RAMEN',
  'OPEN',
  'CAFE',
  'ARCADE',
  'TATTOO',
];

const KYIV: readonly string[] = ['КАВА', 'БАР', 'АПТЕКА', 'ГОТЕЛЬ', 'КІНО', 'ПИВО', '24/7', 'ПЕКАРНЯ'];

const TOKYO: readonly string[] = ['ラーメン', 'カラオケ', '居酒屋', '薬', 'ホテル', '寿司', 'バー', '喫茶'];

/**
 * Word lists by city id (§4.11). `london` / `sf` / `nyc` / `sydney` / `synthetic`
 * share the English list; unknown ids fall back to it inside {@link placeSigns}.
 */
export const WORDS: Readonly<Record<string, readonly string[]>> = {
  london: ENGLISH,
  sf: ENGLISH,
  nyc: ENGLISH,
  sydney: ENGLISH,
  synthetic: ENGLISH,
  kyiv: KYIV,
  tokyo: TOKYO,
};

/** One neon sign seated on a street-facing wall. `(x, y, z)` is the face centre. */
export interface Sign {
  buildingId: number;
  kind: 'blade' | 'panel';
  word: string;
  /** Tube colour, one of {@link NEON_COLORS}. */
  color: string;
  x: number;
  y: number;
  z: number;
  /** Unit outward wall normal in the xz plane. */
  nx: number;
  nz: number;
  width: number;
  height: number;
  /** Hash-timed flicker (about 8 % of signs). */
  flicker: boolean;
}

const MIN_H = 8;
const TALL_H = 20;
const MIN_EDGE = 6;
const ROAD_REACH = 12;
const EDGE_PROB = 0.12;
const BLADE_PROB = 0.6;
const FLICKER_PROB = 0.08;
const BLADE_WIDTH = 0.9;
const BLADE_OFF = 0.6;
const PANEL_OFF = 0.15;
/** Grid for the road-segment index. Coarser than {@link ROAD_REACH} is still exact. */
const GRID = 32;

/** Mulberry32: deterministic [0, 1) PRNG from a 32-bit seed. Copied from `world/textures.ts`. */
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

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  abx: number;
  abz: number;
  ab2: number;
}

function distToSeg(px: number, pz: number, s: Seg): number {
  let t = s.ab2 > 0 ? ((px - s.ax) * s.abx + (pz - s.az) * s.abz) / s.ab2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = px - (s.ax + s.abx * t);
  const dz = pz - (s.az + s.abz * t);
  return Math.hypot(dx, dz);
}

/** Bucket segments by every grid cell their bbox touches, so a 12 m query cannot miss one. */
function indexRoads(roads: readonly Road[]): Map<string, Seg[]> {
  const map = new Map<string, Seg[]>();
  const add = (key: string, seg: Seg): void => {
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(seg);
  };
  for (const road of roads) {
    for (let i = 0; i < road.pts.length - 1; i++) {
      const a = road.pts[i];
      const b = road.pts[i + 1];
      if (!a || !b) continue;
      const abx = b[0] - a[0];
      const abz = b[1] - a[1];
      const seg: Seg = { ax: a[0], az: a[1], bx: b[0], bz: b[1], abx, abz, ab2: abx * abx + abz * abz };
      const i0 = Math.floor(Math.min(a[0], b[0]) / GRID);
      const i1 = Math.floor(Math.max(a[0], b[0]) / GRID);
      const j0 = Math.floor(Math.min(a[1], b[1]) / GRID);
      const j1 = Math.floor(Math.max(a[1], b[1]) / GRID);
      for (let ci = i0; ci <= i1; ci++) {
        for (let cj = j0; cj <= j1; cj++) add(`${ci}_${cj}`, seg);
      }
    }
  }
  return map;
}

function nearRoad(index: Map<string, Seg[]>, x: number, z: number): boolean {
  const i0 = Math.floor((x - ROAD_REACH) / GRID);
  const i1 = Math.floor((x + ROAD_REACH) / GRID);
  const j0 = Math.floor((z - ROAD_REACH) / GRID);
  const j1 = Math.floor((z + ROAD_REACH) / GRID);
  for (let ci = i0; ci <= i1; ci++) {
    for (let cj = j0; cj <= j1; cj++) {
      const list = index.get(`${ci}_${cj}`);
      if (!list) continue;
      for (const seg of list) {
        if (distToSeg(x, z, seg) <= ROAD_REACH) return true;
      }
    }
  }
  return false;
}

function wordList(cityId: string): readonly string[] {
  return WORDS[cityId] ?? ENGLISH;
}

/**
 * Flicker bit from a second mulberry32 keyed by building id and sign x.
 * Drawing it from the placement stream misses the 4–12 % band on London
 * tile 0_0 (that uniform is a heavy tail), so flicker keeps its own seed.
 */
function flickers(buildingId: number, x: number): boolean {
  const rng = mulberry32((Math.imul(buildingId, 0x9e3779b1) ^ Math.round(x * 10)) >>> 0);
  return rng() < FLICKER_PROB;
}

interface Edge {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  len: number;
  nx: number;
  nz: number;
  midX: number;
  midZ: number;
  /** The exterior wall's y span (§4.2 "Tiers"). */
  base: number;
  top: number;
}

/** Street-facing exterior wall segments (tier walls after culling, else the envelope edges). */
function qualifyingEdges(walls: readonly WallSeg[], index: Map<string, Seg[]>): Edge[] {
  const out: Edge[] = [];
  for (const { a, b, base, top } of walls) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < MIN_EDGE) continue;
    const midX = (a[0] + b[0]) / 2;
    const midZ = (a[1] + b[1]) / 2;
    if (!nearRoad(index, midX, midZ)) continue;
    out.push({
      ax: a[0],
      az: a[1],
      bx: b[0],
      bz: b[1],
      len,
      nx: dz / len,
      nz: -dx / len,
      midX,
      midZ,
      base,
      top,
    });
  }
  return out;
}

/**
 * Place blade and panel signs on street-facing walls of one cell (§4.11).
 * Qualifying edges (h ≥ 8 m, edge ≥ 6 m, midpoint within 12 m of a same-cell
 * road) are kept with probability 0.12, at most 1 per building (2 if h ≥ 20).
 */
export function placeSigns(
  buildings: readonly Building[],
  roads: readonly Road[],
  heightAt: HeightFn,
  cityId: string,
): Sign[] {
  const list = wordList(cityId);
  const index = indexRoads(roads);
  const signs: Sign[] = [];
  for (const building of buildings) {
    if (building.h < MIN_H || building.poly.length < 3) continue;
    const edges = qualifyingEdges(exteriorWalls(building, heightAt), index);
    if (edges.length === 0) continue;
    if (!edges.every((e) => Number.isFinite(e.base))) continue;
    // Tier walls must hold the whole sign; envelope walls keep the pre-wave-22 placement.
    const tiered = building.tiers !== undefined && building.tiers.length > 0 && building.shape === undefined;
    const cap = building.h >= TALL_H ? 2 : 1;
    const rng = mulberry32(building.id ^ 0x9e3779b9);
    let placed = 0;
    for (const edge of edges) {
      if (placed >= cap) break;
      if (rng() >= EDGE_PROB) continue;
      const blade = rng() < BLADE_PROB;
      const word = list[Math.floor(rng() * list.length)] ?? list[0] ?? 'BAR';
      const color = NEON_COLORS[Math.floor(rng() * NEON_COLORS.length)] ?? NEON_COLORS[0] ?? '#ff2a6d';
      const width = blade ? BLADE_WIDTH : 3 + rng() * 4;
      const height = blade ? 3 + rng() * 3 : 1 + rng() * 0.6;
      const bottom = blade ? 3.5 + rng() * 1.5 : 4 + rng() * 4;
      const along = blade ? 0.25 + rng() * 0.5 : 0.5;
      const off = blade ? BLADE_OFF : PANEL_OFF;
      if (tiered && edge.base + bottom + height > edge.top) continue;
      const px = edge.ax + (edge.bx - edge.ax) * along;
      const pz = edge.az + (edge.bz - edge.az) * along;
      const x = px + edge.nx * off;
      signs.push({
        buildingId: building.id,
        kind: blade ? 'blade' : 'panel',
        word,
        color,
        x,
        y: edge.base + bottom + height / 2,
        z: pz + edge.nz * off,
        nx: edge.nx,
        nz: edge.nz,
        width,
        height,
        flicker: flickers(building.id, x),
      });
      placed++;
    }
  }
  return signs;
}
