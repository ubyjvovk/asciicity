/**
 * Neon sign placement (wave 20b, src/render/punk/neonplace.ts).
 * London tile 0_0 is bucketed with `bucketSources` the way CellStreamer does,
 * then placed per cell against that cell's roads only.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAT_HEIGHT, type Building, type HeightFn, type Road } from '../src/data/types';
import { bucketSources } from '../src/render/punk/cells';
import type { PunkSource } from '../src/render/punk/layer';
import {
  NEON_ATLAS_SLOTS,
  NEON_COLORS,
  NEON_TEXT_COLORS,
  NEON_WARM_WHITE,
  NeonSlotTable,
  WORDS,
  buildNeonMeshes,
  neonAtlasKey,
  neonColours,
  neonKeyHash,
  neonSlotUv,
  parseNeonAtlasKey,
  placeSigns,
  type Sign,
} from '../src/render/punk/neonplace';
import { exteriorWalls, normalizeRing, ringHeights } from '../src/world/buildings';
import { createHash } from 'node:crypto';

const tilePath = join(dirname(fileURLToPath(import.meta.url)), '../public/data/london/tiles/0_0.json');
const tile = JSON.parse(readFileSync(tilePath, 'utf8')) as { buildings: Building[]; roads: Road[] };
const sources = new Map<string, PunkSource>([['0_0', { buildings: tile.buildings, roads: tile.roads }]]);
const cells = [...bucketSources(sources).values()];
const placed = cells.map((cell) => ({
  cell,
  signs: placeSigns(cell.buildings, cell.roads, FLAT_HEIGHT, 'london'),
}));
const londonSigns = placed.flatMap((p) => p.signs);

const ENGLISH = new Set(WORDS.london);
const COLORS = new Set(NEON_COLORS);

interface Located {
  len: number;
  t: number;
  nx: number;
  nz: number;
  midX: number;
  midZ: number;
  ax: number;
  az: number;
  wallBase: number;
}

function locate(sign: Sign, building: Building, heightAt: HeightFn): Located | null {
  const ring = normalizeRing(building.poly);
  const off = sign.kind === 'blade' ? 0.6 : 0.15;
  const wx = sign.x - sign.nx * off;
  const wz = sign.z - sign.nz * off;
  const { base } = ringHeights(ring, heightAt);
  const wallBase = base + (building.minH ?? 0);
  let best: Located | null = null;
  let bestD = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    const nx = dz / len;
    const nz = -dx / len;
    if (nx * sign.nx + nz * sign.nz < 0.999) continue;
    const tt = ((wx - a[0]) * dx + (wz - a[1]) * dz) / (len * len);
    // Colinear facade edges share a normal; only the segment that actually
    // holds the sign has t inside [0, 1].
    if (tt < -1e-3 || tt > 1 + 1e-3) continue;
    const px = a[0] + dx * tt;
    const pz = a[1] + dz * tt;
    const d = Math.hypot(wx - px, wz - pz);
    if (d < bestD) {
      bestD = d;
      best = {
        len,
        t: tt,
        nx,
        nz,
        midX: (a[0] + b[0]) / 2,
        midZ: (a[1] + b[1]) / 2,
        ax: a[0],
        az: a[1],
        wallBase,
      };
    }
  }
  if (!best || bestD > 0.05) return null;
  return best;
}

function roadDist(x: number, z: number, roads: readonly Road[]): number {
  let best = Infinity;
  for (const road of roads) {
    for (let i = 0; i < road.pts.length - 1; i++) {
      const a = road.pts[i];
      const b = road.pts[i + 1];
      if (!a || !b) continue;
      const abx = b[0] - a[0];
      const abz = b[1] - a[1];
      const ab2 = abx * abx + abz * abz;
      let t = ab2 > 0 ? ((x - a[0]) * abx + (z - a[1]) * abz) / ab2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const d = Math.hypot(x - (a[0] + abx * t), z - (a[1] + abz * t));
      if (d < best) best = d;
    }
  }
  return best;
}

function street(n: number, h: number, zEdge: number): { buildings: Building[]; roads: Road[] } {
  const buildings: Building[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * 28;
    buildings.push({
      id: i + 1,
      h,
      poly: [
        [x, zEdge],
        [x + 16, zEdge],
        [x + 16, zEdge + 14],
        [x, zEdge + 14],
      ],
    });
  }
  return {
    buildings,
    roads: [{ id: 1, cls: 'residential', pts: [[-30, -4], [n * 28, -4]] }],
  };
}

describe('placeSigns', () => {
  it('london tile 0_0: sign count and per-building cap', () => {
    // v2 default profile: p 0.24, cap 2 (v1 was 0.12, cap 1/2 → 204 signs).
    expect(londonSigns.length).toBeGreaterThanOrEqual(250);
    expect(londonSigns.length).toBeLessThanOrEqual(600);
    const byId = new Map<number, Building>();
    for (const cell of cells) for (const b of cell.buildings) byId.set(b.id, b);
    const counts = new Map<number, number>();
    for (const sign of londonSigns) counts.set(sign.buildingId, (counts.get(sign.buildingId) ?? 0) + 1);
    for (const [id, n] of counts) {
      const h = byId.get(id)?.h ?? 0;
      expect(h).toBeGreaterThanOrEqual(8);
      expect(n).toBeLessThanOrEqual(2);
    }
  });

  it('every sign sits on a long street-facing edge of a tall building', () => {
    for (const { cell, signs } of placed) {
      const byId = new Map(cell.buildings.map((b) => [b.id, b]));
      for (const sign of signs) {
        const building = byId.get(sign.buildingId);
        expect(building).toBeDefined();
        if (!building) continue;
        expect(building.h).toBeGreaterThanOrEqual(8);
        const loc = locate(sign, building, FLAT_HEIGHT);
        expect(loc).not.toBeNull();
        if (!loc) continue;
        expect(loc.len).toBeGreaterThanOrEqual(6);
        expect(roadDist(loc.midX, loc.midZ, cell.roads)).toBeLessThanOrEqual(12 + 1e-6);
      }
    }
    const far = street(40, 18, 13);
    expect(placeSigns(far.buildings, far.roads, FLAT_HEIGHT, 'london')).toEqual([]);
    const near = street(40, 18, 5);
    expect(placeSigns(near.buildings, near.roads, FLAT_HEIGHT, 'london').length).toBeGreaterThan(0);
  });

  it('blade and panel sizes, offsets, and kind mix', () => {
    let blades = 0;
    for (const { cell, signs } of placed) {
      const byId = new Map(cell.buildings.map((b) => [b.id, b]));
      for (const sign of signs) {
        const building = byId.get(sign.buildingId);
        expect(building).toBeDefined();
        if (!building) continue;
        const loc = locate(sign, building, FLAT_HEIGHT);
        expect(loc).not.toBeNull();
        if (!loc) continue;
        const signed = (sign.x - loc.ax) * loc.nx + (sign.z - loc.az) * loc.nz;
        const bottom = sign.y - sign.height / 2 - loc.wallBase;
        if (sign.kind === 'blade') {
          blades++;
          expect(sign.width).toBeCloseTo(0.9, 5);
          expect(sign.height).toBeGreaterThanOrEqual(3);
          expect(sign.height).toBeLessThanOrEqual(6);
          expect(bottom).toBeGreaterThanOrEqual(3.5 - 1e-6);
          expect(bottom).toBeLessThanOrEqual(5 + 1e-6);
          expect(Math.abs(signed - 0.6)).toBeLessThanOrEqual(0.01);
          expect(loc.t).toBeGreaterThanOrEqual(0.25 - 1e-6);
          expect(loc.t).toBeLessThanOrEqual(0.75 + 1e-6);
        } else {
          expect(sign.width).toBeGreaterThanOrEqual(3);
          expect(sign.width).toBeLessThanOrEqual(7);
          expect(sign.height).toBeGreaterThanOrEqual(1);
          expect(sign.height).toBeLessThanOrEqual(1.6);
          expect(bottom).toBeGreaterThanOrEqual(4 - 1e-6);
          expect(bottom).toBeLessThanOrEqual(8 + 1e-6);
          expect(Math.abs(signed - 0.15)).toBeLessThanOrEqual(1e-4);
        }
      }
    }
    const share = blades / londonSigns.length;
    expect(share).toBeGreaterThanOrEqual(0.5);
    expect(share).toBeLessThanOrEqual(0.7);

    const slope = street(80, 24, 5);
    const heightAt: HeightFn = (_x, z) => 2 + z * 0.05;
    const sloped = placeSigns(slope.buildings, slope.roads, heightAt, 'london');
    expect(sloped.length).toBeGreaterThan(0);
    const byId = new Map(slope.buildings.map((b) => [b.id, b]));
    for (const sign of sloped) {
      const building = byId.get(sign.buildingId);
      expect(building).toBeDefined();
      if (!building) continue;
      const loc = locate(sign, building, heightAt);
      expect(loc).not.toBeNull();
      if (!loc) continue;
      const bottom = sign.y - sign.height / 2 - loc.wallBase;
      if (sign.kind === 'blade') {
        expect(bottom).toBeGreaterThanOrEqual(3.5 - 1e-6);
        expect(bottom).toBeLessThanOrEqual(5 + 1e-6);
      } else {
        expect(bottom).toBeGreaterThanOrEqual(4 - 1e-6);
        expect(bottom).toBeLessThanOrEqual(8 + 1e-6);
      }
    }
  });

  it('words follow the city list and colours are from NEON_COLORS', () => {
    for (const sign of londonSigns) {
      expect(ENGLISH.has(sign.word)).toBe(true);
      expect(COLORS.has(sign.text)).toBe(true);
      expect(COLORS.has(sign.border)).toBe(true);
    }
    const kyiv = street(200, 16, 5);
    const kyivSigns = placeSigns(kyiv.buildings, kyiv.roads, FLAT_HEIGHT, 'kyiv');
    const tokyo = street(200, 16, 5);
    const tokyoSigns = placeSigns(tokyo.buildings, tokyo.roads, FLAT_HEIGHT, 'tokyo');
    expect(kyivSigns.length).toBeGreaterThan(0);
    expect(tokyoSigns.length).toBeGreaterThan(0);
    const kyivWords = new Set(WORDS.kyiv);
    const tokyoWords = new Set(WORDS.tokyo);
    for (const sign of kyivSigns) {
      expect(kyivWords.has(sign.word)).toBe(true);
      expect(COLORS.has(sign.text)).toBe(true);
    }
    for (const sign of tokyoSigns) {
      expect(tokyoWords.has(sign.word)).toBe(true);
      expect(COLORS.has(sign.text)).toBe(true);
    }
    for (const cityId of ['sf', 'nyc', 'sydney', 'synthetic', 'atlantis']) {
      const block = street(80, 18, 5);
      const signs = placeSigns(block.buildings, block.roads, FLAT_HEIGHT, cityId);
      expect(signs.length).toBeGreaterThan(0);
      for (const sign of signs) expect(ENGLISH.has(sign.word)).toBe(true);
    }
  });

  it('flicker share is about 8%', () => {
    const share = londonSigns.filter((s) => s.flicker).length / londonSigns.length;
    expect(share).toBeGreaterThanOrEqual(0.04);
    expect(share).toBeLessThanOrEqual(0.12);
  });

  it('signs face outward from their building', () => {
    for (const { cell, signs } of placed) {
      const byId = new Map(cell.buildings.map((b) => [b.id, b]));
      for (const sign of signs) {
        const building = byId.get(sign.buildingId);
        expect(building).toBeDefined();
        if (!building) continue;
        const loc = locate(sign, building, FLAT_HEIGHT);
        expect(loc).not.toBeNull();
        if (!loc) continue;
        const outward = (sign.x - loc.midX) * loc.nx + (sign.z - loc.midZ) * loc.nz;
        expect(outward).toBeGreaterThan(0);
        expect(Math.hypot(sign.nx, sign.nz)).toBeCloseTo(1, 5);
      }
    }
  });

  it('placement is deterministic', () => {
    for (const { cell, signs } of placed) {
      expect(placeSigns(cell.buildings, cell.roads, FLAT_HEIGHT, 'london')).toEqual(signs);
    }
    const block = street(200, 22, 5);
    const a = placeSigns(block.buildings, block.roads, FLAT_HEIGHT, 'kyiv');
    expect(placeSigns(block.buildings, block.roads, FLAT_HEIGHT, 'kyiv')).toEqual(a);
    expect(a.length).toBeGreaterThan(0);
    expect(placeSigns(block.buildings, block.roads, FLAT_HEIGHT, 'tokyo')).not.toEqual(a);
  });
});

/** Hand-made 3-tier building (T-0165) at (ox, oz): podium 20 m, C-shaped tower 60 m, penthouse 66 m in the notch. */
function tieredBuilding(id: number, ox: number, oz: number): Building {
  const at = (ring: [number, number][]): [number, number][] => ring.map(([x, z]) => [x + ox, z + oz]);
  return {
    id,
    h: 66,
    poly: at([
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
    ]),
    tiers: [
      { h: 20, poly: at([[0, 0], [20, 0], [20, 30], [0, 30]]) },
      { h: 60, poly: at([[20, 0], [40, 0], [40, 10], [30, 10], [30, 20], [40, 20], [40, 30], [20, 30]]) },
      { h: 66, poly: at([[30, 10], [40, 10], [40, 20], [30, 20]]) },
    ],
  };
}

