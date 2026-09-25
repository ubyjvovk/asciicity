/**
 * Pure neon-sign placement, atlas slot maths and merged cell meshes for the
 * cyberpunk layer (wave 20b; v2 dense city profiles, wave 23b).
 * No `three/webgpu`, no DOM. Contract: docs/architecture.md §4.11
 * "`cyberpunk` v2" → "Neon signs" and "Neon v2 — dense city profiles".
 */
import type { Building, HeightFn, Road } from '../../data/types';
import { exteriorWalls, normalizeRing, ringHeights, type WallSeg } from '../../world/buildings';

/** Tube colours (§4.11 v2): the six neon colours + warm white + sodium. Signs never use anything else. */
export const NEON_COLORS: readonly string[] = [
  '#ff2a6d',
  '#05d9e8',
  '#b967ff',
  '#ffb000',
  '#39ff14',
  '#ff073a',
  '#fff1c1',
  '#ffcc33',
];

/** Warm white: a border option only (≈ 10 % of borders), never lettering. */
export const NEON_WARM_WHITE = '#fff1c1';

/** Lettering colours: {@link NEON_COLORS} without warm white (sodium stays). */
export const NEON_TEXT_COLORS: readonly string[] = NEON_COLORS.filter((c) => c !== NEON_WARM_WHITE);

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

const TOKYO: readonly string[] = [
  'ラーメン',
  'カラオケ',
  '居酒屋',
  '焼肉',
  '寿司',
  '薬',
  'ホテル',
  'バー',
  '喫茶',
  'パチンコ',
  'ゲーム',
  '酒',
  '麻雀',
  '占い',
  '質屋',
  '中華',
  '定食',
  '牛丼',
  '本',
  '電気',
  'カメラ',
  'スナック',
  '24時間',
  '営業中',
  '歯科',
  '美容室',
  'クラブ',
  '餃子',
  '天ぷら',
  'そば',
  'うどん',
  '酒場',
  '漫画',
  'カフェ',
  '古着',
  '整体',
  'マッサージ',
  '両替',
  '立ち飲み',
  '焼き鳥',
  '占星術',
  '薬局',
  '串カツ',
  '眼鏡',
  '時計',
  '雀荘',
  '洋食',
  '和食',
  '空室',
  '鮮魚',
];

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

/** Sign kinds (§4.11 v2). `stack` and `screen` only come from dense profiles. */
export type SignKind = 'blade' | 'panel' | 'stack' | 'screen';

/** One small panel of a `stack` sign (top to bottom), each with its own word and colours. */
export interface StackPanel {
  word: string;
  text: string;
  border: string;
}

/** One neon sign seated on a street-facing wall. `(x, y, z)` is the face centre. */
export interface Sign {
  buildingId: number;
  kind: SignKind;
  /** Word (for a stack: its top panel's). */
  word: string;
  /** Lettering colour, one of {@link NEON_COLORS}. */
  text: string;
  /** Tube-border colour, one of {@link NEON_COLORS}, never equal to `text`. */
  border: string;
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
  /** `stack` only: 2–4 panels, top to bottom. */
  panels?: StackPanel[];
}

/** Per-city placement rules (§4.11 "Neon v2"). */
export interface NeonProfile {
  /** Probability that a qualifying wall segment carries signs. */
  p: number;
  /** Minimum wall segment length, metres. */
  minEdge: number;
  /** Dense (storey-slot) placement with stacks and screens; else the v1 blade/panel rule. */
  dense: boolean;
  /** Per-building cap for a building of height `h`. */
  cap(h: number): number;
}

const DEFAULT_PROFILE: NeonProfile = { p: 0.24, minEdge: 6, dense: false, cap: () => 2 };

/**
 * Placement profiles by city id. `tokyo` is dense (Shinjuku stacks);
 * `minas-tirith` has no neon; any other id uses the default (v1 × 2).
 */
export const NEON_PROFILE: Readonly<Record<string, NeonProfile>> = {
  tokyo: { p: 0.7, minEdge: 4, dense: true, cap: (h) => Math.min(8, 2 + Math.floor(h / 15)) },
  'minas-tirith': { p: 0, minEdge: 6, dense: false, cap: () => 0 },
};

/** The profile for `cityId` (default for unknown ids). */
export function neonProfile(cityId: string): NeonProfile {
  return NEON_PROFILE[cityId] ?? DEFAULT_PROFILE;
}

