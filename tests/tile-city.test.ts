/**
 * Unit tests for `scripts/tile-city.mjs` (the wave-11 tiler), the standalone
 * CLI's determinism guarantee, and the chunked-fetch pure helpers
 * (`splitBbox`, `dedupeElements` from `scripts/fetch-osm.mjs`). Covers the
 * cases listed in T-0093's acceptance criteria, by name.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { tileCity } from '../scripts/tile-city';
import { splitBbox, dedupeElements } from '../scripts/fetch-osm';
import type { CityData, Vec2 } from '../src/data/types';
import { syntheticCity } from '../src/data/synthetic';

const TILE = 100;

/** A minimal valid (empty) city, so a test can drop in one custom element. */
function emptyCity(): CityData {
  return {
    v: 1,
    origin: { lat: 51.5133, lon: -0.0887 },
    bbox: [-0.106, 51.506, -0.07, 51.521],
    buildings: [],
    roads: [],
    places: [],
  };
}

/** Collect every piece of a road `id` (in tile order) across all tiles. */
function roadPieces(tiled: { tiles: Map<string, { roads: Array<{ id: number; pts: Vec2[] }> }> }, id: number): Vec2[][] {
  const out: Vec2[][] = [];
  for (const tile of tiled.tiles.values()) {
    for (const r of tile.roads) {
      if (r.id === id) out.push(r.pts);
    }
  }
  return out;
}

describe('tileCity union round-trip', () => {
  it('reproduces every building/tree/woods element exactly once, input order preserved within a tile', () => {
    const city = syntheticCity(1, 12);
    city.trees = [
      [-250, -200, 8, 2.8],
      [-250, 200, 9, 3],
      [10, 20, 7, 2],
      [250, 300, 10, 4],
    ];
    city.woods = [
      [
        [-400, -400],
        [400, -400],
        [400, 400],
        [-400, 400],
      ],
    ];
    const tiled = tileCity(city, 200);

    // buildings: every input building lands in exactly one tile, exactly once.
    const allBuildings = [...tiled.tiles.values()].flatMap((t) => t.buildings);
    expect(allBuildings).toHaveLength(city.buildings.length);
    const counts = new Map<number, number>();
    for (const b of allBuildings) counts.set(b.id, (counts.get(b.id) ?? 0) + 1);
    for (const [, c] of counts) expect(c).toBe(1);

    // trees: exactly once each.
    const allTrees = [...tiled.tiles.values()].flatMap((t) => t.trees ?? []);
    expect(allTrees).toHaveLength(city.trees.length);
    expect(new Set(allTrees.map((t) => JSON.stringify(t))).size).toBe(city.trees.length);

    // woods: exactly once each.
    const allWoods = [...tiled.tiles.values()].flatMap((t) => t.woods ?? []);
    expect(allWoods).toHaveLength(city.woods.length);
    expect(new Set(allWoods.map((w) => JSON.stringify(w))).size).toBe(city.woods.length);

    // input order preserved within a tile: strict input-index subsequence.
    const indexById = new Map(city.buildings.map((b, i) => [b.id, i]));
    for (const tile of tiled.tiles.values()) {
      const idxs = tile.buildings.map((b) => indexById.get(b.id)!);
      for (let i = 1; i < idxs.length; i++) {
        expect(idxs[i]).toBeGreaterThan(idxs[i - 1]);
      }
    }
  });
});

describe('tileCity assignment', () => {
  it('assigns each building by its unrounded vertex-mean centroid, deterministically', () => {
    // Centroid x = (99.9 + 99.9 + 100 + 100) / 4 = 99.95. Unrounded →
    // floor(99.95/100) = 0 (tile "0_0"). Rounded to 0.1 it would become 100.0
    // and flip to tile "1_0" — the assignment must use the raw mean.
    const city = emptyCity();
    city.buildings = [
      {
        id: 1,
        h: 20,
        poly: [
          [99.9, 10],
          [99.9, 30],
          [100, 30],
          [100, 10],
        ],
      },
    ];
    const tiled = tileCity(city, TILE);
    expect(tiled.tiles.get('0_0')?.buildings.map((b) => b.id)).toEqual([1]);
    expect(tiled.tiles.has('1_0')).toBe(false);

    // Determinism: two runs serialise identically.
    const full = syntheticCity(1, 12);
    const a = tileCity(full, TILE);
    const b = tileCity(full, TILE);
    expect(JSON.stringify(a.index)).toBe(JSON.stringify(b.index));
    expect([...a.tiles.keys()]).toEqual([...b.tiles.keys()]);
    for (const key of a.tiles.keys()) {
      expect(JSON.stringify(a.tiles.get(key))).toBe(JSON.stringify(b.tiles.get(key)));
    }
  });
});

