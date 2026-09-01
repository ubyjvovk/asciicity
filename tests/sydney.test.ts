/**
 * Unit tests for the committed tiled Sydney dataset (T-0110) — the project's
 * first southern-hemisphere city (DEM tile S34E151). Proves the S-hemisphere
 * terrain transect (the bare-earth `--dem-bare` surface sampled via the same
 * `terrainHeightAt` the runtime draws), the tile invariants (count / bytes /
 * no bridge leaks), the size guard, the registry/spawn wiring, and the
 * follow-up report anchor names. Reads the tiles through the memoized
 * `tests/tiledCity.ts` helpers (T-0101 lesson — CI runners are slow on I/O).
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { project } from '../src/geo';
import type { TerrainData, Vec2 } from '../src/data/types';
import { terrainHeightAt } from '../src/world/terrain';
import { CITIES, cityById } from '../src/data/cities';
import { SPAWN_PRESETS, presetsFor } from '../src/data/spawn';
import { pointInPolygon } from '../src/world/collision';
import { loadTiledCity, loadTiledGlobals, loadTiledIndex } from './tiledCity';

// T-0101: dataset-heavy file — a cold-cache first load on a slow CI runner
// can exceed vitest's default 5 s per test. Give this file 30 s slack.
vi.setConfig({ testTimeout: 30_000 });

const SYD = loadTiledIndex('sydney');
const GLOBALS = loadTiledGlobals('sydney');
// Reconstructed monolithic city (index globals ∪ every tile) for tile reads.
const CITY = loadTiledCity('sydney');

const ORIGIN = SYD.origin; // { lon: 151.2110, lat: -33.8613 }
const BBOX = SYD.bbox; // [151.183, -33.895, 151.245, -33.833]

/** Sample a WGS84 point's ASL height (local terrain + datum). */
function asl(lon: number, lat: number): number {
  const [x, z] = project(lon, lat, ORIGIN);
  return terrainHeightAt(CITY.terrain as TerrainData, x, z) + (CITY.terrain?.datum ?? 0);
}

describe('sydney terrain transect — first S-hemisphere tile (S34E151)', () => {
  it('Circular Quay origin is ~datum, well under 10 m ASL', () => {
    expect(asl(151.211, -33.8613)).toBeGreaterThanOrEqual(0);
    expect(asl(151.211, -33.8613)).toBeLessThanOrEqual(10);
  });

  it('Observatory Hill sits in [12, 40] m ASL', () => {
    const h = asl(151.2043, -33.8587);
    expect(h).toBeGreaterThanOrEqual(12);
    expect(h).toBeLessThanOrEqual(40);
  });

  it('North Sydney ridge sits in [45, 85] m ASL', () => {
    const h = asl(151.207, -33.839);
    expect(h).toBeGreaterThanOrEqual(45);
    expect(h).toBeLessThanOrEqual(85);
  });

  it("Mrs Macquarie's Point sits in [0, 12] m ASL", () => {
    const h = asl(151.222, -33.8587);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(12);
  });

  it('the main harbour water ring (largest area) floats at ≤ 3 m ASL', () => {
    const ringAreas = (SYD.water ?? []).map((ring) => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, z1] = ring[i] ?? [0, 0];
        const [x2, z2] = ring[(i + 1) % ring.length] ?? [0, 0];
        a += x1 * z2 - x2 * z1;
      }
      return Math.abs(a) / 2;
    });
    const main = ringAreas.indexOf(Math.max(...ringAreas));
    const waterLevelAsl = (SYD.waterLevels?.[main] ?? 0) + (SYD.terrain?.datum ?? 0);
    expect(waterLevelAsl).toBeLessThanOrEqual(3);
  });
});

describe('sydney tile invariants', () => {
  it('zero bridge roads leak into tiles (bridges are global)', () => {
    const dir = resolve(__dirname, '..', 'public', 'data', 'sydney', 'tiles');
    let bridgeInTiles = 0;
    for (const name of readdirSync(dir)) {
      const tile = JSON.parse(
        require('node:fs').readFileSync(join(dir, name), 'utf8'),
      );
      for (const r of tile.roads ?? []) if (r.bridge) bridgeInTiles++;
    }
    expect(bridgeInTiles).toBe(0);
    expect(SYD.bridgeRoads.length).toBeGreaterThan(0);
  });

  it('index + tiles total is under the 12 MB size guard', () => {
    const dir = resolve(__dirname, '..', 'public', 'data', 'sydney');
    let total = statSync(join(dir, 'index.json')).size;
    for (const name of readdirSync(join(dir, 'tiles'))) {
      total += statSync(join(dir, 'tiles', name)).size;
    }
    expect(total).toBeLessThan(12 * 1024 * 1024);
  });

  it('passes validateTileIndex', async () => {
    const { validateTileIndex } = await import('../src/data/validate');
    expect(() => validateTileIndex(SYD)).not.toThrow();
  });
});

