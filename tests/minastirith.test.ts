/**
 * Unit tests for `scripts/gen-minas-tirith.mjs` (architecture.md §4.23).
 * Covers the cases listed in T-0126's acceptance criteria, by name.
 */
import { describe, expect, it } from 'vitest';

import {
  GATE_AZ,
  PLACES,
  TIERS,
  buildCity,
  buildRoads,
  buildWalls,
  mulberry32,
  terrainHeight,
} from '../scripts/gen-minas-tirith';
import type { CityData } from '../src/data/types';

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isFiniteVec2(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    isFiniteNum(v[0]) &&
    isFiniteNum(v[1])
  );
}

/** Copy of the producer rules (unique ids, polys, h in [3, 650], finite). */
function assertCityRules(city: CityData): void {
  const ids = new Set<number>();
  for (let i = 0; i < city.buildings.length; i++) {
    const b = city.buildings[i];
    if (!isFiniteNum(b.h) || b.h < 3 || b.h > 650) {
      throw new Error(`buildings[${i}].h`);
    }
    if (!Array.isArray(b.poly) || b.poly.length < 3) {
      throw new Error(`buildings[${i}].poly`);
    }
    b.poly.forEach((pt, k) => {
      if (!isFiniteVec2(pt)) throw new Error(`buildings[${i}].poly[${k}]`);
    });
    const first = b.poly[0];
    const last = b.poly[b.poly.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      throw new Error(`buildings[${i}].poly: first point must not repeat last`);
    }
    if (ids.has(b.id)) throw new Error(`buildings[${i}].id: duplicate`);
    ids.add(b.id);
  }
  const roadIds = new Set<number>();
  for (let i = 0; i < city.roads.length; i++) {
    const r = city.roads[i];
    if (!Array.isArray(r.pts) || r.pts.length < 2) {
      throw new Error(`roads[${i}].pts`);
    }
    r.pts.forEach((pt, k) => {
      if (!isFiniteVec2(pt)) throw new Error(`roads[${i}].pts[${k}]`);
    });
    if (roadIds.has(r.id)) throw new Error(`roads[${i}].id: duplicate`);
    roadIds.add(r.id);
  }
  for (const p of city.places) {
    if (!p.name || !isFiniteNum(p.x) || !isFiniteNum(p.z)) {
      throw new Error('places');
    }
  }
}

describe('minas tirith generator', () => {
  it('terrainHeight: (0,0)→200; (270,0)→96 prow; (0,270)→64; (0,305) ramp; (500,500) Pelennor; (−700,0) Mindolluin', () => {
    const rand = mulberry32(1);
    expect(terrainHeight(0, 0, rand)).toBe(200);
    expect(terrainHeight(270, 0, rand)).toBe(96);
    expect(terrainHeight(0, 270, rand)).toBe(64);
    const ramp = terrainHeight(0, 305, rand);
    expect(ramp).toBeGreaterThan(32);
    expect(ramp).toBeLessThan(64);
    expect(Math.abs(terrainHeight(500, 500, rand))).toBeLessThanOrEqual(1.5);
    expect(terrainHeight(-700, 0, rand)).toBeGreaterThanOrEqual(150);
  });

  it('prow notch: the point on the east axis at the tier-3 ring road radius (R_3 − 14, z = 0) → H_3, not H_4', () => {
    const r = TIERS[2].r - 14;
    expect(r).toBe(281);
    expect(terrainHeight(r, 0)).toBe(TIERS[2].h);
    expect(terrainHeight(r, 0)).toBe(64);
    expect(terrainHeight(r, 0)).not.toBe(TIERS[3].h);
  });

  it('buildWalls: 7 tiers × 48 segments minus gate gaps + 14 gate towers', () => {
    const walls = buildWalls();
    const segments = walls.filter((b) => b.id % 1000 < 48);
    const towers = walls.filter((b) => b.id % 1000 >= 48);
    const omitted = 7 * 48 - segments.length;
    expect(towers).toHaveLength(14);
    expect(walls).toHaveLength(7 * 48 - omitted + 14);
    expect(GATE_AZ).toHaveLength(7);

    for (const b of walls) {
      expect(b.poly).toHaveLength(4);
    }
    for (const b of segments) {
      if (Math.floor(b.id / 1000) === 1) {
        expect(b.color).toBe(0x2a2a30);
      }
    }
    const great = walls.filter((b) => b.name === 'Great Gate');
    expect(great.length).toBeGreaterThanOrEqual(2);
    for (const t of great) {
      expect(t.shape).toBe('tower');
    }
  });

  it('buildRoads: the main road starts at (R_1 + 60, 0), monotone after the gate, ends at (10, 0); 7 ring roads; every lane outer vertex at R_k − 14', () => {
    const roads = buildRoads();
    const main = roads.find((r) => r.name === 'The Climbing Way');
    expect(main).toBeDefined();
    if (!main) return;
    expect(main.pts[0][0]).toBeCloseTo(TIERS[0].r + 60, 5);
    expect(main.pts[0][1]).toBeCloseTo(0, 5);
    const last = main.pts[main.pts.length - 1];
    expect(last[0]).toBeCloseTo(10, 5);
    expect(last[1]).toBeCloseTo(0, 5);

    let afterGate = false;
    let prev = Number.NEGATIVE_INFINITY;
    for (const [x, z] of main.pts) {
      const rad = Math.hypot(x, z);
      if (!afterGate) {
        if (rad <= TIERS[0].r + 0.5) afterGate = true;
        else continue;
      }
      const h = terrainHeight(x, z);
      expect(h).toBeGreaterThanOrEqual(prev - 0.5);
      prev = h;
    }

    const rings = roads.filter(
      (r) => r.name === 'Citadel Ring' || (r.name !== undefined && /^Ring \d$/.test(r.name)),
    );
    expect(rings).toHaveLength(7);

    const lanes = roads.filter((r) => r.name !== undefined && r.name.startsWith('Lane '));
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) {
      const m = /^Lane (\d)\./.exec(lane.name ?? '');
      expect(m).not.toBeNull();
      if (!m) continue;
      const k = Number(m[1]);
      const outerR = TIERS[k - 1].r - 14;
      const [a, b] = lane.pts;
      const outer = Math.hypot(a[0], a[1]) >= Math.hypot(b[0], b[1]) ? a : b;
      expect(Math.hypot(outer[0], outer[1])).toBeCloseTo(outerR, 0);
    }
  });

  it('buildCity(1) twice → deep-equal (determinism) and passes a copy of the validation rules; terrain.cols === terrain.rows === 302', () => {
    const a = buildCity(1);
    const b = buildCity(1);
    expect(a).toEqual(b);
    expect(a.trees).toHaveLength(7);
    expect(a.places.map((p) => p.name)).toEqual(PLACES.map((p) => p.name));
    assertCityRules(a);
    expect(a.terrain).toBeDefined();
    const terrain = a.terrain;
    if (!terrain) return;
    expect(terrain.cols).toBe(302);
    expect(terrain.rows).toBe(302);
    expect(terrain.step).toBe(10);
    expect(terrain.datum).toBe(0);
    expect(terrain.heights).toHaveLength(302 * 302);
  });
});