describe('tileCity road splitting', () => {
  it('splits a road crossing a boundary with exactly coincident endpoints in both pieces; reversing yields the same crossing point', () => {
    const make = (pts: Vec2[]) => {
      const city = emptyCity();
      city.roads = [{ id: 7, cls: 'primary', pts }];
      return tileCity(city, TILE);
    };
    const fwd = make([
      [-50, 0],
      [50, 0],
    ]);
    const rev = make([
      [50, 0],
      [-50, 0],
    ]);
    const fwdPieces = roadPieces(fwd, 7).sort((a, b) => a[0][0] - b[0][0]);
    const revPieces = roadPieces(rev, 7).sort((a, b) => a[0][0] - b[0][0]);
    expect(fwdPieces).toHaveLength(2);
    // exactly coincident endpoints: piece 0 ends where piece 1 starts.
    expect(fwdPieces[0][fwdPieces[0].length - 1]).toEqual([0, 0]);
    expect(fwdPieces[1][0]).toEqual([0, 0]);
    // reversing the polyline yields the same crossing point.
    expect(revPieces).toHaveLength(2);
    const fwdCross = fwdPieces[0][fwdPieces[0].length - 1];
    const revCross = revPieces[0][0];
    expect(revCross[0]).toBeCloseTo(fwdCross[0], 9);
    expect(revCross[1]).toBeCloseTo(fwdCross[1], 9);
  });

  it('splits a segment that cuts a tile corner (no vertex inside) into a piece in that tile', () => {
    // Neither endpoint is inside tile (0,0); the segment clips its NW corner,
    // entering at (0,2) and leaving at (3,0).
    const city = emptyCity();
    city.roads = [
      {
        id: 1,
        cls: 'primary',
        pts: [
          [-3, 4],
          [6, -2],
        ],
      },
    ];
    const tiled = tileCity(city, TILE);
    const corner = tiled.tiles.get('0_0')?.roads.find((r) => r.id === 1)?.pts;
    expect(corner).toBeDefined();
    expect(corner).toHaveLength(2);
    expect(corner![0][0]).toBeCloseTo(0, 9);
    expect(corner![0][1]).toBeCloseTo(2, 9);
    expect(corner![1][0]).toBeCloseTo(3, 9);
    expect(corner![1][1]).toBeCloseTo(0, 9);
  });

  it('splits a U-shaped road that re-enters a tile into two pieces with the same id', () => {
    const city = emptyCity();
    city.roads = [
      {
        id: 5,
        cls: 'residential',
        pts: [
          [10, 10],
          [110, 10],
          [110, 90],
          [10, 90],
        ],
      },
    ];
    const tiled = tileCity(city, TILE);
    const inTile = tiled.tiles.get('0_0')?.roads.filter((r) => r.id === 5) ?? [];
    expect(inTile).toHaveLength(2);
    expect(inTile[0].pts[0]).toEqual([10, 10]);
    expect(inTile[0].pts[inTile[0].pts.length - 1]).toEqual([100, 10]);
    expect(inTile[1].pts[0]).toEqual([100, 90]);
    expect(inTile[1].pts[inTile[1].pts.length - 1]).toEqual([10, 90]);
    expect(inTile[0].id).toBe(5);
    expect(inTile[1].id).toBe(5);
    // the out-and-back leg is one piece in the neighbouring tile
    expect(roadPieces(tiled, 5)).toHaveLength(3);
  });

  it('places bridge roads whole in index.bridgeRoads and in no tile', () => {
    const city = emptyCity();
    city.roads = [
      { id: 1, cls: 'primary', pts: [[-50, 0], [50, 0]] },
      { id: 2, cls: 'pedestrian', name: 'Bridge', bridge: true, pts: [[-150, 0], [150, 0]] },
    ];
    const tiled = tileCity(city, TILE);
    expect(tiled.index.bridgeRoads).toHaveLength(1);
    const b = tiled.index.bridgeRoads[0];
    expect(b.id).toBe(2);
    expect(b.name).toBe('Bridge');
    // whole polyline, never split at the boundary
    expect(b.pts).toEqual([
      [-150, 0],
      [150, 0],
    ]);
    for (const tile of tiled.tiles.values()) {
      expect(tile.roads.every((r) => r.id !== 2)).toBe(true);
    }
  });

  it('drops single-point degenerate road pieces', () => {
    // The road touches tile (0,0) only at the corner vertex (0,0), producing
    // a single-point piece there — which must be dropped.
    const city = emptyCity();
    city.roads = [
      {
        id: 1,
        cls: 'primary',
        pts: [
          [-50, -50],
          [0, 0],
          [-50, 50],
        ],
      },
    ];
    const tiled = tileCity(city, TILE);
    for (const tile of tiled.tiles.values()) {
      for (const r of tile.roads) {
        expect(r.pts.length).toBeGreaterThanOrEqual(2);
      }
    }
    // the corner-touch tile holds nothing from this road
    expect(tiled.tiles.get('0_0')?.roads ?? []).toHaveLength(0);
    // the two real pieces survive
    expect(roadPieces(tiled, 1)).toHaveLength(2);
  });
});

