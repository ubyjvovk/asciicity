/**
 * Cyberpunk street props (wave 20b, src/render/punk/propsmesh.ts): lamp and
 * cable placement + mesh triangle budgets. Pure — no three/webgpu.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLAT_HEIGHT, type HeightFn, type Road } from '../src/data/types';
import { ROAD_WIDTH } from '../src/world/roads';
import { buildPropsMesh, CABLE_CLASSES, LAMP_CLASSES, placeCables, placeLamps } from '../src/render/punk/propsmesh';

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
  it('straight 320 m primary road yields 10 lamps, alternating sides, at ROAD_WIDTH.primary/2 + 0.8, arm toward the road', () => {
    const lamps = placeLamps([straight('primary', 320)], FLAT_HEIGHT);
    expect(lamps.length).toBeGreaterThanOrEqual(9);
    expect(lamps.length).toBeLessThanOrEqual(11);
    const off = ROAD_WIDTH.primary / 2 + 0.8;
    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i];
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

describe('london tile budget', () => {
  it('tile 0_0: total lamps between 300 and 1 200, triangles ≤ 250 000', () => {
    const tile = JSON.parse(
      readFileSync(join(__dirname, '../public/data/london/tiles/0_0.json'), 'utf8'),
    ) as { roads: Road[] };
    const lamps = placeLamps(tile.roads, FLAT_HEIGHT);
    const cables = placeCables(tile.roads, FLAT_HEIGHT);
    expect(lamps.length).toBeGreaterThanOrEqual(300);
    expect(lamps.length).toBeLessThanOrEqual(1200);
    const { solid, cones, pools } = buildPropsMesh(lamps, cables);
    const tris =
      (solid.positions.length + cones.positions.length + pools.positions.length) / 9;
    expect(tris).toBeLessThanOrEqual(250_000);
  });
});
