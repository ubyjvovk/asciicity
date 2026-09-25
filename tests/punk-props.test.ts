/**
 * Cyberpunk street props (wave 20b, src/render/punk/propsmesh.ts): lamp and
 * cable placement + mesh triangle budgets. Pure — no three/webgpu.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FLAT_HEIGHT, type Building, type HeightFn, type Road } from '../src/data/types';
import { ROAD_WIDTH } from '../src/world/roads';
import { bucketSources } from '../src/render/punk/cells';
import type { PunkSource } from '../src/render/punk/layer';
import {
  buildPropsMesh,
  CABLE_CLASSES,
  distToPolygon,
  LAMP_CLASSES,
  placeCables,
  placeLamps,
  pointInPolygon,
  type Lamp,
} from '../src/render/punk/propsmesh';

/** A building footprint rectangle: `[x0, z0]` inner corner, `w`/`h` out from the road side. */
const rect = (id: number, x0: number, z0: number, w: number, h: number): Building => ({
  id,
  h: 20,
  poly: [
    [x0, z0],
    [x0 + w, z0],
    [x0 + w, z0 + h],
    [x0, z0 + h],
  ],
});

/** A straight road along +x starting at the origin. */
const straight = (cls: Road['cls'], len: number, id = 1, bridge = false): Road => ({
  id,
  cls,
  bridge: bridge ? true : undefined,
  pts: [
    [0, 0],
    [len, 0],
  ],
});

describe('placeLamps', () => {
  it('straight 320 m primary road yields 10 lamps at 16…304 m, alternating sides, at ROAD_WIDTH.primary/2 + 0.8, arm toward the road', () => {
    const lamps = placeLamps([straight('primary', 320)], FLAT_HEIGHT);
    expect(lamps.length).toBe(10);
    const off = ROAD_WIDTH.primary / 2 + 0.8;
    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i];
      // candidates at 16, 48, …, 304 m
      expect(lamp.x).toBeCloseTo(16 + i * 32, 6);
      expect(Math.abs(lamp.z)).toBeCloseTo(off, 1); // ±0.05 from the centreline
      // alternating sides
      if (i > 0) expect(lamp.z).not.toBeCloseTo(0, 3);
      if (i > 0) expect(Math.sign(lamp.z)).not.toBe(Math.sign(lamps[i - 1].z));
      // arm direction points back at the road (centreline z = 0)
      expect(Math.abs(lamps[i].dirX)).toBeCloseTo(0, 1);
      expect(lamps[i].dirZ).toBeCloseTo(-Math.sign(lamp.z), 2);
      expect(Math.hypot(lamps[i].dirX, lamps[i].dirZ)).toBeCloseTo(1, 2);
    }
  });

  it('short ways (< 32 m, ≥ 8 m) get one lamp each at the midpoint; < 8 m get none', () => {
    // a 20 m primary way (< 32, ≥ 8) → one lamp at its midpoint, left side
    const one = placeLamps([straight('primary', 20)], FLAT_HEIGHT);
    expect(one).toHaveLength(1);
    expect(one[0].x).toBeCloseTo(10, 6);
    expect(one[0].z).toBeCloseTo(ROAD_WIDTH.primary / 2 + 0.8, 1); // left
    expect(one[0].dirZ).toBeCloseTo(-1, 1); // arm points back at the road
    // a 8 m way → one lamp; a 7 m way (< 8) → none
    expect(placeLamps([straight('primary', 8)], FLAT_HEIGHT)).toHaveLength(1);
    expect(placeLamps([straight('primary', 7)], FLAT_HEIGHT)).toHaveLength(0);
  });

  it('chained short ways along a straight line give lamps ~every 32 m with no two within 12 m', () => {
    // five 31 m ways chained end-to-end → midpoints 15.5, 46.5, 77.5, 108.5, 139.5
    const ways: Road[] = [];
    for (let w = 0; w < 5; w++) {
      ways.push({ id: w + 1, cls: 'primary', pts: [[w * 31, 0], [w * 31 + 31, 0]] });
    }
    const lamps = placeLamps(ways, FLAT_HEIGHT);
    expect(lamps).toHaveLength(5);
    for (let i = 1; i < lamps.length; i++) {
      const gap = lamps[i].x - lamps[i - 1].x;
      expect(gap).toBeGreaterThanOrEqual(12); // no two within 12 m
      expect(gap).toBeCloseTo(31, 0); // ~every 32 m
    }
  });

  it('footway / service roads get no lamps; residential gets lamps', () => {
    for (const cls of ['footway', 'service'] as const) {
      expect(placeLamps([straight(cls, 100)], FLAT_HEIGHT)).toHaveLength(0);
    }
    const lamps = placeLamps([straight('residential', 100)], FLAT_HEIGHT);
    expect(lamps.length).toBeGreaterThan(0);
    expect(Math.abs(lamps[0].z)).toBeCloseTo(ROAD_WIDTH.residential / 2 + 0.8, 1);
  });

  it('only the documented road classes get lamps', () => {
    expect(LAMP_CLASSES).toEqual(new Set(['primary', 'secondary', 'tertiary', 'residential', 'pedestrian']));
  });

  it('lamps are seated on a sloped heightAt: y = heightAt(x, z)', () => {
    const heightAt: HeightFn = (x, z) => 10 + x * 0.05 + z * 0.02;
    const lamps = placeLamps([straight('primary', 320)], heightAt);
    expect(lamps.length).toBeGreaterThan(0);
    for (const lamp of lamps) {
      expect(lamp.y).toBeCloseTo(heightAt(lamp.x, lamp.z), 2); // ±0.01
    }
  });

  it('deterministic: same input yields identical arrays', () => {
    const roads = [straight('primary', 320), straight('residential', 100, 2)];
    const a = placeLamps(roads, FLAT_HEIGHT);
    const b = placeLamps(roads, FLAT_HEIGHT);
    expect(a).toEqual(b);
  });
});

