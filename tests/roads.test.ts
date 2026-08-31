/**
 * Unit tests for `buildRoadsMesh` / `ROAD_WIDTH` (T-0005).
 */
import { describe, expect, it } from 'vitest';
import { loadSfGlobals } from './sfCity';
import * as THREE from 'three';
import type { CityData, HeightFn, Road, RoadClass } from '../src/data/types';
import { buildRoadsMesh, ROAD_LIFT, ROAD_WIDTH } from '../src/world/roads';
import { BridgeDecks, Terrain, makeGroundAt, type DeckHump } from '../src/world/terrain';
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
  it('a 2-point primary road of length 100 along +x yields 60 vertices whose z extent is exactly ±6 and y is ROAD_LIFT', () => {
    const m = buildRoadsMesh([road('primary', [[0, 0], [100, 0]])]);
    expect(vertexCount(m)).toBe(60);
    const z = zs(m);
    expect(Math.min(...z)).toBeCloseTo(-6);
    expect(Math.max(...z)).toBeCloseTo(6);
    for (const y of ys(m)) expect(y).toBeCloseTo(ROAD_LIFT);
  });

  it('a 3-point polyline yields 90 vertices', () => {
    const m = buildRoadsMesh([road('primary', [[0, 0], [100, 0], [100, 50]])]);
    expect(vertexCount(m)).toBe(90);
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
    expect(vertexCount(mixed)).toBe(60);
  });

  it('a single group {start:0, count:N, materialIndex:0}', () => {
    const m = buildRoadsMesh([
      road('primary', [[0, 0], [100, 0]]),
      road('footway', [[0, 20], [30, 20], [30, 40]]),
    ]);
    const n = vertexCount(m);
    expect(m.groups).toEqual([{ start: 0, count: n, materialIndex: 0 }]);
  });

  it('a 100 m primary segment yields 10 quads (60 vertices)', () => {
    const m = buildRoadsMesh([road('primary', [[0, 0], [100, 0]])]);
    expect(vertexCount(m)).toBe(60);
  });

  it('corner y = heightAt(corner) + 0.15 under heightAt = (x, z) => 0.1·x + 0.2·z (all four corners of the first quad)', () => {
    const heightAt = (x: number, z: number) => 0.1 * x + 0.2 * z;
    const m = buildRoadsMesh([road('primary', [[0, 0], [100, 0]])], heightAt);
    // First quad: unique corners at vertices 0,1,2,5 of the 6-vertex soup.
    const cornerIdx = [0, 1, 2, 5];
    const seen = new Set<string>();
    for (const v of cornerIdx) {
      const x = m.positions[v * 3]!;
      const y = m.positions[v * 3 + 1]!;
      const z = m.positions[v * 3 + 2]!;
      seen.add(`${x},${z}`);
      expect(y).toBeCloseTo(heightAt(x, z) + ROAD_LIFT);
    }
    expect(seen.size).toBe(4);
  });

  it('a 3-point bridge road over a dip has its middle vertex at lerp + 0.15 (both edges equal)', () => {
    const pts: [number, number][] = [
      [0, 0],
      [50, 0],
      [100, 0],
    ];
    const heightAt = (x: number, _z: number) => Math.abs(x - 50);
    const m = buildRoadsMesh([{ id: 1, cls: 'primary', pts, bridge: true }], heightAt);
    const ya = heightAt(pts[0]![0], pts[0]![1]);
    const yb = heightAt(pts[2]![0], pts[2]![1]);
    const midLerp = ya + (yb - ya) * 0.5;
    const leftYs: number[] = [];
    const rightYs: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i]! - 50) > 1e-9) continue;
      const y = m.positions[i + 1]!;
      const z = m.positions[i + 2]!;
      expect(y).toBeCloseTo(midLerp + ROAD_LIFT);
      if (z > 0) leftYs.push(y);
      else rightYs.push(y);
    }
    expect(leftYs.length).toBeGreaterThan(0);
    expect(rightYs.length).toBeGreaterThan(0);
    for (const y of leftYs) expect(y).toBeCloseTo(rightYs[0]!);
    for (const y of rightYs) expect(y).toBeCloseTo(leftYs[0]!);
  });

  it('default heightAt → every y = 0.15', () => {
    const m = buildRoadsMesh([
      road('primary', [[0, 0], [100, 0], [100, 50]]),
      road('residential', [[0, 10], [20, 10]]),
    ]);
    for (const y of ys(m)) expect(y).toBeCloseTo(ROAD_LIFT);
    expect(ROAD_LIFT).toBe(0.15);
  });

  it('a same-name bridge split into three pieces with underwater joints is draped as one deck', () => {
    // Abutments at x=0 (y=30) and x=300 (y=46); water at y=-24 between them.
    // The middle piece (x=100..200) sits entirely over water: profiled alone
    // it would drape from -24 → -24 + 0.15; chained through the abutments its
    // middle vertex must sit at the lerp of 30..46.
    const heightAt: HeightFn = (x, _z) => {
      if (x <= 0) return 30;
      if (x >= 300) return 46;
      return -24;
    };
    const pieces: Road[] = [
      { id: 1, cls: 'primary', name: 'Test Bridge', bridge: true, pts: [[0, 0], [100, 0]] },
      { id: 2, cls: 'primary', name: 'Test Bridge', bridge: true, pts: [[100, 0], [200, 0]] },
      { id: 3, cls: 'primary', name: 'Test Bridge', bridge: true, pts: [[200, 0], [300, 0]] },
    ];
    const m = buildRoadsMesh(pieces, heightAt);
    // Middle piece endpoints x=100 and x=200 sit at chain fractions 1/3 and 2/3.
    const ya = 30;
    const yb = 46;
    const yAt100 = ya + (yb - ya) * (100 / 300);
    const yAt200 = ya + (yb - ya) * (200 / 300);
    // Corner samples: collect ribbon ys at x=100 and x=200 exactly.
    const ysAt100: number[] = [];
    const ysAt200: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i]!;
      const y = m.positions[i + 1]!;
      if (Math.abs(x - 100) < 1e-9) ysAt100.push(y);
      if (Math.abs(x - 200) < 1e-9) ysAt200.push(y);
    }
    expect(ysAt100.length).toBeGreaterThan(0);
    expect(ysAt200.length).toBeGreaterThan(0);
    for (const y of ysAt100) expect(y).toBeCloseTo(yAt100 + ROAD_LIFT);
    for (const y of ysAt200) expect(y).toBeCloseTo(yAt200 + ROAD_LIFT);
    // And no ribbon vertex sits at the underwater lerp (−24 + 0.15).
    for (let i = 1; i < m.positions.length; i += 3) {
      expect(m.positions[i]!).toBeGreaterThan(0);
    }
  });

  it('bridge ribbons follow the hump', () => {
    const heightAt: HeightFn = () => 1;
    const pts: [number, number][] = [
      [0, 0],
      [50, 0],
      [100, 0],
    ];
    const humps: DeckHump[] = [{ names: ['Hump Span'], apexY: 11 }];
    const m = buildRoadsMesh(
      [{ id: 1, cls: 'primary', name: 'Hump Span', pts, bridge: true }],
      heightAt,
      humps,
    );
    const midYs: number[] = [];
    const endYs: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i]!;
      const y = m.positions[i + 1]!;
      if (Math.abs(x - 50) < 1e-9) midYs.push(y);
      if (Math.abs(x) < 1e-9 || Math.abs(x - 100) < 1e-9) endYs.push(y);
    }
    expect(midYs.length).toBeGreaterThan(0);
    expect(endYs.length).toBeGreaterThan(0);
    for (const y of midYs) expect(y).toBeCloseTo(11 + ROAD_LIFT, 5);
    for (const y of endYs) expect(y).toBeCloseTo(1 + ROAD_LIFT, 5);
    // A same-shape road not named in the hump stays on the straight lerp.
    const other = buildRoadsMesh(
      [{ id: 2, cls: 'primary', name: 'Other Span', pts, bridge: true }],
      heightAt,
      humps,
    );
    for (let i = 1; i < other.positions.length; i += 3) {
      expect(other.positions[i]!).toBeCloseTo(1 + ROAD_LIFT, 5);
    }
  });

  it('sf.json: every Golden Gate Bridge ribbon vertex is above 25 m', () => {
    const SF: CityData = loadSfGlobals();
    const terrain = SF.terrain ? new Terrain(SF.terrain) : undefined;
    const decks = terrain ? new BridgeDecks(SF.roads, terrain.heightAt) : undefined;
    const groundAt = makeGroundAt(terrain, decks);
    const ggb = SF.roads.filter(
      (r) =>
        r.bridge === true &&
        (r.name === 'Golden Gate Bridge' ||
          r.name === 'East Sidewalk' ||
          r.name === 'West Sidewalk'),
    );
    expect(ggb.length).toBeGreaterThan(0);
    const m = buildRoadsMesh(ggb, groundAt);
    for (let i = 1; i < m.positions.length; i += 3) {
      expect(m.positions[i]!).toBeGreaterThan(25);
    }
  });
});