const MIN_H = 8;
const ROAD_REACH = 12;
const BLADE_PROB = 0.6;
const FLICKER_PROB = 0.08;
const BLADE_WIDTH = 0.9;
const BLADE_OFF = 0.6;
const PANEL_OFF = 0.15;
/** Dense profile: storey slot pitch, top clamp, spacing on one wall, kind shares. */
const STOREY = 3.5;
const SLOT_TOP = 30;
const SPACING = 1.2;
const SHARE_BLADE = 0.45;
const SHARE_STACK = 0.25;
const SHARE_PANEL = 0.22;
const SCREEN_MIN_H = 30;
/**
 * Screen roll share on buildings ≥ 30 m. Only about a third of Tokyo's signs
 * sit on such buildings, so 0.35 there lands (after fit rejections) the city-wide share near 8 %.
 */
const SCREEN_TALL = 0.35;
const SCREEN_MIN_BOTTOM = 10;
/** Eye-level bias: first low slot (bottom 3.5 m), top of the low band, blade bottom ceiling, low share of the cap. */
const LOW_SLOT = 1;
const LOW_TOP = 12;
const BLADE_BOTTOM_MAX = 7;
const LOW_SHARE = 0.75;
const STACK_W = 1.6;
const STACK_H = 0.9;
const STACK_GAP = 0.1;
/** Wall footprint of a blade along the wall (its attachment strip). */
const BLADE_FOOT = 0.3;
/** Flat signs keep this far from the ends of their wall segment. */
const END_MARGIN = 0.2;
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
 * Flicker bit from a second mulberry32 keyed by building id and the sign's
 * position. Drawing it from the placement stream misses the 4–12 % band on
 * London tile 0_0 (that uniform is a heavy tail), so flicker keeps its own
 * seed; `y` is mixed in so signs stacked up one facade flicker independently.
 */
function flickers(buildingId: number, x: number, y: number): boolean {
  const seed = Math.imul(buildingId, 0x9e3779b1) ^ Math.round(x * 10) ^ Math.imul(Math.round(y * 10), 0x85ebca6b);
  return mulberry32(seed >>> 0)() < FLICKER_PROB;
}

interface Edge {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  len: number;
  nx: number;
  nz: number;
  /** The exterior wall's y span (§4.2 "Tiers"). */
  base: number;
  top: number;
  /** Wall-line key: building-local, shared by colinear segments. */
  line: string;
}

/** Street-facing exterior wall segments (tier walls after culling, else the envelope edges). */
function qualifyingEdges(walls: readonly WallSeg[], index: Map<string, Seg[]>, minEdge: number): Edge[] {
  const out: Edge[] = [];
  for (const { a, b, base, top } of walls) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < minEdge) continue;
    const midX = (a[0] + b[0]) / 2;
    const midZ = (a[1] + b[1]) / 2;
    if (!nearRoad(index, midX, midZ)) continue;
    const nx = dz / len;
    const nz = -dx / len;
    const off = a[0] * nx + a[1] * nz;
    out.push({
      ax: a[0],
      az: a[1],
      bx: b[0],
      bz: b[1],
      len,
      nx,
      nz,
      base,
      top,
      line: `${Math.round(nx * 1000)}:${Math.round(nz * 1000)}:${Math.round(off * 10)}`,
    });
  }
  return out;
}

function pick<T>(rng: () => number, list: readonly T[], fallback: T): T {
  return list[Math.floor(rng() * list.length)] ?? fallback;
}

/** Share of atlas keys whose border is warm white (the PM cap is 15 % of borders). */
const WARM_BORDER = 0.1;

/**
 * The sign's (text, border) colour pair, a pure function of its atlas key
 * `kind|word` (hash-seeded), so a shared atlas slot always matches the sign's
 * glow card and spill light. Text never warm white; border ≠ text.
 */
export function neonColours(kind: SignKind, word: string): { text: string; border: string } {
  const rng = mulberry32(neonKeyHash(neonAtlasKey(kind, word)));
  const texts = NEON_TEXT_COLORS;
  const t = Math.floor(rng() * texts.length);
  const text = texts[t] ?? '#ff2a6d';
  if (rng() < WARM_BORDER) return { text, border: NEON_WARM_WHITE };
  const b = (t + 1 + Math.floor(rng() * (texts.length - 1))) % texts.length;
  return { text, border: texts[b] ?? '#05d9e8' };
}