describe('tiers (wave 22, architecture §4.2 "Tiers")', () => {
  it("5. neon: every sign's wall segment is exterior and the sign lies within the segment's height span", () => {
    const buildings: Building[] = [];
    const roads: Road[] = [];
    for (let i = 0; i < 300; i++) {
      const ox = (i % 20) * 60;
      const oz = Math.floor(i / 20) * 50;
      buildings.push(tieredBuilding(i + 1, ox, oz));
      roads.push({ id: i + 1, cls: 'residential', pts: [[ox - 4, oz - 4], [ox + 44, oz - 4], [ox + 44, oz + 34], [ox - 4, oz + 34], [ox - 4, oz - 4]] });
    }
    const heightAt: HeightFn = (x, z) => 0.01 * x + 0.02 * z;
    const signs = placeSigns(buildings, roads, heightAt, 'tokyo');
    expect(signs.length).toBeGreaterThan(20);
    const byId = new Map(buildings.map((b) => [b.id, b]));
    let tall = 0;
    for (const sign of signs) {
      const b = byId.get(sign.buildingId)!;
      const off = sign.kind === 'blade' ? 0.6 : 0.15;
      const wx = sign.x - sign.nx * off;
      const wz = sign.z - sign.nz * off;
      const seg = exteriorWalls(b, heightAt).find((w) => {
        if (w.nx * sign.nx + w.nz * sign.nz < 0.999) return false;
        const dx = w.b[0] - w.a[0];
        const dz = w.b[1] - w.a[1];
        const len = Math.hypot(dx, dz);
        const t = ((wx - w.a[0]) * dx + (wz - w.a[1]) * dz) / (len * len);
        const perp = Math.abs((wx - w.a[0]) * w.nx + (wz - w.a[1]) * w.nz);
        return t >= 0 && t <= 1 && perp < 1e-6;
      });
      expect(seg, `sign of building ${b.id} at (${wx}, ${wz})`).toBeDefined();
      expect(sign.y - sign.height / 2).toBeGreaterThanOrEqual(seg!.base - 1e-6);
      expect(sign.y + sign.height / 2).toBeLessThanOrEqual(seg!.top + 1e-6);
      if (seg!.base > 1) tall++;
    }
    // Upper-tier walls (base above the ground) carry their own signs.
    expect(tall).toBeGreaterThan(0);
  });

  // The pre-wave-22 hash was 11643bbf…; neon v2 (T-0168) re-rolls the default profile (p 0.24, cap 2, colour pair keyed by kind|word).
  it('6. byte-identical output for buildings without tiers (v2 default-profile sha256, london tile 0_0 on a slope)', () => {
    const signs = placeSigns(tile.buildings, tile.roads, (x, z) => 0.01 * x + 0.02 * z, 'london');
    expect(createHash('sha256').update(JSON.stringify(signs)).digest('hex')).toBe(
      '9fd8f94377698afdefc2b0bb07dc7f3593e3f87318693a0782fb12e2a4b8263e',
    );
  });
});

