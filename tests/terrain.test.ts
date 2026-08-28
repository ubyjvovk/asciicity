/**
 * Unit tests for src/world/terrain.ts (T-0042). Every case listed in the
 * ticket's acceptance criteria is covered here by name.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CityData, HeightFn, Road, TerrainData, Vec2 } from '../src/data/types';
import {
  BridgeDecks,
  Terrain,
  bridgeProfile,
  buildTerrainGeometry,
  chainBridgeRoads,
  makeGroundAt,
  terrainHeightAt,
} from '../src/world/terrain';

function grid(
  cols: number,
  rows: number,
  heights: number[],
  opts?: { x0?: number; z0?: number; step?: number; datum?: number },
): TerrainData {
  return {
    x0: opts?.x0 ?? 0,
    z0: opts?.z0 ?? 0,
    step: opts?.step ?? 10,
    cols,
    rows,
    datum: opts?.datum ?? 0,
    heights,
  };
}

/** Asymmetric 2×2 so the two triangles disagree off the diagonal. */
const ASYM = grid(2, 2, [0, 10, 100, 5], { step: 1 });

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRoad(partial: Partial<Road> & Pick<Road, 'pts'>): Road {
  return { id: 1, cls: 'primary', ...partial };
}

describe('terrainHeightAt', () => {
  it('terrainHeightAt returns node heights exactly at nodes', () => {
    const t = ASYM;
    expect(terrainHeightAt(t, 0, 0)).toBe(0);
    expect(terrainHeightAt(t, 1, 0)).toBe(10);
    expect(terrainHeightAt(t, 0, 1)).toBe(100);
    expect(terrainHeightAt(t, 1, 1)).toBe(5);
    const offset = grid(2, 3, [1, 2, 3, 4, 5, 6], { x0: -20, z0: 40, step: 5 });
    expect(terrainHeightAt(offset, -20, 40)).toBe(1);
    expect(terrainHeightAt(offset, -15, 40)).toBe(2);
    expect(terrainHeightAt(offset, -20, 45)).toBe(3);
    expect(terrainHeightAt(offset, -15, 50)).toBe(6);
  });

  it('the diagonal midpoint of a cell equals (h00 + h11) / 2', () => {
    expect(terrainHeightAt(ASYM, 0.5, 0.5)).toBeCloseTo((0 + 5) / 2, 12);
    const t = grid(3, 2, [2, 8, 1, 4, 0, 6], { x0: 10, z0: -5, step: 4 });
    const h00 = 8;
    const h11 = 6;
    expect(terrainHeightAt(t, 10 + 4 + 2, -5 + 2)).toBeCloseTo((h00 + h11) / 2, 12);
  });

  it('a point with fu > fv uses h10 and one with fu < fv uses h01 (asymmetric 2×2 grid)', () => {
    // fu=0.6, fv=0.2 → h00 + fu*(h10-h00) + fv*(h11-h10) = 6 + 0.2*(5-10) = 5
    expect(terrainHeightAt(ASYM, 0.6, 0.2)).toBeCloseTo(5, 12);
    const otherFuGtFv = 0 + 0.2 * (100 - 0) + 0.6 * (5 - 100);
    expect(terrainHeightAt(ASYM, 0.6, 0.2)).not.toBeCloseTo(otherFuGtFv, 5);
    // fu=0.2, fv=0.6 → h00 + fv*(h01-h00) + fu*(h11-h01) = 60 + 0.2*(5-100) = 41
    expect(terrainHeightAt(ASYM, 0.2, 0.6)).toBeCloseTo(41, 12);
    const otherFuLtFv = 0 + 0.2 * (10 - 0) + 0.6 * (5 - 10);
    expect(terrainHeightAt(ASYM, 0.2, 0.6)).not.toBeCloseTo(otherFuLtFv, 5);
  });

  it('points outside the grid clamp to the edge value on all four sides', () => {
    // west, east, north, south — node-aligned and mid-edge
    expect(terrainHeightAt(ASYM, -10, 0)).toBe(0);
    expect(terrainHeightAt(ASYM, -10, 1)).toBe(100);
    expect(terrainHeightAt(ASYM, 10, 0)).toBe(10);
    expect(terrainHeightAt(ASYM, 10, 1)).toBe(5);
    expect(terrainHeightAt(ASYM, 0, -10)).toBe(0);
    expect(terrainHeightAt(ASYM, 1, -10)).toBe(10);
    expect(terrainHeightAt(ASYM, 0, 10)).toBe(100);
    expect(terrainHeightAt(ASYM, 1, 10)).toBe(5);
    expect(terrainHeightAt(ASYM, 0.5, -4)).toBeCloseTo(terrainHeightAt(ASYM, 0.5, 0), 12);
    expect(terrainHeightAt(ASYM, 0.5, 9)).toBeCloseTo(terrainHeightAt(ASYM, 0.5, 1), 12);
    expect(terrainHeightAt(ASYM, -4, 0.5)).toBeCloseTo(terrainHeightAt(ASYM, 0, 0.5), 12);
    expect(terrainHeightAt(ASYM, 9, 0.5)).toBeCloseTo(terrainHeightAt(ASYM, 1, 0.5), 12);
  });

  it('a grid filled from the plane h = 2x + 3z reproduces the plane at 20 random points to 1e-9', () => {
    const x0 = -3;
    const z0 = 2;
    const step = 1.5;
    const cols = 6;
    const rows = 5;
    const heights: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = x0 + c * step;
        const z = z0 + r * step;
        heights.push(2 * x + 3 * z);
      }
    }
    const t = grid(cols, rows, heights, { x0, z0, step });
    const rand = mulberry32(42);
    const xMax = x0 + (cols - 1) * step;
    const zMax = z0 + (rows - 1) * step;
    for (let i = 0; i < 20; i++) {
      const x = x0 + rand() * (xMax - x0);
      const z = z0 + rand() * (zMax - z0);
      const got = terrainHeightAt(t, x, z);
      const want = 2 * x + 3 * z;
      expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-9);
    }
  });
});