/** v1 rule (default profile): 60 % blades / 40 % panels, low on the wall, cap per building. */
function placeDefault(
  building: Building,
  edges: readonly Edge[],
  profile: NeonProfile,
  list: readonly string[],
  out: Sign[],
): void {
  // Tier walls must hold the whole sign; envelope walls keep the pre-wave-22 placement.
  const tiered = building.tiers !== undefined && building.tiers.length > 0 && building.shape === undefined;
  const cap = profile.cap(building.h);
  const rng = mulberry32(building.id ^ 0x9e3779b9);
  let placed = 0;
  for (const edge of edges) {
    if (placed >= cap) break;
    if (rng() >= profile.p) continue;
    const blade = rng() < BLADE_PROB;
    const word = pick(rng, list, 'BAR');
    const { text, border } = neonColours(blade ? 'blade' : 'panel', word);
    const width = blade ? BLADE_WIDTH : 3 + rng() * 4;
    const height = blade ? 3 + rng() * 3 : 1 + rng() * 0.6;
    const bottom = blade ? 3.5 + rng() * 1.5 : 4 + rng() * 4;
    const along = blade ? 0.25 + rng() * 0.5 : 0.5;
    const off = blade ? BLADE_OFF : PANEL_OFF;
    if (tiered && edge.base + bottom + height > edge.top) continue;
    const px = edge.ax + (edge.bx - edge.ax) * along;
    const pz = edge.az + (edge.bz - edge.az) * along;
    const x = px + edge.nx * off;
    const y = edge.base + bottom + height / 2;
    out.push({
      buildingId: building.id,
      kind: blade ? 'blade' : 'panel',
      word,
      text,
      border,
      x,
      y,
      z: pz + edge.nz * off,
      nx: edge.nx,
      nz: edge.nz,
      width,
      height,
      flicker: flickers(building.id, x, y),
    });
    placed++;
  }
}