// ---------------------------------------------------------------------------
// Neon v2 (wave 23b, T-0168, architecture §4.11 "Neon v2 — dense city profiles").

/** London tile 0_0 sign count of the v1 rule (p 0.12, cap 1 / 2 if h ≥ 20), measured at 4e815d0. */
const V1_LONDON_0_0 = 204;

const tokyoPath = join(dirname(fileURLToPath(import.meta.url)), '../public/data/tokyo/tiles/-6_-1.json');
const tokyoTile = JSON.parse(readFileSync(tokyoPath, 'utf8')) as { buildings: Building[]; roads: Road[] };
const tokyoCells = [...bucketSources(new Map<string, PunkSource>([['-6_-1', { buildings: tokyoTile.buildings, roads: tokyoTile.roads }]])).values()];
const tokyoT0 = performance.now();
const tokyoPlaced = tokyoCells.map((cell) => ({ cell, signs: placeSigns(cell.buildings, cell.roads, FLAT_HEIGHT, 'tokyo') }));
const tokyoMs = performance.now() - tokyoT0;
const tokyoSigns = tokyoPlaced.flatMap((p) => p.signs);
const tokyoById = new Map<number, Building>();
for (const cell of tokyoCells) for (const b of cell.buildings) tokyoById.set(b.id, b);
const shinjuku = tokyoPlaced.find((p) => p.cell.key === '-24_-4');

