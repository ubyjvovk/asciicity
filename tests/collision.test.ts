/**
 * Unit tests for src/world/collision.ts (T-0007). Every case listed in the
 * ticket's acceptance criteria is covered here by name.
 */
import { describe, expect, it } from 'vitest';
import type { Building, Vec2 } from '../src/data/types';
import { CollisionGrid, distToSegment, pointInPolygon } from '../src/world/collision';

const square: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

// Concave "U" opening upward: the notch sits at x∈[2,4], z∈[1,3].
const uShape: Vec2[] = [
  [0, 0],
  [6, 0],
  [6, 3],
  [4, 3],
  [4, 1],
  [2, 1],
  [2, 3],
  [0, 3],
];

function reverse<T>(a: readonly T[]): T[] {
  return a.slice().reverse();
}

function makeBuilding(id: number, poly: Vec2[]): Building {
  return { id, h: 10, poly };
}

function rectBuilding(id: number, cx: number, cz: number, halfX: number, halfZ: number): Building {
  return makeBuilding(id, [
    [cx - halfX, cz - halfZ],
    [cx + halfX, cz - halfZ],
    [cx + halfX, cz + halfZ],
    [cx - halfX, cz + halfZ],
  ]);
}

describe('pointInPolygon', () => {
  it('is true inside a square and false outside', () => {
    expect(pointInPolygon([5, 5], square)).toBe(true);
    expect(pointInPolygon([-1, 5], square)).toBe(false);
    expect(pointInPolygon([15, 5], square)).toBe(false);
    expect(pointInPolygon([5, -1], square)).toBe(false);
    expect(pointInPolygon([5, 15], square)).toBe(false);
  });

  it('is false inside the notch of a concave U and true in the arms', () => {
    // Inside the notch — outside the polygon.
    expect(pointInPolygon([3, 2], uShape)).toBe(false);
    // Inside the left arm.
    expect(pointInPolygon([1, 2], uShape)).toBe(true);
    // Inside the right arm.
    expect(pointInPolygon([5, 2], uShape)).toBe(true);
    // Inside the base of the U.
    expect(pointInPolygon([3, 0.5], uShape)).toBe(true);
  });

  it('gives the same result for CCW and CW windings', () => {
    const cw = reverse(square);
    expect(pointInPolygon([5, 5], cw)).toBe(true);
    expect(pointInPolygon([15, 15], cw)).toBe(false);
    const uCw = reverse(uShape);
    expect(pointInPolygon([3, 2], uCw)).toBe(false);
    expect(pointInPolygon([1, 2], uCw)).toBe(true);
  });
});

describe('distToSegment', () => {
  const a: Vec2 = [0, 0];
  const b: Vec2 = [10, 0];

  it('is 0 at an endpoint', () => {
    expect(distToSegment(a, a, b)).toBeCloseTo(0);
    expect(distToSegment(b, a, b)).toBeCloseTo(0);
  });

  it('is the perpendicular distance when the foot lies on the segment', () => {
    expect(distToSegment([5, 3], a, b)).toBeCloseTo(3);
    expect(distToSegment([5, -4], a, b)).toBeCloseTo(4);
  });

  it('collapses to the endpoint distance when the foot lies beyond the segment', () => {
    // Beyond b: nearest point is b itself.
    expect(distToSegment([13, 4], a, b)).toBeCloseTo(5);
    // Before a: nearest point is a itself.
    expect(distToSegment([-3, 4], a, b)).toBeCloseTo(5);
  });
});

describe('CollisionGrid.blocked', () => {
  const b = rectBuilding(1, 0, 0, 5, 5); // footprint [-5,-5]..[5,5]
  const grid = new CollisionGrid([b], 25);

  it('is true inside a footprint', () => {
    expect(grid.blocked([0, 0])).toBe(true);
  });

  it('is true 0.5 m outside an edge with r=0.6', () => {
    expect(grid.blocked([5.5, 0], 0.6)).toBe(true);
    expect(grid.blocked([0, -5.5], 0.6)).toBe(true);
  });

  it('is false 1 m outside an edge with the default radius', () => {
    expect(grid.blocked([6, 0])).toBe(false);
    expect(grid.blocked([0, 6])).toBe(false);
  });

  it('is false far away', () => {
    expect(grid.blocked([500, 500])).toBe(false);
    expect(grid.blocked([-1000, 0])).toBe(false);
  });
});

