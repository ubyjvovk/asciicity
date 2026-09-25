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
import { normalizeRing, ringHeights } from '../src/world/buildings';
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

  it('build time for the whole tile ≤ 400 ms', () => {
    const t0 = performance.now();
    const mesh = buildDetailMesh(TILE.buildings, FLAT_HEIGHT);
    const ms = performance.now() - t0;
    console.log(`T-0154 build: ${ms.toFixed(1)} ms, triangles=${mesh.positions.length / 9}`);
    expect(ms).toBeLessThanOrEqual(400);
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