/** Wall footprint of a placed sign: `[a0, a1]` along the wall line, `[y0, y1]` world height. */
interface Foot {
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

function tooClose(feet: readonly Foot[], f: Foot): boolean {
  for (const g of feet) {
    const gapA = Math.max(g.a0 - f.a1, f.a0 - g.a1);
    const gapY = Math.max(g.y0 - f.y1, f.y0 - g.y1);
    if (gapA < SPACING && gapY < SPACING) return true;
  }
  return false;
}

/**
 * Dense rule (tokyo): each qualifying wall segment is active with `p`; signs
 * sit in 3.5 m storey slots above the wall base, ≥ 1.2 m apart on one wall
 * line, until the per-building cap. Eye-level bias (PM rework): blades hang
 * with bottom in [3, 7] m; stacks and panels fill the [3, 12] m slots
 * bottom-up (walls round-robin) for the first 75 % of the cap, the rest go
 * higher, up to `min(h − 2, 30)`; screens keep bottom ≥ 10 m.
 */
function placeDense(
  building: Building,
  edges: readonly Edge[],
  profile: NeonProfile,
  list: readonly string[],
  heightAt: HeightFn,
  out: Sign[],
): void {
  const rng = mulberry32(building.id ^ 0x9e3779b9);
  const active = edges.filter(() => rng() < profile.p);
  if (active.length === 0) return;
  const cap = profile.cap(building.h);
  const lowCap = Math.ceil(cap * LOW_SHARE);
  const { base } = ringHeights(normalizeRing(building.poly), heightAt);
  const wallBase = base + (building.minH ?? 0);
  const slots = Math.floor(Math.min(building.h - 2, SLOT_TOP) / STOREY + 1e-9);
  if (slots < 1) return;
  const screenOk = building.h >= SCREEN_MIN_H;
  let longest = active[0];
  for (const e of active) if (longest && e.len > longest.len) longest = e;
  const feet = new Map<string, Foot[]>();
  let placed = 0;
  let high = 0;
  const attempts = cap * 6;
  for (let i = 0; i < attempts && placed < cap; i++) {
    const u = rng();
    let kind: SignKind = 'screen';
    if (!screenOk || u >= SCREEN_TALL) {
      const r = (screenOk ? (u - SCREEN_TALL) / (1 - SCREEN_TALL) : u) * (SHARE_BLADE + SHARE_STACK + SHARE_PANEL);
      kind = r < SHARE_BLADE ? 'blade' : r < SHARE_BLADE + SHARE_STACK ? 'stack' : 'panel';
    }
    const word = pick(rng, list, 'バー');
    const { text, border } = neonColours(kind, word);
    let width: number;
    let height: number;
    let panels: StackPanel[] | undefined;
    if (kind === 'blade') {
      width = 0.8 + rng() * 0.4;
      height = 3 + rng() * 4;
    } else if (kind === 'stack') {
      const n = 2 + Math.floor(rng() * 3);
      panels = [{ word, text, border }];
      for (let k = 1; k < n; k++) {
        const w = pick(rng, list, 'バー');
        panels.push({ word: w, ...neonColours('stack', w) });
      }
      width = STACK_W;
      height = n * STACK_H + (n - 1) * STACK_GAP;
    } else if (kind === 'panel') {
      width = 3 + rng() * 4;
      height = 1 + rng() * 0.6;
    } else {
      width = 6 + rng() * 6;
      height = 4 + rng() * 4;
    }
    // Screens take the building's longest active facade; the rest go round-robin.
    const edge = kind === 'screen' ? longest : active[i % active.length];
    if (!edge) break;
    const t = rng();
    const pickSlot = rng();
    const flat = kind !== 'blade';
    if (flat) width = Math.min(width, edge.len - 2 * END_MARGIN);
    const minW = kind === 'panel' ? 3 : kind === 'screen' ? 6 : kind === 'stack' ? STACK_W : 0;
    if (width < minW - 1e-9) continue;
    const foot = flat ? width : BLADE_FOOT;
    const lo = END_MARGIN + foot / 2;
    const hi = edge.len - END_MARGIN - foot / 2;
    if (hi < lo) continue;
    const along = lo + (hi - lo) * t;
    const lineA = edge.ax * -edge.nz + edge.az * edge.nx + along;
    let onLine = feet.get(edge.line);
    if (!onLine) {
      onLine = [];
      feet.set(edge.line, onLine);
    }
    // Storey slots whose sign fits inside this wall segment's y span.
    const fitLo = Math.max(1, Math.ceil((edge.base - wallBase) / STOREY - 1e-9));
    const fitHi = Math.min(slots, Math.floor((edge.top - wallBase - height) / STOREY + 1e-9));
    const lowTop = Math.floor((kind === 'blade' ? BLADE_BOTTOM_MAX : LOW_TOP) / STOREY + 1e-9);
    // Candidate slots in try order: low ones bottom-up; high ones (above LOW_TOP) from a random start.
    const lowRange = (): number[] => range(Math.max(fitLo, LOW_SLOT), Math.min(fitHi, lowTop));
    const highRange = (): number[] => rotate(range(Math.max(fitLo, lowTop + 1), fitHi), pickSlot);
    let order: number[];
    if (kind === 'screen') order = rotate(range(Math.max(fitLo, Math.ceil(SCREEN_MIN_BOTTOM / STOREY)), fitHi), pickSlot);
    else if (kind === 'blade') order = lowRange();
    else if (placed >= lowCap && high < cap - lowCap) order = [...highRange(), ...lowRange()];
    else order = [...lowRange(), ...highRange()];
    let chosen = -1;
    for (const slot of order) {
      const y0 = wallBase + slot * STOREY;
      if (y0 < edge.base - 1e-6 || y0 + height > edge.top + 1e-6) continue;
      if (tooClose(onLine, { a0: lineA - foot / 2, a1: lineA + foot / 2, y0, y1: y0 + height })) continue;
      chosen = slot;
      break;
    }
    if (chosen < 0) continue;
    const bottom = wallBase + chosen * STOREY;
    onLine.push({ a0: lineA - foot / 2, a1: lineA + foot / 2, y0: bottom, y1: bottom + height });
    if (kind !== 'screen' && chosen > lowTop) high++;
    const off = flat ? PANEL_OFF : BLADE_OFF;
    const px = edge.ax + ((edge.bx - edge.ax) * along) / edge.len;
    const pz = edge.az + ((edge.bz - edge.az) * along) / edge.len;
    const x = px + edge.nx * off;
    const y = bottom + height / 2;
    const sign: Sign = {
      buildingId: building.id,
      kind,
      word,
      text,
      border,
      x,
      y,
      z: pz + edge.nz * off,
      nx: edge.nx,
      nz: edge.nz,
      width,
      height,
      flicker: flickers(building.id, x, y),
    };
    if (panels) sign.panels = panels;
    out.push(sign);
    placed++;
  }
}

/** Integers `a..b` inclusive (empty when `b < a`). */
function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let k = a; k <= b; k++) out.push(k);
  return out;
}

/** `list` rotated to start at index `⌊u · length⌋`. */
function rotate(list: number[], u: number): number[] {
  const k = Math.floor(u * list.length);
  return [...list.slice(k), ...list.slice(0, k)];
}