describe('Terrain', () => {
  it('Terrain.min/`max`', () => {
    const t = new Terrain(grid(2, 2, [1.5, -4, 9, 0.25]));
    expect(t.min).toBe(-4);
    expect(t.max).toBe(9);
    expect(t.heightAt(0, 0)).toBe(1.5);
    expect(t.data.cols).toBe(2);
  });
});

describe('buildTerrainGeometry', () => {
  it('buildTerrainGeometry has cols·rows vertices and 6·(cols−1)·(rows−1) indices', () => {
    const cols = 5;
    const rows = 4;
    const heights = new Array(cols * rows).fill(0);
    const geo = buildTerrainGeometry(grid(cols, rows, heights, { step: 8 }));
    expect(geo.getAttribute('position').count).toBe(cols * rows);
    expect(geo.getIndex()!.count).toBe(6 * (cols - 1) * (rows - 1));
  });

  it("every triangle's cross(b−a, c−a).y > 0", () => {
    const t = grid(3, 3, [0, 1, 2, 4, 3, 8, -1, 5, 2], { x0: -4, z0: 7, step: 3 });
    const geo = buildTerrainGeometry(t);
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
      const ia = idx.getX(i);
      const ib = idx.getX(i + 1);
      const ic = idx.getX(i + 2);
      const ax = pos.getX(ia);
      const az = pos.getZ(ia);
      const bx = pos.getX(ib);
      const bz = pos.getZ(ib);
      const cx = pos.getX(ic);
      const cz = pos.getZ(ic);
      const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      expect(crossY).toBeGreaterThan(0);
    }
  });

  it('a flat grid gives normals (0,1,0) and every colour component 1.0', () => {
    const geo = buildTerrainGeometry(grid(4, 3, new Array(12).fill(7), { step: 20 }));
    const n = geo.getAttribute('normal');
    const col = geo.getAttribute('color');
    expect(n.count).toBe(12);
    expect(col.count).toBe(12);
    for (let i = 0; i < n.count; i++) {
      expect(n.getX(i)).toBeCloseTo(0, 10);
      expect(n.getY(i)).toBeCloseTo(1, 10);
      expect(n.getZ(i)).toBeCloseTo(0, 10);
      expect(col.getX(i)).toBeCloseTo(1, 10);
      expect(col.getY(i)).toBeCloseTo(1, 10);
      expect(col.getZ(i)).toBeCloseTo(1, 10);
    }
  });

  it('a plane tilted away from L gives colours < 1', () => {
    // y = x → n points toward −x, opposite L's +x; s = 0.6 + 0.5·max(0, n·L) < 1
    const cols = 4;
    const rows = 3;
    const x0 = 0;
    const z0 = 0;
    const step = 5;
    const heights: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        heights.push(x0 + c * step);
      }
    }
    const geo = buildTerrainGeometry(grid(cols, rows, heights, { x0, z0, step }));
    const col = geo.getAttribute('color');
    for (let i = 0; i < col.count; i++) {
      expect(col.getX(i)).toBeLessThan(1);
      expect(col.getY(i)).toBeLessThan(1);
      expect(col.getZ(i)).toBeLessThan(1);
    }
  });

  it('vertex (c, r) has uv = (x/40, z/40)', () => {
    const x0 = -12;
    const z0 = 8;
    const step = 15;
    const cols = 3;
    const rows = 2;
    const geo = buildTerrainGeometry(
      grid(cols, rows, [0, 1, 2, 3, 4, 5], { x0, z0, step }),
    );
    const uv = geo.getAttribute('uv');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const x = x0 + c * step;
        const z = z0 + r * step;
        expect(uv.getX(i)).toBeCloseTo(x / 40, 5);
        expect(uv.getY(i)).toBeCloseTo(z / 40, 5);
      }
    }
  });

  it('terrainHeightAt at the centroid of every triangle of a random 4×3 grid equals the average of that triangle\'s three vertex heights (sampler ≡ mesh)', () => {
    const cols = 4;
    const rows = 3;
    const x0 = 11;
    const z0 = -6;
    const step = 7;
    const rand = mulberry32(7);
    const heights: number[] = [];
    for (let i = 0; i < cols * rows; i++) heights.push(rand() * 40 - 10);
    const t = grid(cols, rows, heights, { x0, z0, step });
    const geo = buildTerrainGeometry(t);
    const idx = geo.getIndex()!;
    expect(idx.count).toBe(6 * (cols - 1) * (rows - 1));
    const vertexAt = (vi: number) => {
      const c = vi % cols;
      const r = Math.floor(vi / cols);
      return { x: x0 + c * step, z: z0 + r * step, y: heights[vi]! };
    };
    for (let i = 0; i < idx.count; i += 3) {
      const a = vertexAt(idx.getX(i));
      const b = vertexAt(idx.getX(i + 1));
      const c = vertexAt(idx.getX(i + 2));
      const mx = (a.x + b.x + c.x) / 3;
      const mz = (a.z + b.z + c.z) / 3;
      const avgY = (a.y + b.y + c.y) / 3;
      expect(terrainHeightAt(t, mx, mz)).toBeCloseTo(avgY, 9);
    }
  });
});