describe('tileCity landmarks, empty tiles and index', () => {
  it('emits landmarks in tile scan order (j asc, i asc, input order), one per named building', () => {
    const city = syntheticCity(1, 6);
    const tiled = tileCity(city, TILE);
    const expected: Array<{ name: string; idx: number; i: number; j: number; cx: number; cz: number }> = [];
    city.buildings.forEach((b, idx) => {
      if (b.name === undefined) return;
      const cx = b.poly.reduce((s, p) => s + p[0], 0) / b.poly.length;
      const cz = b.poly.reduce((s, p) => s + p[1], 0) / b.poly.length;
      expected.push({ name: b.name, idx, i: Math.floor(cx / TILE), j: Math.floor(cz / TILE), cx, cz });
    });
    expected.sort((a, c) => a.j - c.j || a.i - c.i || a.idx - c.idx);
    expect(tiled.index.landmarks).toHaveLength(expected.length);
    tiled.index.landmarks.forEach((lm, k) => {
      expect(lm.name).toBe(expected[k].name);
      expect(lm.x).toBeCloseTo(expected[k].cx, 9);
      expect(lm.z).toBeCloseTo(expected[k].cz, 9);
    });
  });

  it('omits empty tiles from index.tiles', () => {
    const city = syntheticCity(1, 3); // 3x3 blocks, extent 111 m → some empty corners
    const tiled = tileCity(city, TILE);
    expect(tiled.index.tiles).not.toHaveProperty('5_5'); // a definitely-empty key
    for (const key of Object.keys(tiled.index.tiles)) {
      const stat = tiled.index.tiles[key];
      expect(stat.buildings + stat.roads + stat.trees).toBeGreaterThan(0);
    }
    // every index entry has a corresponding tile map entry
    for (const key of Object.keys(tiled.index.tiles)) {
      expect(tiled.tiles.has(key)).toBe(true);
    }
  });

  it('keys negative tile indices as "-3_2"', () => {
    const city = emptyCity();
    city.trees = [[-250, 200, 8, 3]]; // tile floor(-250/100), floor(200/100) = -3_2
    const tiled = tileCity(city, TILE);
    const tile = tiled.tiles.get('-3_2');
    expect(tile).toBeDefined();
    expect(tile!.trees).toEqual([[-250, 200, 8, 3]]);
  });
});