/**
 * Place neon signs on street-facing exterior walls of one cell (§4.11 "Neon
 * v2"). Qualifying segments: building h ≥ 8 m, segment ≥ the profile's
 * `minEdge`, midpoint within 12 m of a same-cell road. The city's
 * {@link NEON_PROFILE} decides density, kinds and caps.
 */
export function placeSigns(
  buildings: readonly Building[],
  roads: readonly Road[],
  heightAt: HeightFn,
  cityId: string,
): Sign[] {
  const profile = neonProfile(cityId);
  const signs: Sign[] = [];
  if (profile.p <= 0) return signs;
  const list = wordList(cityId);
  const index = indexRoads(roads);
  for (const building of buildings) {
    if (building.h < MIN_H || building.poly.length < 3) continue;
    const edges = qualifyingEdges(exteriorWalls(building, heightAt), index, profile.minEdge);
    if (edges.length === 0) continue;
    if (!edges.every((e) => Number.isFinite(e.base))) continue;
    if (profile.dense) placeDense(building, edges, profile, list, heightAt, signs);
    else placeDefault(building, edges, profile, list, signs);
  }
  return signs;
}

// ---------------------------------------------------------------------------
// Atlas slot maths (pure; the canvas lives in `neonatlas.ts`).

/** Atlas edge in pixels (one texture). */
export const NEON_ATLAS_SIZE = 2048;
/** Landscape slot size in pixels. */
export const NEON_SLOT_W = 256;
/** Landscape slot size in pixels. */
export const NEON_SLOT_H = 128;
/** Slot grid columns. */
export const NEON_ATLAS_COLS = NEON_ATLAS_SIZE / NEON_SLOT_W;
/** Slot grid rows. */
export const NEON_ATLAS_ROWS = NEON_ATLAS_SIZE / NEON_SLOT_H;
/** Slot capacity: 8 × 16 = 128. */
export const NEON_ATLAS_SLOTS = NEON_ATLAS_COLS * NEON_ATLAS_ROWS;

/** UV rectangle of one atlas slot. `v0` is the bottom, `v1` the top (flipY upload); `rot` = portrait glyph column. */
export interface SlotUv {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  rot: boolean;
}

/** Atlas key `kind|word`; the colours follow from it ({@link neonColours}). */
export function neonAtlasKey(kind: SignKind, word: string): string {
  return `${kind}|${word}`;
}

/** Split an atlas key back into its parts plus the key's colour pair (a bad kind falls back to a panel). */
export function parseNeonAtlasKey(key: string): { kind: SignKind; word: string; text: string; border: string } {
  const bar = key.indexOf('|');
  const k = bar < 0 ? key : key.slice(0, bar);
  const word = bar < 0 ? '' : key.slice(bar + 1);
  const kind: SignKind = k === 'blade' || k === 'stack' || k === 'screen' ? k : 'panel';
  return { kind, word, ...neonColours(kind, word) };
}

/** FNV-1a 32-bit hash of an atlas key (overflow slot). */
export function neonKeyHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Blades rotate their glyph column into the landscape slot (portrait on the face). */
export function neonSlotRotated(kind: SignKind): boolean {
  return kind === 'blade';
}

/** UV rectangle of slot `slot` (row 0 at the top of the canvas). */
export function neonSlotUv(slot: number, rot: boolean): SlotUv {
  const col = slot % NEON_ATLAS_COLS;
  const row = Math.floor(slot / NEON_ATLAS_COLS);
  return {
    u0: col / NEON_ATLAS_COLS,
    u1: (col + 1) / NEON_ATLAS_COLS,
    v1: 1 - row / NEON_ATLAS_ROWS,
    v0: 1 - (row + 1) / NEON_ATLAS_ROWS,
    rot,
  };
}

/**
 * Key → slot table: the first {@link NEON_ATLAS_SLOTS} distinct keys get
 * slots 0, 1, 2, …; later keys reuse a drawn slot without evicting — one of
 * the same kind and colour pair when there is one (so glyph orientation,
 * glow card and spill light still agree), else of the same kind, else
 * `hash(key) % 128`. The choice among candidates is `hash(key) % count`.
 */
export class NeonSlotTable {
  private readonly slots = new Map<string, number>();
  /** Drawn slots in slot order: kind, colours and `kind|text|border` of the key that drew each. */
  private readonly owners: { kind: string; text: string; border: string; look: string }[] = [];