describe('bridgeProfile', () => {
  it('bridgeProfile on a 2-point polyline → [ya, yb]', () => {
    const heightAt: HeightFn = (x, z) => 2 * x + z;
    const pts: Vec2[] = [
      [0, 0],
      [8, 6],
    ];
    expect(bridgeProfile(pts, heightAt)).toEqual([0, 22]);
  });

  it('a 3-point polyline over a dip → middle = lerp', () => {
    const heightAt: HeightFn = (x, _z) => (x === 10 ? -5 : 0);
    const pts: Vec2[] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ];
    const ys = bridgeProfile(pts, heightAt);
    expect(ys[0]).toBe(0);
    expect(ys[2]).toBe(0);
    expect(ys[1]).toBe(0);
    expect(ys[1]).toBe(0 + (0 - 0) * 0.5);
  });

  it('over a bump → middle = terrain', () => {
    const heightAt: HeightFn = (x, _z) => (x === 10 ? 7 : 1);
    const pts: Vec2[] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ];
    const ys = bridgeProfile(pts, heightAt);
    expect(ys[0]).toBe(1);
    expect(ys[2]).toBe(1);
    expect(ys[1]).toBe(7);
  });
});

describe('BridgeDecks', () => {
  it('BridgeDecks.deckAt mid-span returns the lerp', () => {
    const heightAt: HeightFn = (x, _z) => x;
    const decks = new BridgeDecks(
      [makeRoad({ bridge: true, pts: [[0, 0], [20, 0]] })],
      heightAt,
    );
    expect(decks.deckAt([10, 0])).toBeCloseTo(10, 12);
    expect(decks.deckAt([5, 0])).toBeCloseTo(5, 12);
  });

  it('a point beyond the half-width returns undefined', () => {
    const decks = new BridgeDecks(
      [makeRoad({ bridge: true, cls: 'primary', pts: [[0, 0], [20, 0]] })],
      () => 4,
    );
    // primary half-width = 12/2 + 1 = 7
    expect(decks.deckAt([10, 8])).toBeUndefined();
    expect(decks.deckAt([10, 20])).toBeUndefined();
    expect(decks.deckAt([10, 7])).toBeCloseTo(4, 12);
  });

  it('non-bridge roads are ignored', () => {
    const decks = new BridgeDecks(
      [
        makeRoad({ pts: [[0, 0], [20, 0]] }),
        makeRoad({ id: 2, bridge: false, pts: [[0, 5], [20, 5]] }),
      ],
      () => 9,
    );
    expect(decks.deckAt([10, 0])).toBeUndefined();
    expect(decks.deckAt([10, 5])).toBeUndefined();
  });

  it('two overlapping decks return the max', () => {
    const heightAt: HeightFn = (_x, z) => (Math.abs(z) >= 10 ? 8 : 3);
    const decks = new BridgeDecks(
      [
        makeRoad({ id: 1, bridge: true, pts: [[0, 0], [20, 0]] }),
        makeRoad({ id: 2, bridge: true, pts: [[10, -10], [10, 10]] }),
      ],
      heightAt,
    );
    expect(decks.deckAt([10, 0])).toBeCloseTo(8, 12);
  });
});

