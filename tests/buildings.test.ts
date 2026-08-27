/**
 * Building mesh builder + palette (T-0004 / docs/architecture.md §4.2–4.3).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FLAT_HEIGHT, type Building, type Vec2 } from '../src/data/types';
import { buildBuildingsMesh, normalizeRing } from '../src/world/buildings';
import {
  colorFor,
  LANDMARK_COLORS,
  LANDMARK_PALETTE,
  landmarkColor,
  PALETTE,
  registerLandmarkColors,
} from '../src/world/palette';

const SQUARE: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

const SQUARE_CW: Vec2[] = [
  [0, 0],
  [0, 10],
  [10, 10],
  [10, 0],
];

function squareBuilding(partial: Partial<Building> = {}): Building {
  return { id: 0, h: 5, poly: SQUARE, ...partial };
}

function arraysClose(a: ArrayLike<number>, b: ArrayLike<number>, digits = 5): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i]).toBeCloseTo(b[i]!, digits);
  }
}

describe('buildBuildingsMesh', () => {
  it('a 10×10 square footprint at h=5 yields 4 walls (24 vertices) + 2 roof triangles (6 vertices)', () => {
    const mesh = buildBuildingsMesh([squareBuilding()]);
    expect(mesh.positions.length / 3).toBe(30);
    expect(mesh.groups).toEqual([
      { start: 0, count: 24, materialIndex: 0 },
      { start: 24, count: 6, materialIndex: 1 },
    ]);
  });

  it('every wall normal is unit length, horizontal, and points away from the centroid (dot(n, mid - centroid) > 0)', () => {
    const mesh = buildBuildingsMesh([squareBuilding()]);
    const cx = 5;
    const cz = 5;
    for (let t = 0; t < 8; t++) {
      const i = t * 3;
      const ax = mesh.positions[i * 3]!;
      const ay = mesh.positions[i * 3 + 1]!;
      const az = mesh.positions[i * 3 + 2]!;
      const bx = mesh.positions[(i + 1) * 3]!;
      const by = mesh.positions[(i + 1) * 3 + 1]!;
      const bz = mesh.positions[(i + 1) * 3 + 2]!;
      const cxv = mesh.positions[(i + 2) * 3]!;
      const cy = mesh.positions[(i + 2) * 3 + 1]!;
      const czv = mesh.positions[(i + 2) * 3 + 2]!;
      const nx = mesh.normals[i * 3]!;
      const ny = mesh.normals[i * 3 + 1]!;
      const nz = mesh.normals[i * 3 + 2]!;
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1);
      expect(ny).toBeCloseTo(0);
      const midX = (ax + bx + cxv) / 3;
      const midY = (ay + by + cy) / 3;
      const midZ = (az + bz + czv) / 3;
      const dot = nx * (midX - cx) + ny * (midY - 0) + nz * (midZ - cz);
      expect(dot).toBeGreaterThan(0);
    }
  });

  it("every wall triangle's geometric normal cross(b-a, c-a) has positive dot with its stored normal", () => {
    const mesh = buildBuildingsMesh([squareBuilding()]);
    for (let t = 0; t < 8; t++) {
      const i = t * 3;
      const ax = mesh.positions[i * 3]!;
      const ay = mesh.positions[i * 3 + 1]!;
      const az = mesh.positions[i * 3 + 2]!;
      const bx = mesh.positions[(i + 1) * 3]!;
      const by = mesh.positions[(i + 1) * 3 + 1]!;
      const bz = mesh.positions[(i + 1) * 3 + 2]!;
      const cx = mesh.positions[(i + 2) * 3]!;
      const cy = mesh.positions[(i + 2) * 3 + 1]!;
      const cz = mesh.positions[(i + 2) * 3 + 2]!;
      const e1x = bx - ax;
      const e1y = by - ay;
      const e1z = bz - az;
      const e2x = cx - ax;
      const e2y = cy - ay;
      const e2z = cz - az;
      const gx = e1y * e2z - e1z * e2y;
      const gy = e1z * e2x - e1x * e2z;
      const gz = e1x * e2y - e1y * e2x;
      const nx = mesh.normals[i * 3]!;
      const ny = mesh.normals[i * 3 + 1]!;
      const nz = mesh.normals[i * 3 + 2]!;
      expect(gx * nx + gy * ny + gz * nz).toBeGreaterThan(0);
    }
  });

  it('roof normals are (0,1,0) and roof triangles wind upward', () => {
    const mesh = buildBuildingsMesh([squareBuilding()]);
    for (let v = 24; v < 30; v++) {
      expect(mesh.normals[v * 3]).toBeCloseTo(0);
      expect(mesh.normals[v * 3 + 1]).toBeCloseTo(1);
      expect(mesh.normals[v * 3 + 2]).toBeCloseTo(0);
    }
    for (let t = 0; t < 2; t++) {
      const i = 24 + t * 3;
      const ax = mesh.positions[i * 3]!;
      const az = mesh.positions[i * 3 + 2]!;
      const bx = mesh.positions[(i + 1) * 3]!;
      const bz = mesh.positions[(i + 1) * 3 + 2]!;
      const cx = mesh.positions[(i + 2) * 3]!;
      const cz = mesh.positions[(i + 2) * 3 + 2]!;
      const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      expect(crossY).toBeGreaterThan(0);
    }
  });

  it('wall uvs — u runs 0 → 40/24 around the ring, v is 0 at the base and 5/24 at the top', () => {
    const mesh = buildBuildingsMesh([squareBuilding()]);
    const us: number[] = [];
    const vs = new Set<number>();
    for (let v = 0; v < 24; v++) {
      us.push(mesh.uvs[v * 2]!);
      vs.add(mesh.uvs[v * 2 + 1]!);
    }
    expect(Math.min(...us)).toBeCloseTo(0);
    expect(Math.max(...us)).toBeCloseTo(40 / 24);
    const vList = [...vs].sort((a, b) => a - b);
    expect(vList).toHaveLength(2);
    expect(vList[0]).toBeCloseTo(0);
    expect(vList[1]).toBeCloseTo(5 / 24);

    // Each of the four walls is a 10 m edge; u steps by 10/24 per wall.
    for (let w = 0; w < 4; w++) {
      const base = w * 6;
      const u0 = mesh.uvs[base * 2]!;
      const u1 = mesh.uvs[(base + 2) * 2]!;
      expect(u0).toBeCloseTo((w * 10) / 24);
      expect(u1).toBeCloseTo(((w + 1) * 10) / 24);
    }
  });

  it('a clockwise input ring gives identical geometry to its reversed copy (normalizeRing)', () => {
    const reversed = SQUARE_CW.slice().reverse();
    expect(normalizeRing(SQUARE_CW)).toEqual(normalizeRing(reversed));
    const a = buildBuildingsMesh([squareBuilding({ poly: SQUARE_CW })]);
    const b = buildBuildingsMesh([squareBuilding({ poly: reversed })]);
    arraysClose(a.positions, b.positions);
    arraysClose(a.normals, b.normals);
    arraysClose(a.uvs, b.uvs);
    arraysClose(a.colors, b.colors);
    expect(a.groups).toEqual(b.groups);
  });

  it('rings with |area| < 1 produce no vertices', () => {
    const tiny: Vec2[] = [
      [0, 0],
      [0.5, 0],
      [0.5, 0.5],
      [0, 0.5],
    ];
    const mesh = buildBuildingsMesh([{ id: 0, h: 5, poly: tiny }]);
    expect(mesh.positions.length).toBe(0);
    expect(mesh.normals.length).toBe(0);
    expect(mesh.uvs.length).toBe(0);
    expect(mesh.colors.length).toBe(0);
    expect(mesh.groups).toEqual([]);
  });

  it('vertex colours equal the linear rgb of colorFor (new THREE.Color(hex))', () => {
    const building = squareBuilding({ id: 3, name: 'Royal Exchange' });
    const mesh = buildBuildingsMesh([building]);
    const c = new THREE.Color(colorFor(building));
    expect(mesh.colors.length).toBe(30 * 3);
    for (let v = 0; v < 30; v++) {
      expect(mesh.colors[v * 3]).toBeCloseTo(c.r);
      expect(mesh.colors[v * 3 + 1]).toBeCloseTo(c.g);
      expect(mesh.colors[v * 3 + 2]).toBeCloseTo(c.b);
    }
  });

  it('with heightAt = (x, z) => x on a 10×10 square at x∈[0,10], h=5: wall min y = 0, wall max y = 15, roof y = 15, wall v runs 0 → 15/24', () => {
    const heightAt = (x: number, _z: number) => x;
    const mesh = buildBuildingsMesh([squareBuilding()], heightAt);
    const wallYs: number[] = [];
    const wallVs: number[] = [];
    for (let v = 0; v < 24; v++) {
      wallYs.push(mesh.positions[v * 3 + 1]!);
      wallVs.push(mesh.uvs[v * 2 + 1]!);
    }
    expect(Math.min(...wallYs)).toBeCloseTo(0);
    expect(Math.max(...wallYs)).toBeCloseTo(15);
    for (let v = 24; v < 30; v++) {
      expect(mesh.positions[v * 3 + 1]).toBeCloseTo(15);
    }
    expect(Math.min(...wallVs)).toBeCloseTo(0);
    expect(Math.max(...wallVs)).toBeCloseTo(15 / 24);
  });

  it('default heightAt gives identical geometry to a call with FLAT_HEIGHT', () => {
    const building = squareBuilding({ id: 3, name: 'Royal Exchange' });
    const a = buildBuildingsMesh([building]);
    const b = buildBuildingsMesh([building], FLAT_HEIGHT);
    arraysClose(a.positions, b.positions);
    arraysClose(a.normals, b.normals);
    arraysClose(a.uvs, b.uvs);
    arraysClose(a.colors, b.colors);
    expect(a.groups).toEqual(b.groups);
  });
});

describe('colorFor', () => {
  it('colorFor picks LANDMARK_PALETTE[id % 4] for named buildings and PALETTE[id % 8] otherwise', () => {
    expect(colorFor(squareBuilding({ id: 0, name: "St Paul's" }))).toBe(LANDMARK_PALETTE[0]);
    expect(colorFor(squareBuilding({ id: 5, name: 'Bank' }))).toBe(LANDMARK_PALETTE[5 % 4]);
    expect(colorFor(squareBuilding({ id: 1 }))).toBe(PALETTE[1]);
    expect(colorFor(squareBuilding({ id: 9 }))).toBe(PALETTE[9 % 8]);
    expect(colorFor(squareBuilding({ id: 8 }))).toBe(PALETTE[0]);
  });

  it("colorFor({ id: 7, name: 'Elizabeth Tower', h: 96, poly: [...] }) → 0xf7dc6f", () => {
    expect(
      colorFor({ id: 7, name: 'Elizabeth Tower', h: 96, poly: SQUARE }),
    ).toBe(0xf7dc6f);
  });

  it('a named building not in the table still gets LANDMARK_PALETTE[id % 4]', () => {
    expect(colorFor(squareBuilding({ id: 7, name: 'Some Named Building' }))).toBe(
      LANDMARK_PALETTE[7 % 4],
    );
  });

  it('colorFor returns a registered landmark colour before the static table', () => {
    registerLandmarkColors({ X: 0x123456 });
    expect(colorFor(squareBuilding({ id: 0, name: 'X' }))).toBe(0x123456);
    expect(landmarkColor('X')).toBe(0x123456);
  });
});

describe('landmarkColor', () => {
  it('landmarkColor(undefined) → undefined', () => {
    expect(landmarkColor(undefined)).toBeUndefined();
  });
});

describe('LANDMARK_COLORS', () => {
  it('the table has no duplicate keys and every value is a 24-bit integer', () => {
    const keys = Object.keys(LANDMARK_COLORS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const value of Object.values(LANDMARK_COLORS)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffff);
    }
  });
});
