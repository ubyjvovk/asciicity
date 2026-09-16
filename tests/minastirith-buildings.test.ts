/**
 * Unit tests for `scripts/minas-tirith-buildings.mjs` (architecture.md §4.23).
 * Covers the cases listed in T-0127's acceptance criteria, by name.
 */
import { describe, expect, it } from 'vitest';

import {
  GATE_AZ,
  TIERS,
  buildCity,
  buildRoads,
  mulberry32,
  terrainHeight,
} from '../scripts/gen-minas-tirith';
import {
  buildHouses,
  buildLandmarks,
  buildTrees,
} from '../scripts/minas-tirith-buildings';
import { validateCity } from '../src/data/validate';
import type { Building, Vec2 } from '../src/data/types';

function centroid(poly: Vec2[]): [number, number] {
  let sx = 0;
  let sz = 0;
  for (const [x, z] of poly) {
    sx += x;
    sz += z;
  }
  return [sx / poly.length, sz / poly.length];
}

function aabb(poly: Vec2[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

function aabbOverlap(
  a: { minX: number; maxX: number; minZ: number; maxZ: number },
  b: { minX: number; maxX: number; minZ: number; maxZ: number },
): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function azimuthOf(x: number, z: number): number {
  let d = (Math.atan2(x, -z) * 180) / Math.PI;
  if (d < 0) d += 360;
  return d;
}

function angDist(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

function prowHalfWidth(r: number): number {
  const r7 = TIERS[6].r;
  const r2 = TIERS[1].r;
  const t = (r - r7) / (r2 - r7);
  return 24 + t * (8 - 24);
}

function inProwSector(x: number, z: number): boolean {
  if (x < 0) return false;
  const r = Math.hypot(x, z);
  if (r < TIERS[6].r || r > TIERS[1].r) return false;
  return Math.abs(z) <= prowHalfWidth(r);
}

function distPointSeg(px: number, pz: number, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const apx = px - a[0];
  const apz = pz - a[1];
  const len2 = abx * abx + abz * abz;
  let t = len2 === 0 ? 0 : (apx * abx + apz * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * abx), pz - (a[1] + t * abz));
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const cdx = d[0] - c[0];
  const cdz = d[1] - c[1];
  const den = abx * cdz - abz * cdx;
  if (den === 0) return false;
  const acx = c[0] - a[0];
  const acz = c[1] - a[1];
  const t = (acx * cdz - acz * cdx) / den;
  const u = (acx * abz - acz * abx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function pointInPoly(x: number, z: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distPolySeg(poly: Vec2[], a: Vec2, b: Vec2): number {
  if (pointInPoly(a[0], a[1], poly) || pointInPoly(b[0], b[1], poly)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (segmentsIntersect(p, q, a, b)) return 0;
    d = Math.min(d, distPointSeg(p[0], p[1], a, b));
    d = Math.min(d, distPointSeg(a[0], a[1], p, q));
    d = Math.min(d, distPointSeg(b[0], b[1], p, q));
  }
  return d;
}

function edgeLengths(poly: Vec2[]): [number, number] {
  const e0 = Math.hypot(poly[1][0] - poly[0][0], poly[1][1] - poly[0][1]);
  const e1 = Math.hypot(poly[2][0] - poly[1][0], poly[2][1] - poly[1][1]);
  return e0 <= e1 ? [e0, e1] : [e1, e0];
}

function housesOf(seed = 1): Building[] {
  return buildHouses(TIERS, GATE_AZ, mulberry32(seed));
}

function tierOfHouse(id: number): number {
  return Math.floor((id - 10000) / 1000);
}

describe('minas tirith houses, landmarks and trees', () => {
  it('every house lies on its tier\'s plateau: terrainHeight at the footprint centroid equals H_k (±0.5) and never inside the prow sector or a gate approach', () => {
    const houses = housesOf(1);
    expect(houses.length).toBeGreaterThan(0);
    for (const b of houses) {
      const k = tierOfHouse(b.id);
      expect(k).toBeGreaterThanOrEqual(1);
      expect(k).toBeLessThanOrEqual(6);
      const [cx, cz] = centroid(b.poly);
      expect(terrainHeight(cx, cz)).toBeCloseTo(TIERS[k - 1].h, 0);
      expect(Math.abs(terrainHeight(cx, cz) - TIERS[k - 1].h)).toBeLessThanOrEqual(0.5);
      expect(inProwSector(cx, cz)).toBe(false);
      const az = azimuthOf(cx, cz);
      expect(angDist(az, GATE_AZ[k - 1])).toBeGreaterThan(10);
      expect(angDist(az, GATE_AZ[k])).toBeGreaterThan(10);
    }
  });

  it('no two houses overlap (AABB test on footprints)', () => {
    const houses = housesOf(1);
    const boxes = houses.map((b) => aabb(b.poly));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(
          aabbOverlap(boxes[i], boxes[j]),
          `${houses[i].id} vs ${houses[j].id}`,
        ).toBe(false);
      }
    }
  });

  it('no house footprint crosses a radial lane centre-line (±6 m)', () => {
    const houses = housesOf(1);
    const lanes = buildRoads().filter((r) => r.name !== undefined && r.name.startsWith('Lane '));
    expect(lanes.length).toBeGreaterThan(0);
    for (const b of houses) {
      for (const lane of lanes) {
        expect(distPolySeg(b.poly, lane.pts[0], lane.pts[lane.pts.length - 1])).toBeGreaterThanOrEqual(
          6,
        );
      }
    }
  });

  it('buildLandmarks yields the 12 named buildings of §4.23 with the given sizes/heights/shapes (check White Tower of Ecthelion h 90 shape tower, 6 Rath Dínen domes, House of the Stewards 12 m)', () => {
    const marks = buildLandmarks();
    expect(marks).toHaveLength(12);
    for (const b of marks) {
      expect(b.name).toBeTruthy();
      expect((b.name ?? '').length).toBeGreaterThan(0);
      expect(b.id).toBeGreaterThanOrEqual(20000);
      expect(b.color).toBeDefined();
    }

    const tower = marks.find((b) => b.name === 'White Tower of Ecthelion');
    expect(tower).toBeDefined();
    expect(tower?.h).toBe(90);
    expect(tower?.shape).toBe('tower');
    const towerSides = edgeLengths(tower!.poly);
    expect(towerSides[0]).toBeCloseTo(22, 0);
    expect(towerSides[1]).toBeCloseTo(22, 0);

    const hall = marks.find((b) => b.name === 'Tower Hall');
    expect(hall?.h).toBe(22);
    const hallSides = edgeLengths(hall!.poly);
    expect(hallSides[0]).toBeCloseTo(18, 0);
    expect(hallSides[1]).toBeCloseTo(44, 0);

    const merethrond = marks.find((b) => b.name === 'Merethrond');
    expect(merethrond?.h).toBe(16);
    const merSides = edgeLengths(merethrond!.poly);
    expect(merSides[0]).toBeCloseTo(16, 0);
    expect(merSides[1]).toBeCloseTo(40, 0);

    const kings = marks.find((b) => b.name === "The King's House");
    expect(kings?.h).toBe(14);
    const kingSides = edgeLengths(kings!.poly);
    expect(kingSides[0]).toBeCloseTo(16, 0);
    expect(kingSides[1]).toBeCloseTo(30, 0);

    const healing = marks.find((b) => b.name === 'Houses of Healing');
    expect(healing?.h).toBe(12);
    const healSides = edgeLengths(healing!.poly);
    expect(healSides[0]).toBeCloseTo(16, 0);
    expect(healSides[1]).toBeCloseTo(40, 0);

    const guesthouse = marks.find((b) => b.name === 'The Old Guesthouse');
    expect(guesthouse?.h).toBe(10);
    expect(guesthouse?.color).toBe(0xcfc3a8);
    const guestSides = edgeLengths(guesthouse!.poly);
    expect(guestSides[0]).toBeCloseTo(12, 0);
    expect(guestSides[1]).toBeCloseTo(24, 0);

    const domes = marks.filter((b) => b.shape === 'dome');
    expect(domes).toHaveLength(6);
    for (const d of domes) {
      expect(d.color).toBe(0xb8b4aa);
    }

    const stewards = marks.find((b) => b.name === 'House of the Stewards');
    expect(stewards).toBeDefined();
    expect(stewards?.h).toBe(8);
    expect(stewards?.shape).toBe('dome');
    const stSides = edgeLengths(stewards!.poly);
    expect(stSides[0]).toBeCloseTo(12, 0);
    expect(stSides[1]).toBeCloseTo(12, 0);
  });

  it('buildTrees → 7 entries, [0, 0, 8, 3] first', () => {
    const trees = buildTrees();
    expect(trees).toHaveLength(7);
    expect(trees[0]).toEqual([0, 0, 8, 3]);
    for (let i = 1; i < 7; i++) {
      expect(trees[i][2]).toBe(7);
      expect(trees[i][3]).toBe(3);
    }
  });

  it('buildCity(1) still validates and is deterministic', () => {
    const a = buildCity(1);
    const b = buildCity(1);
    expect(a).toEqual(b);
    expect(() => validateCity(a)).not.toThrow();
    expect(a.trees).toEqual(buildTrees());
    const houseIds = a.buildings.filter((b) => b.id >= 10000 && b.id < 20000);
    expect(houseIds.length).toBeGreaterThan(0);
    const landmarkIds = a.buildings.filter((b) => b.id >= 20000);
    expect(landmarkIds).toHaveLength(12);
  });
});