function wallBaseOf(b: Building): number {
  return ringHeights(normalizeRing(b.poly), FLAT_HEIGHT).base + (b.minH ?? 0);
}

const fakeUv = (kind: string): { u0: number; v0: number; u1: number; v1: number; rot: boolean } =>
  neonSlotUv(0, kind === 'blade');

describe('neon v2 (wave 23b, §4.11 "Neon v2")', () => {
  it('1. tokyo Shinjuku cell (−24, −4): 100–600 signs; every cell of tile −6_−1 ≤ 800', () => {
    expect(shinjuku).toBeDefined();
    const n = shinjuku?.signs.length ?? 0;
    console.log(`[neon v2] tokyo Shinjuku cell -24_-4: ${n} signs; tile -6_-1: ${tokyoSigns.length} signs`);
    expect(n).toBeGreaterThanOrEqual(100);
    expect(n).toBeLessThanOrEqual(600);
    for (const { signs } of tokyoPlaced) expect(signs.length).toBeLessThanOrEqual(800);
  });

  it('2. per-building cap, 1.2 m spacing on one wall, storey-slot bottoms ≤ min(h − 2, 30); eye-level bias', () => {
    const byBuilding = new Map<number, Sign[]>();
    for (const sign of tokyoSigns) {
      const list = byBuilding.get(sign.buildingId) ?? [];
      list.push(sign);
      byBuilding.set(sign.buildingId, list);
    }
    for (const [id, list] of byBuilding) {
      const b = tokyoById.get(id)!;
      expect(list.length).toBeLessThanOrEqual(Math.min(8, 2 + Math.floor(b.h / 15)));
      const base = wallBaseOf(b);
      const feet = list.map((sign) => {
        const off = sign.kind === 'blade' ? 0.6 : 0.15;
        const wx = sign.x - sign.nx * off;
        const wz = sign.z - sign.nz * off;
        const along = wx * -sign.nz + wz * sign.nx;
        const w = sign.kind === 'blade' ? 0.3 : sign.width;
        const bottom = sign.y - sign.height / 2;
        const rel = bottom - base;
        const k = rel / 3.5;
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
        expect(Math.round(k)).toBeGreaterThanOrEqual(1);
        expect(rel).toBeLessThanOrEqual(Math.min(b.h - 2, 30) + 1e-6);
        if (sign.kind === 'blade') {
          expect(rel).toBeGreaterThanOrEqual(3 - 1e-6);
          expect(rel).toBeLessThanOrEqual(7 + 1e-6);
        }
        return { sign, line: wx * sign.nx + wz * sign.nz, a0: along - w / 2, a1: along + w / 2, y0: bottom, y1: bottom + sign.height };
      });
      for (let i = 0; i < feet.length; i++) {
        for (let j = i + 1; j < feet.length; j++) {
          const f = feet[i]!;
          const g = feet[j]!;
          const sameWall = f.sign.nx * g.sign.nx + f.sign.nz * g.sign.nz > 0.999 && Math.abs(f.line - g.line) < 0.05;
          if (!sameWall) continue;
          const gapA = Math.max(g.a0 - f.a1, f.a0 - g.a1);
          const gapY = Math.max(g.y0 - f.y1, f.y0 - g.y1);
          expect(Math.max(gapA, gapY), `building ${id}`).toBeGreaterThanOrEqual(1.2 - 1e-6);
        }
      }
    }
    // PM rework: ≥ 70 % of the bottoms at eye level (≤ 12 m above the wall base).
    const low = tokyoSigns.filter((s) => s.y - s.height / 2 - wallBaseOf(tokyoById.get(s.buildingId)!) <= 12 + 1e-6).length;
    const lowShare = low / tokyoSigns.length;
    // Shinjuku spawn: signs with bottom ≤ 8 m within 60 m (in frame from the street).
    const spawn = tokyoSigns.filter((s) => s.y - s.height / 2 <= 8 + 1e-6 && Math.hypot(s.x + 5908.3, s.z + 943.9) <= 60).length;
    console.log(`[neon v2] tokyo -6_-1 bottoms ≤ 12 m: ${(lowShare * 100).toFixed(1)} %; Shinjuku spawn low signs within 60 m: ${spawn}`);
    expect(lowShare).toBeGreaterThanOrEqual(0.7);
    expect(spawn).toBeGreaterThanOrEqual(25);
  });

  it('3. tokyo kind shares 45 / 25 / 22 / 8 (±6 %); screens h ≥ 30, bottom ≥ 10; stacks 2–4 panels', () => {
    const count = (k: Sign['kind']): number => tokyoSigns.filter((s) => s.kind === k).length / tokyoSigns.length;
    const shares = { blade: count('blade'), stack: count('stack'), panel: count('panel'), screen: count('screen') };
    console.log(`[neon v2] tokyo -6_-1 kind shares ${JSON.stringify(shares)}`);
    expect(Math.abs(shares.blade - 0.45)).toBeLessThanOrEqual(0.06);
    expect(Math.abs(shares.stack - 0.25)).toBeLessThanOrEqual(0.06);
    expect(Math.abs(shares.panel - 0.22)).toBeLessThanOrEqual(0.06);
    expect(Math.abs(shares.screen - 0.08)).toBeLessThanOrEqual(0.06);
    for (const sign of tokyoSigns) {
      const b = tokyoById.get(sign.buildingId)!;
      if (sign.kind === 'screen') {
        expect(b.h).toBeGreaterThanOrEqual(30);
        expect(sign.y - sign.height / 2 - wallBaseOf(b)).toBeGreaterThanOrEqual(10);
        expect(sign.width).toBeGreaterThanOrEqual(6 - 1e-9);
        expect(sign.width).toBeLessThanOrEqual(12);
        expect(sign.height).toBeGreaterThanOrEqual(4);
        expect(sign.height).toBeLessThanOrEqual(8);
      } else if (sign.kind === 'stack') {
        const n = sign.panels?.length ?? 0;
        expect(n).toBeGreaterThanOrEqual(2);
        expect(n).toBeLessThanOrEqual(4);
        expect(sign.width).toBeCloseTo(1.6, 6);
        expect(sign.height).toBeCloseTo(n * 0.9 + (n - 1) * 0.1, 6);
      } else if (sign.kind === 'blade') {
        expect(sign.width).toBeGreaterThanOrEqual(0.8);
        expect(sign.width).toBeLessThanOrEqual(1.2);
        expect(sign.height).toBeGreaterThanOrEqual(3);
        expect(sign.height).toBeLessThanOrEqual(7);
      } else {
        expect(sign.width).toBeGreaterThanOrEqual(3 - 1e-9);
        expect(sign.width).toBeLessThanOrEqual(7);
        expect(sign.height).toBeGreaterThanOrEqual(1);
        expect(sign.height).toBeLessThanOrEqual(1.6);
      }
      if (sign.kind !== 'stack') expect(sign.panels).toBeUndefined();
    }
  });

  it('4. default profile: london tile 0_0 ≈ 2× v1, cap 2; minas-tirith: 0', () => {
    console.log(`[neon v2] london 0_0: v1 ${V1_LONDON_0_0} signs, v2 ${londonSigns.length} signs`);
    const ratio = londonSigns.length / V1_LONDON_0_0;
    expect(ratio).toBeGreaterThanOrEqual(1.7);
    expect(ratio).toBeLessThanOrEqual(2.3);
    const counts = new Map<number, number>();
    for (const sign of londonSigns) counts.set(sign.buildingId, (counts.get(sign.buildingId) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBe(2);
    for (const sign of londonSigns) expect(sign.kind === 'blade' || sign.kind === 'panel').toBe(true);
    const block = street(200, 40, 5);
    expect(placeSigns(block.buildings, block.roads, FLAT_HEIGHT, 'minas-tirith')).toEqual([]);
  });

  it('5. tokyo words ≥ 40 distinct from the tokyo list; text ≠ border colour; warm white only as a border (≤ 15 %)', () => {
    const list = new Set(WORDS.tokyo);
    const used = new Set<string>();
    let borders = 0;
    let warm = 0;
    const check = (word: string, text: string, border: string): void => {
      expect(list.has(word)).toBe(true);
      expect(COLORS.has(text)).toBe(true);
      expect(text).not.toBe('#fff1c1');
      borders++;
      if (border === '#fff1c1') warm++;
      expect(COLORS.has(border)).toBe(true);
      expect(text).not.toBe(border);
      used.add(word);
    };
    for (const sign of tokyoSigns) {
      check(sign.word, sign.text, sign.border);
      for (const p of sign.panels ?? []) check(p.word, p.text, p.border);
    }
    for (const sign of londonSigns) {
      expect(sign.text).not.toBe(sign.border);
      expect(sign.text).not.toBe('#fff1c1');
    }
    console.log(`[neon v2] tokyo -6_-1 distinct words: ${used.size} of ${list.size}; warm-white borders ${((warm / borders) * 100).toFixed(1)} %`);
    expect(warm / borders).toBeLessThanOrEqual(0.15);
    expect(NEON_TEXT_COLORS).not.toContain(NEON_WARM_WHITE);
    expect(NEON_TEXT_COLORS).toContain('#ffcc33');
    expect(used.size).toBeGreaterThanOrEqual(40);
    expect(NEON_COLORS).toContain('#fff1c1');
    expect(NEON_COLORS).toContain('#ffcc33');
  });

  it('6. atlas key space: 128 slots, deterministic slot for a key', () => {
    expect(NEON_ATLAS_SLOTS).toBe(128);
    const keys = tokyoSigns.flatMap((s) =>
      s.kind === 'stack' ? (s.panels ?? []).map((p) => neonAtlasKey('stack', p.word)) : [neonAtlasKey(s.kind, s.word)],
    );
    const a = new NeonSlotTable();
    const b = new NeonSlotTable();
    const distinct: string[] = [];
    const seen = new Set<string>();
    const owner = new Map<number, string>();
    for (const key of keys) {
      const ra = a.slotFor(key);
      const rb = b.slotFor(key);
      expect(rb).toEqual(ra);
      expect(ra.slot).toBeGreaterThanOrEqual(0);
      expect(ra.slot).toBeLessThan(128);
      if (!seen.has(key)) {
        seen.add(key);
        distinct.push(key);
        if (distinct.length <= 128) {
          expect(ra).toEqual({ slot: distinct.length - 1, fresh: true });
          owner.set(ra.slot, key);
        } else {
          // Overflow shares a drawn slot of the same kind, and of the same colours when one exists.
          expect(ra.fresh).toBe(false);
          const mine = parseNeonAtlasKey(key);
          const theirs = parseNeonAtlasKey(owner.get(ra.slot)!);
          expect(theirs.kind).toBe(mine.kind);
          const sameLook = [...owner.values()].some((k) => {
            const o = parseNeonAtlasKey(k);
            return o.kind === mine.kind && o.text === mine.text && o.border === mine.border;
          });
          if (sameLook) expect([theirs.text, theirs.border]).toEqual([mine.text, mine.border]);
          expect(a.lookOf(ra.slot)).toEqual({ text: theirs.text, border: theirs.border });
        }
      } else {
        expect(ra.fresh).toBe(false);
      }
    }
    expect(distinct.length).toBeGreaterThan(128);
    expect(a.drawn).toBe(128);
    for (const key of distinct) expect(a.slotFor(key).slot).toBe(b.slotFor(key).slot);
    // 128 disjoint 256 × 128 px rectangles tiling the 2048² atlas.
    const rects = new Set<string>();
    for (let i = 0; i < 128; i++) {
      const uv = neonSlotUv(i, false);
      expect(uv.u1 - uv.u0).toBeCloseTo(1 / 8, 9);
      expect(uv.v1 - uv.v0).toBeCloseTo(1 / 16, 9);
      expect(uv.u0).toBeGreaterThanOrEqual(0);
      expect(uv.v0).toBeGreaterThanOrEqual(-1e-9);
      expect(uv.u1).toBeLessThanOrEqual(1);
      expect(uv.v1).toBeLessThanOrEqual(1);
      rects.add(`${uv.u0.toFixed(4)}:${uv.v0.toFixed(4)}`);
    }
    expect(rects.size).toBe(128);
  });

  it('colour pair is a function of the atlas key', () => {
    const pair = new Map<string, string>();
    for (const sign of [...tokyoSigns, ...londonSigns]) {
      const faces = sign.kind === 'stack' ? (sign.panels ?? []).map((p) => ({ kind: 'stack' as const, ...p })) : [sign];
      for (const f of faces) {
        const key = neonAtlasKey(f.kind, f.word);
        const look = `${f.text}/${f.border}`;
        expect(pair.get(key) ?? look, key).toBe(look);
        pair.set(key, look);
        expect(neonColours(f.kind, f.word)).toEqual({ text: f.text, border: f.border });
        expect(parseNeonAtlasKey(key)).toEqual({ kind: f.kind, word: f.word, text: f.text, border: f.border });
      }
      if (sign.kind === 'stack') expect([sign.text, sign.border]).toEqual([sign.panels?.[0]?.text, sign.panels?.[0]?.border]);
    }
    expect(pair.size).toBeGreaterThan(100);
  });

  it('7. geometry budget: ≤ 60 k triangles and 3 meshes per cell; tile placement ≤ 250 ms', () => {
    console.log(`[neon v2] tokyo -6_-1 placement: ${tokyoMs.toFixed(1)} ms`);
    expect(tokyoMs).toBeLessThanOrEqual(250);
    for (const { cell, signs } of tokyoPlaced) {
      if (signs.length === 0) continue;
      const m = buildNeonMeshes(signs, fakeUv);
      expect(Object.keys(m).sort()).toEqual(['faces', 'frames', 'glow']);
      const tris = (m.faces.index.length + m.frames.index.length + m.glow.index.length) / 3;
      if (cell.key === '-24_-4') console.log(`[neon v2] Shinjuku cell triangles: ${tris}`);
      expect(tris, cell.key).toBeLessThanOrEqual(60_000);
      // One glow card (2 triangles) per sign; faces carry uv + flicker + gain, glow uv + colour.
      expect(m.glow.index.length).toBe(signs.length * 6);
      expect(m.faces.gain.length).toBe(m.faces.position.length / 3);
      expect(m.glow.color.length).toBe(m.glow.position.length);
      for (const g of m.faces.gain) expect(g === 7 || g === 3).toBe(true);
    }
  });

  it('8. determinism: same input → same signs and meshes', () => {
    for (const { cell, signs } of tokyoPlaced) {
      const again = placeSigns(cell.buildings, cell.roads, FLAT_HEIGHT, 'tokyo');
      expect(again).toEqual(signs);
      if (signs.length > 0) expect(buildNeonMeshes(again, fakeUv)).toEqual(buildNeonMeshes(signs, fakeUv));
    }
  });
});
