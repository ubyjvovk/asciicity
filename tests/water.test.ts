/**
 * Unit tests for `buildWaterMesh` (T-0024).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Vec2 } from '../src/data/types';
import { buildWaterMesh } from '../src/world/water';
import type { MeshData } from '../src/world/mesh';

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

function vertexCount(m: MeshData): number {
  return m.positions.length / 3;
}

function crossY(
  ax: number,
  _ay: number,
  az: number,
  bx: number,
  _by: number,
  bz: number,
  cx: number,
  _cy: number,
  cz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const acx = cx - ax;
  const acz = cz - az;
  return abz * acx - abx * acz;
}

describe('buildWaterMesh', () => {
  it('a 10×10 square ring → 2 triangles (6 vertices) at y = 0.02 with upward winding and normal (0,1,0)', () => {
    const m = buildWaterMesh([SQUARE]);
    expect(vertexCount(m)).toBe(6);
    for (let i = 1; i < m.positions.length; i += 3) {
      expect(m.positions[i]).toBeCloseTo(0.02);
    }
    for (let i = 0; i < m.normals.length; i += 3) {
      expect(m.normals[i]).toBeCloseTo(0);
      expect(m.normals[i + 1]).toBeCloseTo(1);
      expect(m.normals[i + 2]).toBeCloseTo(0);
    }
    const p = m.positions;
    for (let t = 0; t < 2; t++) {
      const i = t * 9;
      expect(
        crossY(
          p[i]!,
          p[i + 1]!,
          p[i + 2]!,
          p[i + 3]!,
          p[i + 4]!,
          p[i + 5]!,
          p[i + 6]!,
          p[i + 7]!,
          p[i + 8]!,
        ),
      ).toBeGreaterThan(0);
    }
  });

  it('a clockwise ring gives the same vertex count as its reverse', () => {
    const cw = buildWaterMesh([SQUARE_CW]);
    const ccw = buildWaterMesh([SQUARE_CW.slice().reverse()]);
    expect(vertexCount(cw)).toBe(vertexCount(ccw));
    expect(vertexCount(cw)).toBe(6);
  });

  it('a degenerate ring is skipped', () => {
    const twoPoint: Vec2[] = [
      [0, 0],
      [10, 0],
    ];
    const tiny: Vec2[] = [
      [0, 0],
      [0.5, 0],
      [0.5, 0.5],
      [0, 0.5],
    ];
    expect(vertexCount(buildWaterMesh([twoPoint]))).toBe(0);
    expect(vertexCount(buildWaterMesh([tiny]))).toBe(0);
    const mixed = buildWaterMesh([twoPoint, tiny, SQUARE]);
    expect(vertexCount(mixed)).toBe(6);
  });

  it('colour equals new THREE.Color(0x163a6b)', () => {
    const m = buildWaterMesh([SQUARE]);
    const expected = new THREE.Color(0x163a6b);
    expect(m.colors.length).toBe(6 * 3);
    for (let i = 0; i < m.colors.length; i += 3) {
      expect(m.colors[i]).toBeCloseTo(expected.r);
      expect(m.colors[i + 1]).toBeCloseTo(expected.g);
      expect(m.colors[i + 2]).toBeCloseTo(expected.b);
    }
  });

  it('a single group {start:0,count:N,materialIndex:0}', () => {
    const m = buildWaterMesh([SQUARE]);
    const n = vertexCount(m);
    expect(m.groups).toEqual([{ start: 0, count: n, materialIndex: 0 }]);
  });

  it('with levels = [2] every y = 2.3', () => {
    const m = buildWaterMesh([SQUARE], [2]);
    expect(vertexCount(m)).toBeGreaterThan(0);
    for (let i = 1; i < m.positions.length; i += 3) {
      expect(m.positions[i]).toBeCloseTo(2.3);
    }
  });

  it('without levels every y = 0.02', () => {
    const m = buildWaterMesh([SQUARE]);
    for (let i = 1; i < m.positions.length; i += 3) {
      expect(m.positions[i]).toBeCloseTo(0.02);
    }
  });

  it('levels shorter than rings throws an Error naming levels', () => {
    expect(() => buildWaterMesh([SQUARE, SQUARE], [2])).toThrow(Error);
    expect(() => buildWaterMesh([SQUARE, SQUARE], [2])).toThrow(/levels/);
  });
});