  /** Slot for `key`; `fresh` is true when the caller must draw it. */
  slotFor(key: string): { slot: number; fresh: boolean } {
    const existing = this.slots.get(key);
    if (existing !== undefined) return { slot: existing, fresh: false };
    const { kind, text, border } = parseNeonAtlasKey(key);
    const look = `${kind}|${text}|${border}`;
    let slot: number;
    let fresh = false;
    if (this.owners.length < NEON_ATLAS_SLOTS) {
      slot = this.owners.length;
      this.owners.push({ kind, text, border, look });
      fresh = true;
    } else {
      const h = neonKeyHash(key);
      const same: number[] = [];
      const sameKind: number[] = [];
      this.owners.forEach((o, i) => {
        if (o.look === look) same.push(i);
        if (o.kind === kind) sameKind.push(i);
      });
      const pool = same.length > 0 ? same : sameKind;
      slot = pool.length > 0 ? (pool[h % pool.length] ?? 0) : h % NEON_ATLAS_SLOTS;
    }
    this.slots.set(key, slot);
    return { slot, fresh };
  }

  /** Colours actually drawn in `slot` (those of the key that drew it); null if not drawn yet. */
  lookOf(slot: number): { text: string; border: string } | null {
    const o = this.owners[slot];
    return o ? { text: o.text, border: o.border } : null;
  }

  /** Slots drawn so far (≤ 128). */
  get drawn(): number {
    return this.owners.length;
  }

