/**
 * Unit tests for src/world/collision.ts (T-0007). Every case listed in the
 * ticket's acceptance criteria is covered here by name.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Building, CityData, Vec2 } from '../src/data/types';
import {
  CollisionGrid,
  distToSegment,
  pointInPolygon,
  type Corridor,
} from '../src/world/collision';

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

describe('CollisionGrid corridors (T-0030)', () => {
  // “Water” here is just a footprint (collision treats water rings as fake
  // footprints); a corridor crossing it must override it.
  const footprint = rectBuilding(1, 5, 5, 5, 5); // [0,0]..[10,10]
  const bridge: Corridor = {
    pts: [
      [-5, 5],
      [15, 5],
    ],
    halfWidth: 2,
  };

  it('does not block a point on a corridor that crosses a water footprint', () => {
    const grid = new CollisionGrid([footprint], 25, [bridge]);
    // Dead centre of the footprint AND on the corridor centre-line.
    expect(grid.blocked([5, 5], 0.6)).toBe(false);
    // Offset on the corridor but still over the footprint.
    expect(grid.blocked([2, 5], 0.6)).toBe(false);
  });

  it('blocks a point 2 m outside the corridor over the same footprint', () => {
    const grid = new CollisionGrid([footprint], 25, [bridge]);
    // halfWidth=2 → corridor spans z∈[3,7]; z=9 is 2 m beyond the corridor
    // edge and still inside the footprint → blocked.
    expect(grid.blocked([5, 9], 0.6)).toBe(true);
    // Same distance on the south side.
    expect(grid.blocked([5, 1], 0.6)).toBe(true);
  });

  it('blocks a point off the corridor even when the segment passes nearby', () => {
    const grid = new CollisionGrid([footprint], 25, [bridge]);
    // Edge of the corridor (dist 2 = halfWidth) is not blocked…
    expect(grid.blocked([5, 7], 0.6)).toBe(false);
    // …but clearly past it is.
    expect(grid.blocked([5, 10.5], 0.6)).toBe(true);
  });

  it('honours a corridor spanning several cells from every cell it covers', () => {
    const bigFoot = rectBuilding(1, 0, 0, 60, 40); // [-60,-40]..[60,40]
    const longCorridor: Corridor = {
      pts: [
        [-50, 0],
        [50, 0],
      ],
      halfWidth: 2,
    };
    const grid = new CollisionGrid([bigFoot], 25, [longCorridor]);
    // One probe per x-cell the corridor spans (cell = 25 → cx −2..1).
    const probes: Vec2[] = [
      [-40, 0],
      [-20, 0],
      [10, 0],
      [30, 0],
    ];
    for (const p of probes) {
      expect(grid.blocked(p, 0.6), `expected free on corridor at ${p.join(',')}`).toBe(false);
    }
    // Off the corridor but still inside the footprint → blocked.
    expect(grid.blocked([0, 30], 0.6)).toBe(true);
  });

  it('does not unblock a footprint when the corridor is far away', () => {
    const farCorridor: Corridor = {
      pts: [
        [-5, -5],
        [5, -5],
      ],
      halfWidth: 1,
    };
    const grid = new CollisionGrid([footprint], 25, [farCorridor]);
    expect(grid.blocked([5, 5], 0.6)).toBe(true); // centre of footprint, far from corridor
  });
});

describe('CollisionGrid water rings (T-0078 parity)', () => {
  // Outer square ring (Bay) covering [-50, 50] × [-50, 50].
  const outer: Vec2[] = [
    [-50, -50],
    [50, -50],
    [50, 50],
    [-50, 50],
  ];
  // Nested inner ring (island) covering [-10, 10] × [-10, 10] — walkable land
  // by the odd-parity rule (inside two rings ⇒ even ⇒ not water).
  const inner: Vec2[] = [
    [-10, -10],
    [10, -10],
    [10, 10],
    [-10, 10],
  ];

  it('a point inside one water ring is blocked', () => {
    const grid = new CollisionGrid([], 25, [], [outer]);
    // Well inside the ring and far from any edge — the parity test alone must
    // return blocked (odd number of enclosing rings = 1).
    expect(grid.blocked([0, 0], 0.6)).toBe(true);
    expect(grid.blocked([30, 30], 0.6)).toBe(true);
    // Outside the ring is free.
    expect(grid.blocked([100, 100], 0.6)).toBe(false);
  });

  it('a point inside an island ring nested in a water ring is walkable (odd parity)', () => {
    const grid = new CollisionGrid([], 25, [], [outer, inner]);
    // Origin sits inside both rings → count = 2 → even → land, walkable.
    expect(grid.blocked([0, 0], 0.6)).toBe(false);
    // A point in the ring but off the island is still water.
    expect(grid.blocked([30, 30], 0.6)).toBe(true);
    // Outside both rings is free (open land).
    expect(grid.blocked([100, 100], 0.6)).toBe(false);
  });

  it('a point within r of an island shore is blocked from both sides', () => {
    const grid = new CollisionGrid([], 25, [], [outer, inner]);
    // Just outside the island edge (over water side, x = 10.4, |dx| = 0.4 < r).
    expect(grid.blocked([10.4, 0], 0.6)).toBe(true);
    // Just inside the island edge (over land side, x = 9.6, |dx| = 0.4 < r).
    expect(grid.blocked([9.6, 0], 0.6)).toBe(true);
    // A metre inside the island is walkable land again.
    expect(grid.blocked([9, 0], 0.6)).toBe(false);
    // A metre out into the Bay is clearly water.
    expect(grid.blocked([11, 0], 0.6)).toBe(true);
  });

  it('a bridge corridor over water stays walkable with parity water', () => {
    const bridge: Corridor = {
      pts: [
        [-60, 0],
        [60, 0],
      ],
      halfWidth: 3,
    };
    const grid = new CollisionGrid([], 25, [bridge], [outer]);
    // Dead centre of the ring (would be water) but on the corridor → free.
    expect(grid.blocked([0, 0], 0.6)).toBe(false);
    // Off the corridor but still inside the ring → blocked.
    expect(grid.blocked([0, 20], 0.6)).toBe(true);
  });

  it('Alcatraz: the lighthouse centroid is land and a point 300 m south of it is water', () => {
    const SF: CityData = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'public', 'data', 'sf.json'), 'utf8'),
    );
    const lighthouse = SF.buildings.find((b) => b.name === 'Alcatraz Island Lighthouse');
    expect(lighthouse).toBeDefined();
    // Centroid of the lighthouse footprint.
    let cx = 0;
    let cz = 0;
    for (const v of lighthouse!.poly) {
      cx += v[0];
      cz += v[1];
    }
    cx /= lighthouse!.poly.length;
    cz /= lighthouse!.poly.length;
    // Buildings excluded; just water rings + parity test — the ticket contract.
    const grid = new CollisionGrid([], 25, [], SF.water ?? []);
    // Inside the Bay ring AND the Alcatraz island ring (count = 2 = even) → land.
    expect(grid.blocked([cx, cz], 0.6)).toBe(false);
    // 300 m south (positive z per §3) sits in the Bay only → odd → water.
    expect(grid.blocked([cx, cz + 300], 0.6)).toBe(true);
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