describe('sydney registry + spawn wiring', () => {
  it('CITIES carries sydney (picker order: after tokyo), tiled, real sizeBytes', () => {
    const ids = CITIES.map((c) => c.id);
    expect(ids).toContain('sydney');
    expect(ids.indexOf('sydney')).toBe(ids.indexOf('tokyo') + 1);
    const sydney = cityById('sydney');
    expect(sydney?.label).toBe('SYDNEY');
    expect(sydney?.tiled).toBe(true);
    expect(sydney?.defaultRender).toBeUndefined();
    expect(sydney?.sizeBytes).toBe(
      statSync(
        resolve(__dirname, '..', 'public', 'data', 'sydney', 'index.json'),
      ).size,
    );
  });

  it("sydney.defaultSpawn 'circularquay' is a fixed-coordinate preset inside the bbox", () => {
    const sydney = cityById('sydney');
    expect(sydney?.defaultSpawn).toBe('circularquay');
    const preset = SPAWN_PRESETS.circularquay;
    expect(preset).toBeDefined();
    expect('building' in preset).toBe(false);
    expect(preset.city).toBe('sydney');
    const fixed = preset as { lon: number; lat: number };
    expect(fixed.lon).toBeGreaterThanOrEqual(BBOX[0]);
    expect(fixed.lon).toBeLessThanOrEqual(BBOX[2]);
    expect(fixed.lat).toBeGreaterThanOrEqual(BBOX[1]);
    expect(fixed.lat).toBeLessThanOrEqual(BBOX[3]);
  });

  it("presetsFor('sydney') begins with circularquay (defaultSpawn) and includes it", () => {
    // T-0110 shipped just `circularquay`; T-0111 extended the list to twelve
    // Sydney presets (see `tests/spawn.test.ts` "Sydney presets (wave 14)"
    // for the full-order assertion). Here we only bind what this ticket
    // originally cared about: the defaultSpawn key exists and comes first.
    const keys = presetsFor('sydney').map(([k]) => k);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys[0]).toBe('circularquay');
    expect(keys).toContain('circularquay');
  });
});

describe('sydney follow-up report anchors (T-0111 / T-0112)', () => {
  it('the three Harbour-Bridge crossing bridge-road names are global in index.bridgeRoads', () => {
    const countPieces = (n: string) =>
      SYD.bridgeRoads.filter((r) => r.name === n).length;
    expect(countPieces('Bradfield Highway')).toBeGreaterThanOrEqual(1);
    expect(countPieces('Cahill Walk')).toBeGreaterThanOrEqual(1);
    expect(countPieces('Harbour Bridge Cycleway')).toBeGreaterThanOrEqual(1);
  });

  it('Sydney Tower is present as a building:part with h ≈ 270', () => {
    const tower = CITY.buildings.filter(
      (b) => (b.name ?? '').toLowerCase() === 'sydney tower',
    );
    expect(tower.length).toBe(1);
    expect(Math.abs((tower[0]?.h ?? 0) - 270)).toBeLessThanOrEqual(1);
    expect((tower[0]?.minH ?? 0)).toBeGreaterThan(0);
  });
});

/**
 * Odd-parity water test (architecture.md §4.6): a point is WATER when it lies
 * inside an odd number of the shipped rings. Coordinates below are local metres,
 * with landmark coords sourced from the fetched dataset (e.g. the Sydney Opera
 * House building centroid, HMAS Onslow / Woolloomooloo Finger Wharf building
 * centroids, Garden Island naval-yard buildings) rather than approximated on
 * a map — Answers 3-6 called for "a Botanic Garden point / a Woolloomooloo
 * street vertex / a Bennelong Point/Opera House podium point / …", i.e.
 * descriptions, not literal fixed numbers.
 */
function waterParity(p: Vec2, rings: Vec2[][]): number {
  let n = 0;
  for (const ring of rings) if (pointInPolygon(p, ring)) n++;
  return n;
}