describe('tileCity CLI determinism', () => {
  it('writes byte-identical files on a second run; tiles[key].bytes matches the written file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tilecity-'));
    try {
      const script = resolve(__dirname, '../scripts/tile-city.mjs');
      const inPath = join(dir, 'city.json');
      const city = syntheticCity(1, 12);
      city.trees = [
        [10, 20, 8, 3],
        [-250, 200, 9, 3],
      ];
      city.woods = [
        [
          [-300, -300],
          [300, -300],
          [300, 300],
          [-300, 300],
        ],
      ];
      writeFileSync(inPath, JSON.stringify(city));
      const out1 = join(dir, 'out1');
      const out2 = join(dir, 'out2');
      const run = (out: string) =>
        execFileSync(process.execPath, [script, inPath, out], { encoding: 'utf8' });
      run(out1);
      run(out2);

      // identical file sets
      const tiles1 = readdirSync(join(out1, 'tiles')).sort();
      const tiles2 = readdirSync(join(out2, 'tiles')).sort();
      expect(tiles1).toEqual(tiles2);
      // byte-identical index and every tile
      expect(readFileSync(join(out1, 'index.json')).equals(readFileSync(join(out2, 'index.json')))).toBe(true);
      for (const f of tiles1) {
        expect(readFileSync(join(out1, 'tiles', f)).equals(readFileSync(join(out2, 'tiles', f)))).toBe(true);
      }

      // index.tiles[key].bytes == the written tile file's byte length
      const index = JSON.parse(readFileSync(join(out1, 'index.json'), 'utf8'));
      expect(Object.keys(index.tiles).length).toBe(tiles1.length); // no empty-tile files
      for (const f of tiles1) {
        const key = f.replace(/\.json$/, '');
        expect(index.tiles[key].bytes).toBe(statSync(join(out1, 'tiles', f)).size);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('chunked fetch pure helpers (no network)', () => {
  it('splitBbox covers the bbox exactly with no gaps or overlaps', () => {
    const bbox: [number, number, number, number] = [-0.106, 51.506, -0.07, 51.521];
    const n = 3;
    const m = 2;
    const subs = splitBbox(bbox, n, m);
    expect(subs).toHaveLength(n * m);
    for (const [minLon, minLat, maxLon, maxLat] of subs) {
      expect(minLon).toBeGreaterThanOrEqual(bbox[0]);
      expect(minLat).toBeGreaterThanOrEqual(bbox[1]);
      expect(maxLon).toBeLessThanOrEqual(bbox[2]);
      expect(maxLat).toBeLessThanOrEqual(bbox[3]);
      expect(minLon).toBeLessThan(maxLon);
      expect(minLat).toBeLessThan(maxLat);
    }
    // total area equals the parent area → covers exactly, no gaps / overlaps.
    const parentArea = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
    const sum = subs.reduce((s, b) => s + (b[2] - b[0]) * (b[3] - b[1]), 0);
    expect(sum).toBeCloseTo(parentArea, 12);
    // adjacent sub-bboxes share edges exactly.
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < n - 1; c++) {
        expect(subs[r * n + c][2]).toBe(subs[r * n + c + 1][0]);
      }
    }
    for (let r = 0; r < m - 1; r++) {
      for (let c = 0; c < n; c++) {
        expect(subs[r * n + c][3]).toBe(subs[(r + 1) * n + c][1]);
      }
    }
  });

  it('dedupeElements keeps one copy of a seam element by type + id, preserving order', () => {
    const els = [
      { type: 'way', id: 1 },
      { type: 'node', id: 1 },
      { type: 'way', id: 1 }, // duplicate (seam)
      { type: 'relation', id: 2 },
      { type: 'node', id: 3 },
      { type: 'relation', id: 2 }, // duplicate
      { type: 'way', id: 1 }, // another seam duplicate
    ];
    expect(dedupeElements(els)).toEqual([
      { type: 'way', id: 1 },
      { type: 'node', id: 1 },
      { type: 'relation', id: 2 },
      { type: 'node', id: 3 },
    ]);
  });
});