describe('chainBridgeRoads', () => {
  it('chainBridgeRoads joins three same-name bridge pieces given in shuffled order, reversing one', () => {
    // The bridge runs x = 0..60: A [0→20], B reversed [40→20], C [40→60].
    const A: Road = makeRoad({ id: 1, name: 'Span', bridge: true, pts: [[0, 0], [20, 0]] });
    const B: Road = makeRoad({ id: 2, name: 'Span', bridge: true, pts: [[40, 0], [20, 0]] });
    const C: Road = makeRoad({ id: 3, name: 'Span', bridge: true, pts: [[40, 0], [60, 0]] });
    const out = chainBridgeRoads([C, B, A]);
    const chains = out.filter((r) => r.name === 'Span');
    expect(chains).toHaveLength(1);
    expect(chains[0]!.pts).toEqual([[0, 0], [20, 0], [40, 0], [60, 0]]);
    // A.start … C.end, no duplicated joint vertex (4 unique points, not 6).
    expect(chains[0]!.pts).toHaveLength(4);
    expect(chains[0]!.id).toBe(3);
  });

  it('chainBridgeRoads leaves unnamed, differently named and non-bridge roads alone', () => {
    const unnamed = makeRoad({ id: 1, bridge: true, pts: [[0, 0], [10, 0]] });
    const diffName = makeRoad({ id: 2, name: 'Alpha', bridge: true, pts: [[0, 0], [10, 0]] });
    const nonBridge = makeRoad({ id: 3, name: 'Alpha', pts: [[0, 0], [10, 0]] });
    const out = chainBridgeRoads([unnamed, diffName, nonBridge]);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.pts)).toEqual([
      [[0, 0], [10, 0]],
      [[0, 0], [10, 0]],
      [[0, 0], [10, 0]],
    ]);
  });
});

describe('chained deck', () => {
  it('chained deck: a three-piece bridge whose joints lie below the water is profiled between the outer abutments', () => {
    const heightAt: HeightFn = (x, _z) => (x <= 0 ? 30 : x >= 60 ? 46 : -24);
    const name = 'Span';
    const roads: Road[] = [
      makeRoad({ id: 1, name, bridge: true, cls: 'primary', pts: [[0, 0], [20, 0]] }),
      makeRoad({ id: 2, name, bridge: true, cls: 'primary', pts: [[20, 0], [40, 0]] }),
      makeRoad({ id: 3, name, bridge: true, cls: 'primary', pts: [[40, 0], [60, 0]] }),
    ];
    const decks = new BridgeDecks(roads, heightAt);
    const mid = decks.deckAt([30, 0])!;
    // Lerp 30 → 46 across the chain gives 38 at mid-span, well above the −24 water.
    expect(mid).toBeGreaterThan(37);
    expect(mid).toBeLessThan(39);
  });
});