  /** Forget every key. */
  clear(): void {
    this.slots.clear();
    this.owners.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Merged cell meshes (pure arrays; `neon.ts` wraps them in BufferGeometry).

/** Emissive gain of tube faces (PM tune ×7) and of facade screens (×3). */
export const NEON_TUBE_GAIN = 7;
/** Emissive gain of facade screens. */
export const NEON_SCREEN_GAIN = 3;
/** Glow card: size factor over the sign, colour factor, offset off the wall. */
export const NEON_GLOW_SCALE = 2.2;
/** Glow card colour factor (× linear sign colour). */
export const NEON_GLOW_STRENGTH = 0.35;
/** Glow card distance in front of the wall. */
export const NEON_GLOW_OFF = 0.05;

type V3 = [number, number, number];

const FRAME_T = 0.08;
const FRAME_D = 0.08;

function add3(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub3(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function mul3(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross3(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len3(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** One merged mesh as flat arrays. Unused attributes are empty. */
export interface NeonMesh {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** Per-vertex flicker seed (0 = steady). */
  flicker: Float32Array;
  /** Per-vertex emissive gain (faces). */
  gain: Float32Array;
  /** Per-vertex linear RGB (glow cards). */
  color: Float32Array;
  index: Uint32Array;
}

/** The three merged meshes of one cell (3 draw calls). */
export interface NeonCellMeshes {
  faces: NeonMesh;
  frames: NeonMesh;
  glow: NeonMesh;
}

/** Merged triangle soup. Winding is flipped so each quad faces `n`. */
class Soup {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly flick: number[] = [];
  readonly gain: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  /** Corners c0..c3 = bottom-left, bottom-right, top-right, top-left of the face. */
  quad(c0: V3, c1: V3, c2: V3, c3: V3, uv: SlotUv | null, n: V3, flick: number, gain: number, col: V3 | null): void {
    const b = this.pos.length / 3;
    const corners = [c0, c1, c2, c3];
    const r = uv ?? { u0: 0, v0: 0, u1: 1, v1: 1, rot: false };
    // Rotated slots: face top → slot left, face right → slot top.
    const uvs: [number, number][] = r.rot
      ? [
          [r.u1, r.v0],
          [r.u1, r.v1],
          [r.u0, r.v1],
          [r.u0, r.v0],
        ]
      : [
          [r.u0, r.v0],
          [r.u1, r.v0],
          [r.u1, r.v1],
          [r.u0, r.v1],
        ];
    for (let i = 0; i < 4; i++) {
      const p = corners[i]!;
      const t = uvs[i]!;
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.uv.push(t[0], t[1]);
      this.flick.push(flick);
      this.gain.push(gain);
      if (col) this.col.push(col[0], col[1], col[2]);
    }
    const flip = dot3(cross3(sub3(c1, c0), sub3(c3, c0)), n) < 0;
    if (!flip) this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    else this.idx.push(b, b + 3, b + 2, b, b + 2, b + 1);
  }

  mesh(withUv: boolean, withGain: boolean, withColor: boolean): NeonMesh {
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nrm),
      uv: new Float32Array(withUv ? this.uv : []),
      flicker: new Float32Array(withUv ? this.flick : []),
      gain: new Float32Array(withGain ? this.gain : []),
      color: new Float32Array(withColor ? this.col : []),
      index: new Uint32Array(this.idx),
    };
  }
}

function box(buf: Soup, center: V3, xu: V3, yu: V3, zu: V3, hx: number, hy: number, hz: number): void {
  const ax = mul3(xu, hx);
  const ay = mul3(yu, hy);
  const az = mul3(zu, hz);
  const c = (sx: number, sy: number, sz: number): V3 => add3(center, add3(mul3(ax, sx), add3(mul3(ay, sy), mul3(az, sz))));
  const q = (a: V3, b: V3, c2: V3, d: V3, n: V3): void => buf.quad(a, b, c2, d, null, n, 0, 0, null);
  q(c(1, -1, -1), c(1, -1, 1), c(1, 1, 1), c(1, 1, -1), xu);
  q(c(-1, -1, 1), c(-1, -1, -1), c(-1, 1, -1), c(-1, 1, 1), mul3(xu, -1));
  q(c(-1, 1, -1), c(1, 1, -1), c(1, 1, 1), c(-1, 1, 1), yu);
  q(c(-1, -1, 1), c(1, -1, 1), c(1, -1, -1), c(-1, -1, -1), mul3(yu, -1));
  q(c(-1, -1, 1), c(-1, 1, 1), c(1, 1, 1), c(1, -1, 1), zu);
  q(c(1, -1, -1), c(1, 1, -1), c(-1, 1, -1), c(-1, -1, -1), mul3(zu, -1));
}

function frameAround(buf: Soup, center: V3, axisW: V3, axisH: V3, axisN: V3, width: number, height: number): void {
  const hw = width / 2;
  const hh = height / 2;
  const t = FRAME_T;
  box(buf, add3(center, mul3(axisH, -(hh + t / 2))), axisW, axisH, axisN, hw + t, t / 2, FRAME_D / 2);
  box(buf, add3(center, mul3(axisH, hh + t / 2)), axisW, axisH, axisN, hw + t, t / 2, FRAME_D / 2);
  box(buf, add3(center, mul3(axisW, -(hw + t / 2))), axisW, axisH, axisN, t / 2, hh, FRAME_D / 2);
  box(buf, add3(center, mul3(axisW, hw + t / 2)), axisW, axisH, axisN, t / 2, hh, FRAME_D / 2);
}

function bracket(buf: Soup, from: V3, to: V3): void {
  const span = sub3(to, from);
  const L = len3(span);
  if (L < 1e-3) return;
  const dir = mul3(span, 1 / L);
  let side = cross3(dir, [0, 1, 0]);
  const sl = len3(side);
  side = sl < 1e-4 ? [1, 0, 0] : mul3(side, 1 / sl);
  const lift = cross3(side, dir);
  box(buf, mul3(add3(from, to), 0.5), dir, lift, side, L / 2, 0.04, 0.04);
}

/** Per-sign flicker phase in (0, 1]; 0 means the sign stays on. */
export function neonFlickerSeed(sign: Sign): number {
  if (!sign.flicker) return 0;
  let h = (sign.buildingId ^ Math.imul(Math.round(sign.x * 10), 0x45d9f3b)) >>> 0;
  h = Math.imul(h ^ Math.round(sign.z * 10), 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ Math.round(sign.y * 10), 0x165667b1) >>> 0;
  return 0.15 + (h / 4294967296) * 0.85;
}

/** sRGB hex `#rrggbb` → linear RGB. */
export function neonLinear(hex: string): V3 {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const ch = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
}

/** A flat face on the wall plane centred at `C`, facing `N`. */
function flatFace(buf: Soup, C: V3, T: V3, N: V3, hw: number, hh: number, uv: SlotUv, flick: number, gain: number): void {
  const Y: V3 = [0, 1, 0];
  buf.quad(
    add3(C, add3(mul3(T, hw), mul3(Y, -hh))),
    add3(C, add3(mul3(T, -hw), mul3(Y, -hh))),
    add3(C, add3(mul3(T, -hw), mul3(Y, hh))),
    add3(C, add3(mul3(T, hw), mul3(Y, hh))),
    uv,
    N,
    flick,
    gain,
    null,
  );
}

/**
 * Build the three merged meshes of one cell: faces (atlas UVs, flicker seed,
 * emissive gain), frames + brackets, and additive glow cards on the wall.
 * `uvFor(kind, word)` resolves an atlas slot.
 */
export function buildNeonMeshes(
  signs: readonly Sign[],
  uvFor: (kind: SignKind, word: string) => SlotUv,
): NeonCellMeshes {
  const faces = new Soup();
  const frames = new Soup();
  const glow = new Soup();
  const Y: V3 = [0, 1, 0];
  for (const sign of signs) {
    const flick = neonFlickerSeed(sign);
    const C: V3 = [sign.x, sign.y, sign.z];
    const N: V3 = [sign.nx, 0, sign.nz];
    // Tangent: with N = (dz, −dx)/len, T = (−nz, nx) runs a → b along the wall.
    const T: V3 = [-sign.nz, 0, sign.nx];
    const hw = sign.width / 2;
    const hh = sign.height / 2;
    const off = sign.kind === 'blade' ? BLADE_OFF : PANEL_OFF;
    const wall = sub3(C, mul3(N, off));

    if (sign.kind === 'blade') {
      const uv = uvFor('blade', sign.word);
      const gap = 0.05;
      // Faces lie in the normal/up plane; the back face mirrors U so text reads from both sides.
      const front = add3(C, mul3(T, gap));
      faces.quad(
        add3(front, add3(mul3(N, -hw), mul3(Y, -hh))),
        add3(front, add3(mul3(N, hw), mul3(Y, -hh))),
        add3(front, add3(mul3(N, hw), mul3(Y, hh))),
        add3(front, add3(mul3(N, -hw), mul3(Y, hh))),
        uv,
        T,
        flick,
        NEON_TUBE_GAIN,
        null,
      );
      const back = add3(C, mul3(T, -gap));
      faces.quad(
        add3(back, add3(mul3(N, hw), mul3(Y, -hh))),
        add3(back, add3(mul3(N, -hw), mul3(Y, -hh))),
        add3(back, add3(mul3(N, -hw), mul3(Y, hh))),
        add3(back, add3(mul3(N, hw), mul3(Y, hh))),
        uv,
        mul3(T, -1),
        flick,
        NEON_TUBE_GAIN,
        null,
      );
      frameAround(frames, C, N, Y, T, sign.width, sign.height);
      for (const f of [-0.32, 0.32]) {
        const y = sign.y + sign.height * f;
        bracket(frames, [wall[0], y, wall[2]], [sign.x, y, sign.z]);
      }
    } else if (sign.kind === 'stack' && sign.panels && sign.panels.length > 0) {
      const n = sign.panels.length;
      const ph = (sign.height - (n - 1) * STACK_GAP) / n;
      const O = add3(C, mul3(N, 0.015));
      for (let k = 0; k < n; k++) {
        const p = sign.panels[k]!;
        const cy = hh - ph / 2 - k * (ph + STACK_GAP);
        const uv = uvFor('stack', p.word);
        flatFace(faces, add3(O, mul3(Y, cy)), T, N, hw, ph / 2, uv, flick, NEON_TUBE_GAIN);
        frameAround(frames, add3(C, mul3(Y, cy)), T, Y, N, sign.width, ph);
      }
    } else {
      const uv = uvFor(sign.kind, sign.word);
      const gain = sign.kind === 'screen' ? NEON_SCREEN_GAIN : NEON_TUBE_GAIN;
      flatFace(faces, add3(C, mul3(N, 0.015)), T, N, hw, hh, uv, flick, gain);
      frameAround(frames, C, T, Y, N, sign.width, sign.height);
    }

    // Fake spill: additive card on the wall behind the sign, 2.2 × its size.
    const col = mul3(neonLinear(sign.text), NEON_GLOW_STRENGTH);
    const gw = (sign.kind === 'blade' ? Math.max(sign.width, 1) : sign.width) * NEON_GLOW_SCALE * 0.5;
    const gh = sign.height * NEON_GLOW_SCALE * 0.5;
    const G = add3(wall, mul3(N, NEON_GLOW_OFF));
    glow.quad(
      add3(G, add3(mul3(T, gw), mul3(Y, -gh))),
      add3(G, add3(mul3(T, -gw), mul3(Y, -gh))),
      add3(G, add3(mul3(T, -gw), mul3(Y, gh))),
      add3(G, add3(mul3(T, gw), mul3(Y, gh))),
      null,
      N,
      flick,
      0,
      col,
    );
  }
  return { faces: faces.mesh(true, true, false), frames: frames.mesh(false, false, false), glow: glow.mesh(true, false, true) };
}