describe('sydney water parity (T-0116 composite DEM-contoured mask)', () => {
  const rings = SYD.water ?? [];

  it('WATER probes (six harbour points) all read odd parity', () => {
    // The six PM-locked WATER probes (Answers 2/3/5), plus Farm Cove and
    // Woolloomooloo Bay from Answers 5 §5 (mid-bay points picked from the
    // fetched data).
    const WATER: Array<[string, number, number]> = [
      ['mid-harbour', 277, -918],
      ['CQ cove', 92, -365],
      ['under-bridge', -30, -990],
      ['west-of-Goat', -1710, -1139],
      ['mid-Farm-Cove', 800, -450],
      ['mid-Woolloomooloo-Bay', 1350, -350],
    ];
    for (const [name, x, z] of WATER) {
      const n = waterParity([x, z], rings);
      expect(n % 2, `${name} (${x},${z}) expected WATER, got parity ${n}`).toBe(
        1,
      );
    }
  });

  it('LAND probes (foreshore, islands, CBD) all read even parity', () => {
    // CBD sits outside every ring; Fort Denison and Goat Island are inside
    // harbour(1) + island(1) = 2 (Answers 6 rule 5 rescue of the OSM
    // inner-member island rings); Bennelong Point / Garden Island / the
    // Botanic Garden peninsula are carved out of the DEM contour by rule 3's
    // force-LAND override over building centroids and non-bridge road
    // vertices, so they read count 0.
    const LAND: Array<[string, number, number]> = [
      ['CBD', 0, 500],
      ['Fort Denison (~1368,-730)', 1368, -730],
      ['Goat Island (~-1334,-1001)', -1334, -1001],
      ["Mrs Macquarie's Point", 1017, -287],
      ['Sydney Opera House (Bennelong Point) centroid', 377, -489],
      ['Woolloomooloo Finger Wharf centroid', 906, 747],
      ['Garden Island naval yard', 1580, -100],
      ['Kirribilli', 700, -1500],
      ['Blues Point', -600, -300],
    ];
    for (const [name, x, z] of LAND) {
      const n = waterParity([x, z], rings);
      expect(n % 2, `${name} (${x},${z}) expected LAND, got parity ${n}`).toBe(
        0,
      );
    }
  });

  it('kept large water rings (≥ 0.1 km²) are pairwise nearly disjoint (≤ 15 % sample overlap)', () => {
    // Sydney bbox is small enough (~40 km²) for an O(n²) 50 m-grid probe over
    // each pair to be quick. Overlap fraction = fraction of grid cells over
    // ring A's bbox whose centres lie inside both A and B.
    const STEP = 50; // metres
    const ringArea = (ring: Vec2[]): number => {
      let a = 0;
      const n = ring.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      }
      return Math.abs(a) / 2;
    };
    const large: Array<{ i: number; ring: Vec2[]; bbox: [number, number, number, number] }> = [];
    for (let i = 0; i < rings.length; i++) {
      if (ringArea(rings[i]) < 0.1 * 1e6) continue;
      const xs = rings[i].map((p) => p[0]);
      const zs = rings[i].map((p) => p[1]);
      large.push({
        i,
        ring: rings[i],
        bbox: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)],
      });
    }
    expect(large.length).toBeGreaterThan(0);
    for (let a = 0; a < large.length; a++) {
      for (let b = 0; b < large.length; b++) {
        if (a === b) continue;
        const A = large[a];
        const B = large[b];
        let inA = 0;
        let inBoth = 0;
        for (let x = A.bbox[0]; x <= A.bbox[2]; x += STEP) {
          for (let z = A.bbox[1]; z <= A.bbox[3]; z += STEP) {
            if (!pointInPolygon([x, z], A.ring)) continue;
            inA++;
            if (pointInPolygon([x, z], B.ring)) inBoth++;
          }
        }
        if (inA === 0) continue;
        const ovl = inBoth / inA;
        expect(
          ovl,
          `ring ${A.i} vs ring ${B.i} overlap fraction ${ovl.toFixed(3)} > 0.15`,
        ).toBeLessThanOrEqual(0.15);
      }
    }
  });

  it('global scan: only tunnel / wharf-approach road vertices read WATER (<0.05 %)', () => {
    // Composite mask (rules 1/3/5) drops the wet-non-bridge-road count from
    // ~195 (attempt-4 pervasive-flood baseline) to a handful. The remainder is
    // the Sydney Harbour Tunnel (a real under-harbour tunnel — surface points
    // must read water) and a few wharf-approach segments that OSM maps as
    // roads over water.
    const dir = resolve(__dirname, '..', 'public', 'data', 'sydney', 'tiles');
    let roadVerts = 0;
    let wet = 0;
    for (const name of readdirSync(dir)) {
      const tile = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      for (const r of tile.roads ?? []) {
        if (r.bridge) continue;
        for (const [x, z] of r.pts) {
          roadVerts++;
          if (waterParity([x, z], rings) % 2 === 1) wet++;
        }
      }
    }
    expect(roadVerts).toBeGreaterThan(10_000);
    expect(wet / roadVerts).toBeLessThan(0.0005); // 0.05 %
  });
});