describe('placeCables', () => {
  it('cables only on residential / service / pedestrian roads, every 25 m', () => {
    expect(CABLE_CLASSES).toEqual(new Set(['residential', 'service', 'pedestrian']));
    // primary / footway get none
    expect(placeCables([straight('primary', 100)], FLAT_HEIGHT)).toHaveLength(0);
    expect(placeCables([straight('footway', 100)], FLAT_HEIGHT)).toHaveLength(0);
    // 100 m residential → floor(100/25) = 4 (±1 per 100 m)
    const n = placeCables([straight('residential', 100)], FLAT_HEIGHT).length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(5);
    expect(placeCables([straight('service', 100)], FLAT_HEIGHT).length).toBeGreaterThan(0);
    expect(placeCables([straight('pedestrian', 100)], FLAT_HEIGHT).length).toBeGreaterThan(0);
  });

  it('lowest catenary point = end height − 1.2 m', () => {
    const cables = placeCables([straight('residential', 100)], FLAT_HEIGHT);
    expect(cables.length).toBeGreaterThan(0);
    for (const cable of cables) {
      expect(cable.pts).toHaveLength(9); // 8 segments
      const endH = cable.pts[0][1];
      expect(cable.pts[8][1]).toBeCloseTo(endH, 2); // equal end heights
      const lowest = Math.min(...cable.pts.map((p) => p[1]));
      expect(lowest).toBeCloseTo(endH - 1.2, 2); // ±0.05
      // spanning road width + 4 m, perpendicular to the road (x-axis → cable along z)
      const span = Math.abs(cable.pts[0][2] - cable.pts[8][2]);
      expect(span).toBeCloseTo(ROAD_WIDTH.residential + 4, 1);
    }
  });

  it('deterministic: same input yields identical arrays', () => {
    const roads = [straight('residential', 100), straight('service', 60, 2)];
    expect(placeCables(roads, FLAT_HEIGHT)).toEqual(placeCables(roads, FLAT_HEIGHT));
  });
});