describe('Golden Gate Bridge chaining (sf.json)', () => {
  it('sf.json: groundAt along the Golden Gate Bridge East Sidewalk never drops below 25 m and is within 4 m of the West Sidewalk', () => {
    const sf: CityData = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'public', 'data', 'sf.json'), 'utf8'),
    );
    const terrain = new Terrain(sf.terrain!);
    const decks = new BridgeDecks(sf.roads, terrain.heightAt);
    const groundAt = makeGroundAt(terrain, decks);

    const east = sf.roads.filter((r) => r.name === 'Golden Gate Bridge East Sidewalk');
    const west = sf.roads.find((r) => r.name === 'Golden Gate Bridge West Sidewalk');
    expect(east.length).toBeGreaterThanOrEqual(3);
    expect(west).toBeDefined();
    const westPts = west!.pts;
    const eastPts = east.flatMap((r) => r.pts);
    expect(eastPts.length).toBeGreaterThan(10);

    // Nearest point on the west polyline (projected onto its segments) so the
    // height comparison reflects the same span-wise station, not a discrete
    // vertex distance.
    const projectNearest = (x: number, z: number): Vec2 => {
      let best = Infinity;
      let bestP: Vec2 = westPts[0]!;
      for (let i = 0; i < westPts.length - 1; i++) {
        const a = westPts[i]!;
        const b = westPts[i + 1]!;
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const lenSq = dx * dx + dz * dz;
        let t = lenSq > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / lenSq : 0;
        t = Math.min(1, Math.max(0, t));
        const px = a[0] + t * dx;
        const pz = a[1] + t * dz;
        const d = Math.hypot(px - x, pz - z);
        if (d < best) {
          best = d;
          bestP = [px, pz];
        }
      }
      return bestP;
    };

    // The two abutment vertices (global min/max z) are land falls: the East
    // sidewalk runs ~10 m further than the West, so they land on different
    // terrain heights (East south ~45.6, West south ~41.6) and are not
    // deck-to-deck comparisons. Every vertex must clear `never below 25`;
    // the interior deck vertices must track the West deck to within 4 m.
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [, ez] of eastPts) {
      if (ez < minZ) minZ = ez;
      if (ez > maxZ) maxZ = ez;
    }
    for (const [ex, ez] of eastPts) {
      const eg = groundAt(ex, ez);
      expect(eg).toBeGreaterThanOrEqual(25);
      if (ez === minZ || ez === maxZ) continue;
      const wp = projectNearest(ex, ez);
      const wg = groundAt(wp[0], wp[1]);
      expect(Math.abs(eg - wg)).toBeLessThanOrEqual(4);
    }
  });
});

describe('makeGroundAt', () => {
  it('makeGroundAt(undefined, undefined)(x, z) === 0', () => {
    const g = makeGroundAt(undefined, undefined);
    expect(g(0, 0)).toBe(0);
    expect(g(-100, 50)).toBe(0);
  });

  it('terrain only', () => {
    const terrain = new Terrain(grid(2, 2, [0, 10, 4, 6], { step: 10 }));
    const g = makeGroundAt(terrain, undefined);
    expect(g(0, 0)).toBe(0);
    expect(g(10, 0)).toBe(10);
    expect(g(5, 5)).toBeCloseTo(3, 12);
  });

  it('deck above terrain wins', () => {
    // Valley under a 2-point span: abutments at 10, mid terrain 0, deck lerp 10
    const terrain = new Terrain(grid(3, 2, [10, 0, 10, 10, 0, 10], { step: 10 }));
    const decks = new BridgeDecks(
      [makeRoad({ bridge: true, pts: [[0, 0], [20, 0]] })],
      terrain.heightAt,
    );
    const g = makeGroundAt(terrain, decks);
    expect(terrain.heightAt(10, 0)).toBe(0);
    expect(decks.deckAt([10, 0])).toBeCloseTo(10, 12);
    expect(g(10, 0)).toBeCloseTo(10, 12);
  });

  it('terrain above deck wins', () => {
    // 2-point span over a bump: deck lerp is 0, terrain mid is 10
    const terrain = new Terrain(grid(3, 2, [0, 10, 0, 0, 10, 0], { step: 10 }));
    const decks = new BridgeDecks(
      [makeRoad({ bridge: true, pts: [[0, 0], [20, 0]] })],
      terrain.heightAt,
    );
    const g = makeGroundAt(terrain, decks);
    expect(decks.deckAt([10, 0])).toBeCloseTo(0, 12);
    expect(terrain.heightAt(10, 0)).toBe(10);
    expect(g(10, 0)).toBeCloseTo(10, 12);
  });
});
