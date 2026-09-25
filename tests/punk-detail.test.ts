/**
 * Cyberpunk facade-detail geometry (T-0154, src/render/punk/detailmesh.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLAT_HEIGHT, type Building, type TileData, type Vec2 } from '../src/data/types';
import { bucketSources } from '../src/render/punk/cells';
import type { PunkSource } from '../src/render/punk/layer';
import { buildDetailMesh } from '../src/render/punk/detailmesh';
import { pointInPolygon } from '../src/world/collision';
import { exteriorWalls, normalizeRing, ringHeights } from '../src/world/buildings';
import { createHash } from 'node:crypto';
import type { MeshData } from '../src/world/mesh';

const TILE = JSON.parse(
  readFileSync(resolve(__dirname, '../public/data/london/tiles/0_0.json'), 'utf8'),
) as TileData;

function boxBuilding(id: number, w: number, d: number, h: number, minH?: number): Building {
  const b: Building = {
    id,
    h,
    poly: [
      [0, 0],
      [w, 0],
      [w, d],
      [0, d],
    ],
  };
  if (minH !== undefined) b.minH = minH;
  return b;
}

function wallBaseOf(b: Building, heightAt = FLAT_HEIGHT): { wallBase: number; roofY: number; ring: Vec2[] } {
  const ring = normalizeRing(b.poly);
  const rh = ringHeights(ring, heightAt);
  return { ring, wallBase: rh.base + (b.minH ?? 0), roofY: rh.top + b.h };
}

function eachVert(m: MeshData, fn: (x: number, y: number, z: number) => void): void {
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) fn(p[i]!, p[i + 1]!, p[i + 2]!);
}

describe('buildDetailMesh', () => {
  it('budget: over the cells of london tile 0_0, mean triangles per cell ≤ 60 000 and max ≤ 150 000', () => {
    const sources = new Map<string, PunkSource>([['0_0', { buildings: TILE.buildings, roads: TILE.roads }]]);
    const cells = bucketSources(sources);
    const counts: number[] = [];
    for (const cell of cells.values()) {
      const mesh = buildDetailMesh(cell.buildings, FLAT_HEIGHT);
      // Real triangles: non-indexed soup is 9 floats per triangle.
      counts.push(mesh.positions.length / 9);
    }
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const max = Math.max(...counts);
    // Printed for the worker report (mean and max, real triangles).
    console.log(`T-0154 budget: cells=${counts.length} mean=${mean.toFixed(1)} max=${max.toFixed(1)}`);
    expect(mean).toBeLessThanOrEqual(60_000);
    expect(max).toBeLessThanOrEqual(150_000);
  });

  it('build time for the whole tile ≤ 800 ms (≈ 250 ms solo; bound leaves room for a loaded host)', () => {
    const t0 = performance.now();
    const mesh = buildDetailMesh(TILE.buildings, FLAT_HEIGHT);
    const ms = performance.now() - t0;
    console.log(`T-0154 build: ${ms.toFixed(1)} ms, triangles=${mesh.positions.length / 9}`);
    expect(ms).toBeLessThanOrEqual(800);
  });

  it('a single 20 × 10 m, 30 m tall box building yields ledges at 12 m and 24 m heights (none for h < 15), ≥ 1 pipe per edge ≥ 10 m, and every vertex lies within the footprint\'s bounding box expanded by 1.5 m', () => {
    const b = boxBuilding(7, 20, 10, 30);
    const mesh = buildDetailMesh([b], FLAT_HEIGHT);
    const { wallBase, roofY } = wallBaseOf(b);
    expect(mesh.positions.length).toBeGreaterThan(0);

    let n12 = 0;
    let n24 = 0;
    eachVert(mesh, (_x, y, _z) => {
      if (Math.abs(y - (wallBase + 12)) <= 0.13) n12++;
      if (Math.abs(y - (wallBase + 24)) <= 0.13) n24++;
    });
    expect(n12).toBeGreaterThan(0);
    expect(n24).toBeGreaterThan(0);

    const short = buildDetailMesh([boxBuilding(8, 20, 10, 10)], FLAT_HEIGHT);
    let near12 = 0;
    let near24 = 0;
    eachVert(short, (_x, y, _z) => {
      if (Math.abs(y - 12) <= 0.13) near12++;
      if (Math.abs(y - 24) <= 0.13) near24++;
    });
    expect(near12).toBe(0);
    expect(near24).toBe(0);

    const edges: [Vec2, Vec2][] = [
      [
        [0, 0],
        [20, 0],
      ],
      [
        [20, 0],
        [20, 10],
      ],
      [
        [20, 10],
        [0, 10],
      ],
      [
        [0, 10],
        [0, 0],
      ],
    ];
    const distSeg = (x: number, z: number, a: Vec2, b: Vec2): number => {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len2 = dx * dx + dz * dz;
      let t = 0;
      if (len2 > 0) t = Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / len2));
      return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
    };
    for (const [a, c] of edges) {
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 10) continue;
      let bot = 0;
      let top = 0;
      eachVert(mesh, (x, y, z) => {
        if (distSeg(x, z, a, c) > 0.25) return;
        if (Math.abs(y - wallBase) < 0.02) bot++;
        if (Math.abs(y - roofY) < 0.02) top++;
      });
      expect(bot, `pipe bottom on edge ${a}→${c}`).toBeGreaterThan(0);
      expect(top, `pipe top on edge ${a}→${c}`).toBeGreaterThan(0);
    }

    eachVert(mesh, (x, _y, z) => {
      expect(x).toBeGreaterThanOrEqual(-1.5);
      expect(x).toBeLessThanOrEqual(20 + 1.5);
      expect(z).toBeGreaterThanOrEqual(-1.5);
      expect(z).toBeLessThanOrEqual(10 + 1.5);
    });
  });

  it('buildings with h < 6 m or no edge ≥ 4 m produce zero triangles', () => {
    const short = buildDetailMesh([boxBuilding(1, 20, 10, 5)], FLAT_HEIGHT);
    expect(short.positions.length).toBe(0);
    const skinny: Building = {
      id: 2,
      h: 30,
      poly: [
        [0, 0],
        [3.5, 0],
        [3.5, 3.5],
        [0, 3.5],
      ],
    };
    const none = buildDetailMesh([skinny], FLAT_HEIGHT);
    expect(none.positions.length).toBe(0);
  });

  it('rooftop items lie inside the footprint (point-in-polygon of their base corners) and sit at y ≥ roof', () => {
    const b = boxBuilding(11, 20, 10, 30);
    const mesh = buildDetailMesh([b], FLAT_HEIGHT);
    const { ring, roofY } = wallBaseOf(b);
    let above = 0;
    let baseCorners = 0;
    eachVert(mesh, (x, y, z) => {
      if (y > roofY + 0.05) {
        above++;
        expect(y).toBeGreaterThanOrEqual(roofY);
        expect(pointInPolygon([x, z], ring)).toBe(true);
      }
      if (Math.abs(y - roofY) <= 1e-3 && pointInPolygon([x, z], ring)) {
        baseCorners++;
        expect(y).toBeGreaterThanOrEqual(roofY - 1e-4);
      }
    });
    expect(above).toBeGreaterThan(0);
    expect(baseCorners).toBeGreaterThan(0);
  });

  it('seating on a slope: with heightAt = (x) => x * 0.1, the lowest detail vertex of a building is ≥ that building\'s wall base − 0.01', () => {
    const heightAt = (x: number): number => x * 0.1;
    const b = boxBuilding(3, 20, 10, 30);
    const { wallBase } = wallBaseOf(b, heightAt);
    const mesh = buildDetailMesh([b], heightAt);
    expect(mesh.positions.length).toBeGreaterThan(0);
    let minY = Infinity;
    eachVert(mesh, (_x, y) => {
      if (y < minY) minY = y;
    });
    expect(minY).toBeGreaterThanOrEqual(wallBase - 0.01);
  });

  it('determinism: two builds of the same input are byte-identical', () => {
    const b = boxBuilding(99, 20, 10, 30);
    const a = buildDetailMesh([b], FLAT_HEIGHT);
    const c = buildDetailMesh([b], FLAT_HEIGHT);
    expect(a.positions).toEqual(c.positions);
  });
});

/** Hand-made 3-tier building (T-0165): podium 20 m (west), C-shaped tower 60 m, penthouse 66 m in the notch. */
function tieredBuilding(id: number): Building {
  return {
    id,
    h: 66,
    poly: [
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
    ],
    tiers: [
      { h: 20, poly: [[0, 0], [20, 0], [20, 30], [0, 30]] },
      { h: 60, poly: [[20, 0], [40, 0], [40, 10], [30, 10], [30, 20], [40, 20], [40, 30], [20, 30]] },
      { h: 66, poly: [[30, 10], [40, 10], [40, 20], [30, 20]] },
    ],
  };
}