describe('buildPropsMesh', () => {
  it('produces solid + cones + pools for a small set of lamps and cables', () => {
    const lamps = placeLamps([straight('primary', 64)], FLAT_HEIGHT);
    const cables = placeCables([straight('residential', 50)], FLAT_HEIGHT);
    expect(lamps.length).toBeGreaterThan(0);
    expect(cables.length).toBeGreaterThan(0);
    const { solid, cones, pools } = buildPropsMesh(lamps, cables);
    expect(solid.positions.length).toBeGreaterThan(0);
    expect(cones.positions.length).toBeGreaterThan(0);
    expect(pools.positions.length).toBeGreaterThan(0);
    // solid has two material groups: body (0) and heads (1)
    expect(solid.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
  });
});

describe('building push-out', () => {
  it('lamp is pushed out of a building that overhangs the class width', () => {
    // primary road along +x; a building fills the +z side from z=4 out (wall 4 m from the centreline)
    const b = rect(1, -10, 4, 340, 16);
    const lamps = placeLamps([straight('primary', 320)], FLAT_HEIGHT, [b]);
    expect(lamps.length).toBeGreaterThan(0);
    for (const lamp of lamps) {
      expect(pointInPolygon(lamp.x, lamp.z, b.poly)).toBe(false);
      if (lamp.z > 0) {
        // +z lamps were pushed toward the centreline from 6.8 m to ≤ 3.4 m
        expect(Math.abs(lamp.z)).toBeLessThanOrEqual(3.4);
        // the arm still points at the road (centreline z = 0)
        expect(lamp.dirZ).toBeCloseTo(-1, 1);
      }
    }
  });

  it('lamp is skipped when no free spot >= 1.5 m exists', () => {
    // primary road 32 m → one lamp on the +z side; building fills the whole +z side from z=0
    const b = rect(1, -10, 0, 70, 20);
    const lamps = placeLamps([straight('primary', 32)], FLAT_HEIGHT, [b]);
    expect(lamps).toHaveLength(0);
  });

  it('deterministic with buildings: same input yields identical arrays', () => {
    const roads = [straight('primary', 320), straight('residential', 100, 2)];
    const b = rect(1, -10, 4, 340, 16);
    expect(placeLamps(roads, FLAT_HEIGHT, [b])).toEqual(placeLamps(roads, FLAT_HEIGHT, [b]));
  });

  it('deterministic with chained short ways: same input yields identical arrays', () => {
    const ways: Road[] = [];
    for (let w = 0; w < 5; w++) {
      ways.push({ id: w + 1, cls: 'residential', pts: [[w * 31, 0], [w * 31 + 31, 0]] });
    }
    expect(placeLamps(ways, FLAT_HEIGHT)).toEqual(placeLamps(ways, FLAT_HEIGHT));
  });
});

describe('cable clipping', () => {
  it('cable ends are within 2 m of a footprint edge or at the span end when no building is hit', () => {
    // residential road along +x (width 6 → half 5); building fills +z from z=2 out
    const b = rect(1, -10, 2, 70, 18);
    const cables = placeCables([straight('residential', 25)], FLAT_HEIGHT, [b]);
    expect(cables.length).toBeGreaterThan(0);
    const c = cables[0];
    // -z end: no building → stays at the span end
    expect(c.pts[0][2]).toBeCloseTo(-5, 1);
    // +z end: clipped to the building wall at z=2 → on/within 2 m of the edge
    expect(c.pts[8][2]).toBeCloseTo(2, 1);
    expect(distToPolygon(c.pts[8][0], c.pts[8][2], b.poly)).toBeLessThanOrEqual(2);
    // catenary still sags 1.2 m from the (shared) end height
    const endH = c.pts[0][1];
    const lowest = Math.min(...c.pts.map((p) => p[1]));
    expect(lowest).toBeCloseTo(endH - 1.2, 2);
  });
});

describe('london tile budget', () => {
  it('tile 0_0: no lamp base lies inside any footprint, total lamps 200–1 200', () => {
    const tile = JSON.parse(
      readFileSync(join(__dirname, '../public/data/london/tiles/0_0.json'), 'utf8'),
    ) as { roads: Road[]; buildings: Building[] };
    const sources = new Map<string, PunkSource>([['0_0', tile]]);
    const cells = bucketSources(sources);
    let total = 0;
    let maxCellMs = 0;
    for (const cell of cells.values()) {
      const t0 = performance.now();
      const lamps = placeLamps(cell.roads, FLAT_HEIGHT, cell.buildings);
      maxCellMs = Math.max(maxCellMs, performance.now() - t0);
      total += lamps.length;
      for (const lamp of lamps) {
        for (const b of cell.buildings) {
          expect(pointInPolygon(lamp.x, lamp.z, b.poly)).toBe(false);
        }
      }
    }
    process.stdout.write(`tile 0_0 surviving lamps: ${total} (max cell build ${maxCellMs.toFixed(2)} ms)\n`);
    expect(total).toBeGreaterThanOrEqual(200);
    expect(total).toBeLessThanOrEqual(1200);
    // coarse bucket keeps per-cell builds near O(n): worst cell well under the 10 ms budget
    expect(maxCellMs).toBeLessThan(50);
  });

  it('tile 0_0: solid+cones+pools triangles ≤ 250 000 for the whole tile', () => {
    const tile = JSON.parse(
      readFileSync(join(__dirname, '../public/data/london/tiles/0_0.json'), 'utf8'),
    ) as { roads: Road[]; buildings: Building[] };
    const lamps = placeLamps(tile.roads, FLAT_HEIGHT, tile.buildings);
    const cables = placeCables(tile.roads, FLAT_HEIGHT, tile.buildings);
    const { solid, cones, pools } = buildPropsMesh(lamps, cables);
    const tris =
      (solid.positions.length + cones.positions.length + pools.positions.length) / 9;
    expect(tris).toBeLessThanOrEqual(250_000);
  });
});

describe('london bank region (all tiles)', () => {
  it('short chopped OSM ways put ≥ 8 lamps west of Bank (x∈[-150,0], |z|<30), none inside any footprint', () => {
    const dir = join(__dirname, '../public/data/london/tiles');
    const sources = new Map<string, PunkSource>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const tile = JSON.parse(readFileSync(join(dir, f), 'utf8')) as PunkSource;
      sources.set(f.replace(/\.json$/, ''), tile);
    }
    const cells = bucketSources(sources);
    const region: Lamp[] = [];
    for (const cell of cells.values()) {
      for (const lamp of placeLamps(cell.roads, FLAT_HEIGHT, cell.buildings)) {
        if (lamp.x >= -150 && lamp.x <= 0 && Math.abs(lamp.z) < 30) region.push(lamp);
        for (const b of cell.buildings) {
          expect(pointInPolygon(lamp.x, lamp.z, b.poly)).toBe(false);
        }
      }
    }
    process.stdout.write(`bank region (x∈[-150,0], |z|<30) lamps: ${region.length}\n`);
    expect(region.length).toBeGreaterThanOrEqual(8);
  }, 30_000);
});
