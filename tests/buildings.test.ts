/**
 * Building mesh builder + palette (T-0004 / docs/architecture.md §4.2–4.3).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FLAT_HEIGHT, type Building, type BuildingRoof, type Vec2 } from '../src/data/types';
import { buildBuildingsMesh, MATERIAL_CODE, normalizeRing } from '../src/world/buildings';
import { type MeshData } from '../src/world/mesh';
import { readFileSync } from 'node:fs';
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

  it('a dome building adds exactly 8·4·2 = 64 triangles (192 vertices) in group 0 above roof height with outward unit normals', () => {
    // 10×10 square at h=5: walls 24 + dome 192 = 216 group-0 vertices; roofs 6.
    const mesh = buildBuildingsMesh([squareBuilding({ shape: 'dome' })]);
    expect(mesh.positions.length / 3).toBe(216 + 6);
    expect(mesh.groups).toEqual([
      { start: 0, count: 216, materialIndex: 0 },
      { start: 216, count: 6, materialIndex: 1 },
    ]);
    // The 192 cap vertices lie in group 0 (after the 24 wall vertices), never below the roof.
    for (let v = 24; v < 216; v++) {
      expect(mesh.positions[v * 3 + 1]!).toBeGreaterThanOrEqual(5);
      const nx = mesh.normals[v * 3]!;
      const ny = mesh.normals[v * 3 + 1]!;
      const nz = mesh.normals[v * 3 + 2]!;
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1);
    }
    // Every cap triangle faces away from the dome centre (5, 5, roofY=5).
    const cx = 5;
    const cz = 5;
    const cy = 5;
    for (let t = 0; t < 64; t++) {
      const i = 24 + t * 3;
      const ax = mesh.positions[i * 3]!;
      const ay = mesh.positions[i * 3 + 1]!;
      const az = mesh.positions[i * 3 + 2]!;
      const bx = mesh.positions[(i + 1) * 3]!;
      const by = mesh.positions[(i + 1) * 3 + 1]!;
      const bz = mesh.positions[(i + 1) * 3 + 2]!;
      const ggx = mesh.positions[(i + 2) * 3]!;
      const ggy = mesh.positions[(i + 2) * 3 + 1]!;
      const ggz = mesh.positions[(i + 2) * 3 + 2]!;
      const mx = (ax + bx + ggx) / 3;
      const my = (ay + by + ggy) / 3;
      const mz = (az + bz + ggz) / 3;
      const nx = mesh.normals[i * 3]!;
      const ny = mesh.normals[i * 3 + 1]!;
      const nz = mesh.normals[i * 3 + 2]!;
      expect(nx * (mx - cx) + ny * (my - cy) + nz * (mz - cz)).toBeGreaterThan(0);
    }
  });

  it('a spire building adds 8 side triangles (24 vertices) reaching roofY + 0.6·h at the apex; base omitted', () => {
    // Walls 24 + spire 24 = 48 group-0 vertices; roofs 6.
    const mesh = buildBuildingsMesh([squareBuilding({ shape: 'spire' })]);
    expect(mesh.positions.length / 3).toBe(48 + 6);
    expect(mesh.groups).toEqual([
      { start: 0, count: 48, materialIndex: 0 },
      { start: 48, count: 6, materialIndex: 1 },
    ]);
    // Exactly 8 side triangles in the spire (24 vertices = 8 triangles).
    expect(24 / 3).toBe(8);
    // Apex reaches roofY + 0.6·h = 5 + 3 = 8; the base ring sits at roofY = 5.
    let maxY = -Infinity;
    let minY = Infinity;
    for (let v = 24; v < 48; v++) {
      const y = mesh.positions[v * 3 + 1]!;
      if (y > maxY) maxY = y;
      if (y < minY) minY = y;
      const nx = mesh.normals[v * 3]!;
      const ny = mesh.normals[v * 3 + 1]!;
      const nz = mesh.normals[v * 3 + 2]!;
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1);
    }
    expect(maxY).toBeCloseTo(5 + 0.6 * 5);
    expect(minY).toBeCloseTo(5);
  });

  it('a tower building adds a box whose top is roofY + 0.5·h', () => {
    // Walls 24 + tower 30 (4 sides + top) = 54 group-0 vertices; roofs 6.
    const mesh = buildBuildingsMesh([squareBuilding({ shape: 'tower' })]);
    expect(mesh.positions.length / 3).toBe(54 + 6);
    expect(mesh.groups).toEqual([
      { start: 0, count: 54, materialIndex: 0 },
      { start: 54, count: 6, materialIndex: 1 },
    ]);
    // Top at roofY + 0.5·h = 5 + 2.5 = 7.5; box sits on the roof at 5.
    let maxY = -Infinity;
    let minY = Infinity;
    for (let v = 24; v < 54; v++) {
      const y = mesh.positions[v * 3 + 1]!;
      if (y > maxY) maxY = y;
      if (y < minY) minY = y;
      const nx = mesh.normals[v * 3]!;
      const ny = mesh.normals[v * 3 + 1]!;
      const nz = mesh.normals[v * 3 + 2]!;
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1);
    }
    expect(maxY).toBeCloseTo(5 + 0.5 * 5);
    expect(minY).toBeCloseTo(5);
  });

  it('walls of a building with minH start at minH and a bottom cap is emitted', () => {
    const mesh = buildBuildingsMesh([squareBuilding({ h: 20, minH: 8 })]);
    // 4 walls × 6 verts = 24; roof 6; downward cap 6.
    expect(mesh.positions.length / 3).toBe(36);
    expect(mesh.groups).toEqual([
      { start: 0, count: 24, materialIndex: 0 },
      { start: 24, count: 12, materialIndex: 1 },
    ]);
    const wallYs: number[] = [];
    for (let v = 0; v < 24; v++) {
      wallYs.push(mesh.positions[v * 3 + 1]!);
    }
    expect(Math.min(...wallYs)).toBeCloseTo(8);
    expect(Math.max(...wallYs)).toBeCloseTo(20);
    // Roof (first 6 group-1 verts) at h, upward; remaining 6 are the cap at minH, downward.
    for (let v = 24; v < 30; v++) {
      expect(mesh.positions[v * 3 + 1]).toBeCloseTo(20);
      expect(mesh.normals[v * 3 + 1]).toBeCloseTo(1);
    }
    for (let v = 30; v < 36; v++) {
      expect(mesh.positions[v * 3 + 1]).toBeCloseTo(8);
      expect(mesh.normals[v * 3]).toBeCloseTo(0);
      expect(mesh.normals[v * 3 + 1]).toBeCloseTo(-1);
      expect(mesh.normals[v * 3 + 2]).toBeCloseTo(0);
    }
  });

  it('no shape → identical output to a building whose shape key is absent (compare arrays)', () => {
    const a = buildBuildingsMesh([squareBuilding()]);
    const b = buildBuildingsMesh([squareBuilding({ shape: undefined })]);
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

/** Vertex `i` of a mesh as [x, y, z]. */
function vtx(m: MeshData, i: number): [number, number, number] {
  return [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
}

/** Vertex index range of material group `mat`. */
function groupRange(m: MeshData, mat: number): [number, number] {
  const g = m.groups.find((x) => x.materialIndex === mat);
  return g ? [g.start, g.start + g.count] : [0, 0];
}

const key2 = (x: number, z: number): string => `${x.toFixed(3)},${z.toFixed(3)}`;
const key3 = (p: readonly number[]): string => `${p[0]!.toFixed(3)},${p[1]!.toFixed(3)},${p[2]!.toFixed(3)}`;
const segKey = (p: readonly number[], q: readonly number[]): string => {
  const a = key3(p);
  const b = key3(q);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};

/** Wall-top segments (quad vertices 1 → 2 of every 6-vertex wall quad) of group 0. */
function wallTopSegments(m: MeshData): Set<string> {
  const [s, e] = groupRange(m, 0);
  const out = new Set<string>();
  for (let q = s; q + 5 < e; q += 6) out.add(segKey(vtx(m, q + 1), vtx(m, q + 2)));
  return out;
}

/** Undirected roof edge → number of group-1 triangles using it. */
function roofEdgeCounts(m: MeshData): Map<string, number> {
  const [s, e] = groupRange(m, 1);
  const out = new Map<string, number>();
  for (let t = s; t < e; t += 3) {
    const p = [vtx(m, t), vtx(m, t + 1), vtx(m, t + 2)];
    for (let k = 0; k < 3; k++) {
      const key = segKey(p[k]!, p[(k + 1) % 3]!);
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

const RECT_20x10: Vec2[] = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
];
const L_SHAPE: Vec2[] = [
  [0, 0],
  [30, 0],
  [30, 10],
  [10, 10],
  [10, 30],
  [0, 30],
];

/** Roofed 20×10 building (h 15) with the given roof. */
function roofed(roof: BuildingRoof, poly: Vec2[] = RECT_20x10): Building {
  return { id: 1, h: 15, poly, roof };
}

/** The §4.2 height-field formula, independent of the builder. */
function fieldFormula(shape: string, s: number, t: number, L: number, W: number): number {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  if (shape === 'hipped') return clamp(Math.min(1 - Math.abs(t) / W, (L - Math.abs(s)) / W));
  if (shape === 'pyramidal') return clamp(1 - Math.max(Math.abs(s) / L, Math.abs(t) / W));
  if (shape === 'skillion') return (t + W) / (2 * W);
  if (shape === 'round') return Math.sqrt(Math.max(0, 1 - (t / W) ** 2));
  return 1 - Math.abs(t) / W;
}

// Checksum of a fixed 3-building flat fixture, recorded from main (8a517ba)
// BEFORE the wave-21 roof builder landed: sum of each array + length.
const FLAT_FIXTURE: Building[] = [
  { id: 1, h: 12, poly: [[0, 0], [10, 0], [10, 10], [0, 10]] },
  { id: 2, h: 20, minH: 4, poly: [[20, 0], [40, 0], [40, 8], [28, 8], [28, 20], [20, 20]] },
  { id: 3, h: 7.5, poly: [[-30, -5], [-30, 15], [-10, 5]] },
];
const FLAT_FIXTURE_HEIGHT = (x: number, z: number): number => 0.01 * x - 0.02 * z;
const FLAT_CHECKSUM = {
  len: 333,
  pos: 3178.5999960303307,
  nor: 20.366563081741333,
  uv: 125.83300897479057,
  col: 104.7931089294143,
  groups: [
    { start: 0, count: 78, materialIndex: 0 },
    { start: 78, count: 33, materialIndex: 1 },
  ],
};

describe('roofs (wave 21, architecture §4.2 "Roofs + OSM facade data")', () => {
  it('1. gabled 20×10 m, h 15, roof.h 4, dir 90: peak base+15, eaves base+11, ridge at t=0, gable ends closed', () => {
    const base = 2;
    const m = buildBuildingsMesh([roofed({ shape: 'gabled', h: 4, dir: 90 })], () => base);
    let maxY = -Infinity;
    for (let i = 0; i < m.positions.length / 3; i++) maxY = Math.max(maxY, vtx(m, i)[1]);
    expect(maxY).toBeCloseTo(base + 15, 4);
    // Eaves: wall-top vertices on the long walls (z = 0 / z = 10).
    const [ws, we] = groupRange(m, 0);
    let eaves = 0;
    const gableTops = new Map<string, number>();
    for (let i = ws; i < we; i++) {
      const [x, y, z] = vtx(m, i);
      if (y <= base + 1e-6) continue;
      if (Math.abs(z) < 1e-6 || Math.abs(z - 10) < 1e-6) {
        expect(y).toBeCloseTo(base + 11, 4);
        eaves++;
      }
      if (Math.abs(x) < 1e-6 || Math.abs(x - 20) < 1e-6) gableTops.set(key2(x, z), y);
    }
    expect(eaves).toBeGreaterThan(0);
    // Gable-end walls peak at their midpoint (z = 5, t = 0).
    expect(gableTops.get(key2(0, 5))).toBeCloseTo(base + 15, 4);
    expect(gableTops.get(key2(20, 5))).toBeCloseTo(base + 15, 4);
    // Ridge: roof vertices at t = 0 (z = 5) reach base + 15.
    const [rs, re] = groupRange(m, 1);
    let ridge = 0;
    for (let i = rs; i < re; i++) {
      const [, y, z] = vtx(m, i);
      if (Math.abs(z - 5) < 1e-6) {
        expect(y).toBeCloseTo(base + 15, 4);
        ridge++;
      }
    }
    expect(ridge).toBeGreaterThan(0);
    // No vertical gap: every wall-top segment is a roof boundary edge (same 3D endpoints).
    const edges = roofEdgeCounts(m);
    for (const seg of wallTopSegments(m)) expect(edges.get(seg)).toBe(1);
  });

  it('2. hipped / pyramidal / skillion / round: f at every roof vertex matches the §4.2 formula and 0 ≤ f ≤ 1', () => {
    const cases: { roof: BuildingRoof; st: (x: number, z: number) => [number, number]; L: number; W: number }[] = [
      // dir 90: a = east → s = x − 10, t = z − 5, L = 10, W = 5.
      { roof: { shape: 'hipped', h: 4, dir: 90 }, st: (x, z) => [x - 10, z - 5], L: 10, W: 5 },
      { roof: { shape: 'pyramidal', h: 4, dir: 90 }, st: (x, z) => [x - 10, z - 5], L: 10, W: 5 },
      { roof: { shape: 'round', h: 4, dir: 90 }, st: (x, z) => [x - 10, z - 5], L: 10, W: 5 },
      // dir 0: a = north (0, −1), b = east → s = 5 − z, t = x − 10, L = 5, W = 10.
      { roof: { shape: 'skillion', h: 4, dir: 0 }, st: (x, z) => [5 - z, x - 10], L: 5, W: 10 },
      { roof: { shape: 'skillion', h: 4, dir: 90 }, st: (x, z) => [x - 10, z - 5], L: 10, W: 5 },
      // No dir: longest edge (0,0) → (20,0) → same frame as dir 90.
      { roof: { shape: 'hipped', h: 4 }, st: (x, z) => [x - 10, z - 5], L: 10, W: 5 },
    ];
    for (const c of cases) {
      const m = buildBuildingsMesh([roofed(c.roof)]);
      const [rs, re] = groupRange(m, 1);
      expect(re - rs).toBeGreaterThan(0);
      for (let i = rs; i < re; i++) {
        const [x, y, z] = vtx(m, i);
        const [s, t] = c.st(x, z);
        const f = (y - 11) / 4;
        expect(f).toBeGreaterThanOrEqual(-1e-4);
        expect(f).toBeLessThanOrEqual(1 + 1e-4);
        expect(f).toBeCloseTo(fieldFormula(c.roof.shape, s, t, c.L, c.W), 4);
      }
      // Every roof face looks up.
      for (let i = rs; i < re; i += 3) expect(m.normals[i * 3 + 1]!).toBeGreaterThan(0);
    }
  });

  it('3. conformity on an L-shaped footprint: every roof edge is shared by two roof triangles or is a wall-top segment (no T-junctions, no cracks)', () => {
    for (const shape of ['gabled', 'hipped', 'pyramidal', 'skillion', 'round'] as const) {
      const m = buildBuildingsMesh([roofed({ shape, h: 4 }, L_SHAPE)]);
      const edges = roofEdgeCounts(m);
      const tops = wallTopSegments(m);
      for (const [seg, count] of edges) {
        if (count === 1) expect(tops.has(seg), `${shape} ${seg}`).toBe(true);
        else expect(count, `${shape} ${seg}`).toBe(2);
      }
      expect(tops.size).toBeGreaterThanOrEqual(L_SHAPE.length);
      for (const seg of tops) expect(edges.get(seg), `${shape} wall top ${seg}`).toBe(1);
    }
  });

  it('4. dome and onion: lathe apex at base + h, onion max radius 1.25·R at 0.3·roof.h, a flat cap at wallTop', () => {
    const base = 1;
    // 20×20 square → R = min(L, W) = 10, centroid (10, 10); wallTop = base + 15 − 6.
    const SQ20: Vec2[] = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ];
    const wallTop = base + 9;
    for (const shape of ['dome', 'onion'] as const) {
      const m = buildBuildingsMesh([roofed({ shape, h: 6 }, SQ20)], () => base);
      const [ws, we] = groupRange(m, 0);
      for (let i = ws; i < we; i++) expect(vtx(m, i)[1]).toBeLessThanOrEqual(wallTop + 1e-4);
      const [rs, re] = groupRange(m, 1);
      // Flat cap: the first 2 roof triangles (square footprint), at wallTop, facing up.
      for (let i = rs; i < rs + 6; i++) {
        expect(vtx(m, i)[1]).toBeCloseTo(wallTop, 4);
        expect(m.normals[i * 3 + 1]!).toBeCloseTo(1);
      }
      let maxY = -Infinity;
      let maxR = 0;
      let yAtMaxR = 0;
      for (let i = rs + 6; i < re; i++) {
        const [x, y, z] = vtx(m, i);
        maxY = Math.max(maxY, y);
        const r = Math.hypot(x - 10, z - 10);
        if (r > maxR + 1e-9) {
          maxR = r;
          yAtMaxR = y;
        }
      }
      expect(maxY).toBeCloseTo(base + 15, 4);
      if (shape === 'onion') {
        expect(Math.abs(maxR - 12.5) / 12.5).toBeLessThan(0.02);
        expect(Math.abs(yAtMaxR - (wallTop + 0.3 * 6)) / (0.3 * 6)).toBeLessThan(0.02);
      } else {
        expect(maxR).toBeCloseTo(10, 4);
      }
      // Lathe faces point away from the axis (or up at the apex).
      for (let t = rs + 6; t < re; t += 3) {
        const p = [vtx(m, t), vtx(m, t + 1), vtx(m, t + 2)];
        const mx = (p[0]![0] + p[1]![0] + p[2]![0]) / 3 - 10;
        const mz = (p[0]![2] + p[1]![2] + p[2]![2]) / 3 - 10;
        const n = [m.normals[t * 3]!, m.normals[t * 3 + 1]!, m.normals[t * 3 + 2]!];
        expect(n[0]! * mx + n[2]! * mz + Math.max(0, n[1]!)).toBeGreaterThan(0);
      }
    }
  });

  it("5. curated shape: 'dome' + roof → the landmark cap, roof ignored", () => {
    const a = buildBuildingsMesh([squareBuilding({ shape: 'dome', h: 12 })]);
    const b = buildBuildingsMesh([squareBuilding({ shape: 'dome', h: 12, roof: { shape: 'gabled', h: 4, dir: 90 } })]);
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    expect(Array.from(b.normals)).toEqual(Array.from(a.normals));
    expect(b.groups).toEqual(a.groups);
  });

  it('6. extra: osmColor 0xff0000 + brick → walls (1, 0, 0, 1); roofColor only → roof colour, walls rgb −1; no OSM fields → extra undefined', () => {
    const plain = squareBuilding({ id: 0 });
    const brick = squareBuilding({ id: 1, osmColor: 0xff0000, material: 'brick' });
    const roofOnly = squareBuilding({ id: 2, roofColor: 0x00ff00, roof: { shape: 'gabled', h: 2 } });
    const m = buildBuildingsMesh([plain, brick, roofOnly]);
    const ex = m.extra;
    expect(ex).toBeDefined();
    if (!ex) return;
    const extraAt = (i: number): number[] => Array.from(ex.subarray(i * 4, i * 4 + 4));
    // Group 0: plain walls 24, brick walls 24, roofed walls follow.
    for (let i = 0; i < 24; i++) expect(extraAt(i)).toEqual([-1, -1, -1, 0]);
    for (let i = 24; i < 48; i++) arraysClose(extraAt(i), [1, 0, 0, MATERIAL_CODE.brick]);
    const [ws, we] = groupRange(m, 0);
    for (let i = 48; i < we; i++) expect(extraAt(i)).toEqual([-1, -1, -1, 0]);
    // Group 1: plain roof 6, brick roof 6 (rgb −1, brick), then the green roof.
    const [rs, re] = groupRange(m, 1);
    expect(ws).toBe(0);
    for (let i = rs; i < rs + 6; i++) expect(extraAt(i)).toEqual([-1, -1, -1, 0]);
    for (let i = rs + 6; i < rs + 12; i++) expect(extraAt(i)).toEqual([-1, -1, -1, 1]);
    for (let i = rs + 12; i < re; i++) arraysClose(extraAt(i), [0, 1, 0, 0]);
    expect(MATERIAL_CODE).toEqual({ brick: 1, stone: 2, concrete: 3, glass: 4, metal: 5, wood: 6, plaster: 7 });
    // sRGB → linear on the colour channels.
    const grey = buildBuildingsMesh([squareBuilding({ osmColor: 0x808080 })]).extra;
    expect(grey?.[0]).toBeCloseTo(((128 / 255 + 0.055) / 1.055) ** 2.4, 5);
    // A mesh without any OSM field has no extra attribute (roofed or not).
    expect(buildBuildingsMesh([plain, squareBuilding({ id: 3, roof: { shape: 'hipped', h: 2 } })]).extra).toBeUndefined();
  });

  it('7. budget: gabled 3 m roofs on every building of london tile 0_0 stay ≤ 1.25 × flat triangles + wall overhead', () => {
    const tile = JSON.parse(readFileSync('public/data/london/tiles/0_0.json', 'utf8')) as { buildings: Building[] };
    const flat = buildBuildingsMesh(tile.buildings);
    const roofedMesh = buildBuildingsMesh(tile.buildings.map((b) => ({ ...b, roof: { shape: 'gabled' as const, h: 3 } })));
    const tris = (m: MeshData, mat: number): number => {
      const [s, e] = groupRange(m, mat);
      return (e - s) / 3;
    };
    const flatTotal = tris(flat, 0) + tris(flat, 1);
    const roofTotal = tris(roofedMesh, 0) + tris(roofedMesh, 1);
    const wallOverhead = tris(roofedMesh, 0) - tris(flat, 0);
    console.log(
      `london 0_0 buildings=${tile.buildings.length} flat tris=${flatTotal} (walls ${tris(flat, 0)}, roofs ${tris(flat, 1)}) ` +
        `gabled tris=${roofTotal} (walls ${tris(roofedMesh, 0)}, roofs ${tris(roofedMesh, 1)}) ` +
        `bound=${1.25 * flatTotal + wallOverhead}`,
    );
    expect(roofTotal).toBeLessThanOrEqual(1.25 * flatTotal + wallOverhead);
  });

  it('8. unchanged: flat buildings are not densified and match the pre-wave-21 checksum', () => {
    const m = buildBuildingsMesh(FLAT_FIXTURE, FLAT_FIXTURE_HEIGHT);
    const sum = (a: Float32Array): number => {
      let t = 0;
      for (const v of a) t += v;
      return t;
    };
    expect(m.positions.length).toBe(FLAT_CHECKSUM.len);
    expect(sum(m.positions)).toBe(FLAT_CHECKSUM.pos);
    expect(sum(m.normals)).toBe(FLAT_CHECKSUM.nor);
    expect(sum(m.uvs)).toBe(FLAT_CHECKSUM.uv);
    expect(sum(m.colors)).toBe(FLAT_CHECKSUM.col);
    expect(m.groups).toEqual(FLAT_CHECKSUM.groups);
    expect(m.extra).toBeUndefined();
  });
});