/** Axis-aligned bounds of each 36-vertex box chunk until the first vertex above `stopY` (rooftop items follow the walls). */
function wallBoxes(m: MeshData, stopY: number): { c: [number, number, number]; size: [number, number, number] }[] {
  const out: { c: [number, number, number]; size: [number, number, number] }[] = [];
  const p = m.positions;
  for (let v = 0; v + 36 <= p.length / 3; v += 36) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 36; k++) {
      for (let d = 0; d < 3; d++) {
        const x = p[(v + k) * 3 + d]!;
        lo[d] = Math.min(lo[d]!, x);
        hi[d] = Math.max(hi[d]!, x);
      }
    }
    if (hi[1]! > stopY + 1e-6) break;
    out.push({
      c: [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2],
      size: [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!],
    });
  }
  return out;
}

describe('tiers (wave 22, architecture §4.2 "Tiers")', () => {
  it('4. detail: no AC unit / balcony centre lies inside another tier\'s plan below that tier\'s top; rooftop clutter only on the top tier', () => {
    let acs = 0;
    let balconies = 0;
    let upper = 0;
    let roofItems = 0;
    for (let id = 1; id <= 40; id++) {
      const b = tieredBuilding(id);
      const plans = b.tiers!.map((t) => ({ ring: normalizeRing(t.poly), top: t.h }));
      const m = buildDetailMesh([b], FLAT_HEIGHT);
      const boxes = wallBoxes(m, 66);
      for (const { c, size } of boxes) {
        const horiz = [size[0], size[2]].sort((x, y) => x - y);
        const isAc = Math.abs(size[1] - 0.6) < 1e-3 && Math.abs(horiz[0]! - 0.5) < 1e-3 && Math.abs(horiz[1]! - 0.9) < 1e-3;
        const isBalc = Math.abs(size[1] - 0.15) < 1e-3 && Math.abs(horiz[0]! - 1.1) < 1e-3 && Math.abs(horiz[1]! - 2.4) < 1e-3;
        if (isAc) acs++;
        if (isBalc) balconies++;
        if ((isAc || isBalc) && c[1] > 20) upper++;
        // Every wall-attached item (AC, balcony, ledge, pipe) stays out of the taller tiers.
        for (const t of plans) {
          if (pointInPolygon([c[0], c[2]], t.ring)) expect(c[1]).toBeGreaterThanOrEqual(t.top - 1e-6);
        }
      }
      // Rooftop clutter: every vertex above the penthouse top lies over the penthouse plan.
      const pent = plans[2]!.ring;
      eachVert(m, (x, y, z) => {
        if (y > 66 + 1e-6) {
          roofItems++;
          expect(pointInPolygon([x, z], pent)).toBe(true);
        }
        // Nothing sits on the podium or tower roofs (interiors shrunk 1.5 m past the attached wall items).
        if (x > 1.5 && x < 18.5 && z > 1.5 && z < 28.5) expect(y).toBeLessThanOrEqual(20 + 1e-6);
        if (x > 21.5 && x < 28.5 && z > 1.5 && z < 28.5) expect(y).toBeLessThanOrEqual(60 + 1e-6);
      });
    }
    expect(acs).toBeGreaterThan(0);
    expect(balconies).toBeGreaterThan(0);
    expect(upper).toBeGreaterThan(0);
    expect(roofItems).toBeGreaterThan(0);
    // The walls used are exactly the exterior tier walls.
    expect(exteriorWalls(tieredBuilding(1), FLAT_HEIGHT)).toHaveLength(12);
  });

  it('6. byte-identical output for buildings without tiers (pre-wave-22 sha256, london tile 0_0 on a slope)', () => {
    const m = buildDetailMesh(TILE.buildings, (x, z) => 0.01 * x + 0.02 * z);
    const h = createHash('sha256');
    for (const a of [m.positions, m.normals, m.uvs, m.colors, m.extra ?? new Float32Array()]) {
      h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    }
    h.update(JSON.stringify(m.groups));
    expect(h.digest('hex')).toBe('87f32e390a32389ab17c3f245283a8332aea20296612e40832555d758e2c0c34');
  });
});