describe('CollisionGrid cell coverage', () => {
  it('finds a multi-cell footprint from every cell it covers', () => {
    // 90×30 m footprint centred on origin → x cells -2..1, z cells -1..0
    // with cell=25 (plus 1 m expansion). Probe an inside point per cell.
    const big = rectBuilding(1, 0, 0, 45, 15);
    const grid = new CollisionGrid([big], 25);
    const probes: Vec2[] = [
      [-40, -10], // cell (-2, -1)
      [-20, -10], // cell (-1, -1)
      [10, -10], //  cell ( 0, -1)
      [30, -10], //  cell ( 1, -1)
      [-40, 10], //  cell (-2,  0)
      [-20, 10], //  cell (-1,  0)
      [10, 10], //   cell ( 0,  0)
      [30, 10], //   cell ( 1,  0)
    ];
    for (const p of probes) {
      expect(grid.blocked(p), `expected blocked at ${p.join(',')}`).toBe(true);
    }
  });
});

describe('CollisionGrid.resolve', () => {
  // Building covering only the destination's z-strip: `to` and `[from.x, to.z]`
  // both sit inside it, but `[to.x, from.z]` is south of it and free.
  const zStrip = rectBuilding(1, 0, 3, 100, 1); // z ∈ [2, 4], x ∈ [-100, 100]
  // Building covering only the destination's x-strip: `to` and `[to.x, from.z]`
  // both sit inside it, but `[from.x, to.z]` is west of it and free.
  const xStrip = rectBuilding(2, 3, 0, 1, 100); // x ∈ [2, 4], z ∈ [-100, 100]

  it('returns `to` when the destination is free', () => {
    const grid = new CollisionGrid([zStrip], 25);
    const from: Vec2 = [-3, -3];
    const to: Vec2 = [3, -3]; // stays south of the strip
    expect(grid.resolve(from, to)).toEqual(to);
  });

  it('slides to [to.x, from.z] when only the z-move is blocked', () => {
    // Only the z-strip present → the x-only fallback keeps us south of it.
    const grid = new CollisionGrid([zStrip], 25);
    const from: Vec2 = [-3, -3];
    const to: Vec2 = [3, 3]; // sits inside zStrip → blocked
    const out = grid.resolve(from, to);
    expect(out[0]).toBeCloseTo(to[0]);
    expect(out[1]).toBeCloseTo(from[1]);
  });

  it('slides to [from.x, to.z] when only the x-move is blocked', () => {
    // Only the x-strip present → `[to.x, from.z]` still lies inside it, so
    // resolve falls through to the z-only slide `[from.x, to.z]`.
    const grid = new CollisionGrid([xStrip], 25);
    const from: Vec2 = [-3, -3];
    const to: Vec2 = [3, 3];
    const out = grid.resolve(from, to);
    expect(out[0]).toBeCloseTo(from[0]);
    expect(out[1]).toBeCloseTo(to[1]);
  });

  it('returns `from` when cornered', () => {
    // Both strips together: `to`, `[to.x, from.z]`, and `[from.x, to.z]` are
    // all blocked → no legal partial move remains.
    const grid = new CollisionGrid([zStrip, xStrip], 25);
    const from: Vec2 = [-3, -3];
    const to: Vec2 = [3, 3];
    expect(grid.resolve(from, to)).toEqual(from);
  });
});

describe('CollisionGrid performance', () => {
  it('answers 10000 blocked queries against 5000 buildings in under 200 ms', () => {
    const buildings: Building[] = [];
    // 100 × 50 grid = 5000 buildings; each 8×8 m, spaced 20 m apart in a
    // 2000 × 1000 m area.
    let id = 1;
    for (let ix = 0; ix < 100; ix++) {
      for (let iz = 0; iz < 50; iz++) {
        const cx = ix * 20 + 4;
        const cz = iz * 20 + 4;
        buildings.push(rectBuilding(id++, cx, cz, 4, 4));
      }
    }
    const grid = new CollisionGrid(buildings, 25);

    // Deterministic pseudo-random probes across the covered area (mulberry32).
    let s = 0x9e3779b9;
    const rand = (): number => {
      s = (s + 0x6d2b79f5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const probes: Vec2[] = [];
    for (let i = 0; i < 10000; i++) {
      probes.push([rand() * 2000, rand() * 1000]);
    }

    const t0 = performance.now();
    let hits = 0;
    for (const p of probes) {
      if (grid.blocked(p)) hits++;
    }
    const dt = performance.now() - t0;

    expect(hits).toBeGreaterThanOrEqual(0);
    expect(dt).toBeLessThan(200);
  });
});
