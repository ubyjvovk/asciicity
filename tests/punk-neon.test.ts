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
import { NEON_COLORS, WORDS, placeSigns, type Sign } from '../src/render/punk/neonplace';
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
    expect(londonSigns.length).toBeGreaterThanOrEqual(80);
    expect(londonSigns.length).toBeLessThanOrEqual(300);
    const byId = new Map<number, Building>();
    for (const cell of cells) for (const b of cell.buildings) byId.set(b.id, b);
    const counts = new Map<number, number>();
    for (const sign of londonSigns) counts.set(sign.buildingId, (counts.get(sign.buildingId) ?? 0) + 1);
    for (const [id, n] of counts) {
      const h = byId.get(id)?.h ?? 0;
      expect(n).toBeLessThanOrEqual(h < 20 ? 1 : 2);
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
      expect(COLORS.has(sign.color)).toBe(true);
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
      expect(COLORS.has(sign.color)).toBe(true);
    }
    for (const sign of tokyoSigns) {
      expect(tokyoWords.has(sign.word)).toBe(true);
      expect(COLORS.has(sign.color)).toBe(true);
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

  it('6. byte-identical output for buildings without tiers (pre-wave-22 sha256, london tile 0_0 on a slope)', () => {
    const signs = placeSigns(tile.buildings, tile.roads, (x, z) => 0.01 * x + 0.02 * z, 'london');
    expect(createHash('sha256').update(JSON.stringify(signs)).digest('hex')).toBe(
      '11643bbf8c163b96028fece014bbbb5b9d6bae1895b4c97d370dfcd459996d44',
    );
  });
});
