/**
 * Unit tests for `buildRoadsMesh` / `ROAD_WIDTH` (T-0005).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Road, RoadClass } from '../src/data/types';
import { buildRoadsMesh, ROAD_WIDTH } from '../src/world/roads';
import type { MeshData } from '../src/world/mesh';

function road(cls: RoadClass, pts: [number, number][], id = 1): Road {
  return { id, cls, pts };
}

function vertexCount(m: MeshData): number {
  return m.positions.length / 3;
}

function zs(m: MeshData): number[] {
  const out: number[] = [];
  for (let i = 2; i < m.positions.length; i += 3) out.push(m.positions[i]);
  return out;
}

function ys(m: MeshData): number[] {
  const out: number[] = [];
  for (let i = 1; i < m.positions.length; i += 3) out.push(m.positions[i]);
  return out;
}

function crossY(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const acx = cx - ax;
  const acz = cz - az;
  return abz * acx - abx * acz;
}

describe('ROAD_WIDTH', () => {
  it('ROAD_WIDTH matches §4.5 exactly', () => {
    expect(ROAD_WIDTH).toEqual({
      primary: 12,
      secondary: 9,
      tertiary: 7,
      residential: 6,
      service: 4,
      pedestrian: 4,
      footway: 2,
    });
  });
});

describe('buildRoadsMesh', () => {
  it('a 2-point primary road of length 100 along +x yields 6 vertices whose z extent is exactly ±6 and y is 0.05', () => {
    const m = buildRoadsMesh([road('primary', [[0, 0], [100, 0]])]);
    expect(vertexCount(m)).toBe(6);
    const z = zs(m);
    expect(Math.min(...z)).toBeCloseTo(-6);
    expect(Math.max(...z)).toBeCloseTo(6);
    for (const y of ys(m)) expect(y).toBeCloseTo(0.05);
  });

  it('a 3-point polyline yields 12 vertices', () => {
    const m = buildRoadsMesh([road('primary', [[0, 0], [100, 0], [100, 50]])]);
    expect(vertexCount(m)).toBe(12);
  });

  it('every normal is (0,1,0) and every triangle winds upward (cross(...).y > 0)', () => {
    const m = buildRoadsMesh([
      road('primary', [[0, 0], [100, 0], [100, 50]]),
      road('residential', [[0, 10], [20, 10]]),
    ]);
    for (let i = 0; i < m.normals.length; i += 3) {
      expect(m.normals[i]).toBeCloseTo(0);
      expect(m.normals[i + 1]).toBeCloseTo(1);
      expect(m.normals[i + 2]).toBeCloseTo(0);
    }
    const p = m.positions;
    const triCount = vertexCount(m) / 3;
    for (let t = 0; t < triCount; t++) {
      const i = t * 9;
      const y = crossY(
        p[i], p[i + 1], p[i + 2],
        p[i + 3], p[i + 4], p[i + 5],
        p[i + 6], p[i + 7], p[i + 8],
      );
      expect(y).toBeGreaterThan(0);
    }
  });

  it('colour is 0x585858 (linear via THREE.Color) for primary/secondary and 0x404040 for the others', () => {
    const major = new THREE.Color(0x585858);
    const minor = new THREE.Color(0x404040);
    const classes: RoadClass[] = [
      'primary',
      'secondary',
      'tertiary',
      'residential',
      'service',
      'pedestrian',
      'footway',
    ];
    for (const cls of classes) {
      const m = buildRoadsMesh([road(cls, [[0, 0], [10, 0]])]);
      const expected = cls === 'primary' || cls === 'secondary' ? major : minor;
      for (let i = 0; i < m.colors.length; i += 3) {
        expect(m.colors[i]).toBeCloseTo(expected.r);
        expect(m.colors[i + 1]).toBeCloseTo(expected.g);
        expect(m.colors[i + 2]).toBeCloseTo(expected.b);
      }
    }
  });

  it('a road with identical consecutive points contributes no degenerate quad (segment length 0 is skipped)', () => {
    const skipped = buildRoadsMesh([road('primary', [[0, 0], [0, 0]])]);
    expect(vertexCount(skipped)).toBe(0);
    const mixed = buildRoadsMesh([road('primary', [[0, 0], [0, 0], [100, 0]])]);
    expect(vertexCount(mixed)).toBe(6);
  });

  it('a single group {start:0, count:N, materialIndex:0}', () => {
    const m = buildRoadsMesh([
      road('primary', [[0, 0], [100, 0]]),
      road('footway', [[0, 20], [30, 20], [30, 40]]),
    ]);
    const n = vertexCount(m);
    expect(m.groups).toEqual([{ start: 0, count: n, materialIndex: 0 }]);
  });
});
