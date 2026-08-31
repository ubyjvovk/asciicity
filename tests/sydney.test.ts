/**
 * Unit tests for the committed tiled Sydney dataset (T-0110) — the project's
 * first southern-hemisphere city (DEM tile S34E151). Proves the S-hemisphere
 * terrain transect (the bare-earth `--dem-bare` surface sampled via the same
 * `terrainHeightAt` the runtime draws), the tile invariants (count / bytes /
 * no bridge leaks), the size guard, the registry/spawn wiring, and the
 * follow-up report anchor names. Reads the tiles through the memoized
 * `tests/tiledCity.ts` helpers (T-0101 lesson — CI runners are slow on I/O).
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { project } from '../src/geo';
import type { TerrainData } from '../src/data/types';
import { terrainHeightAt } from '../src/world/terrain';
import { CITIES, cityById } from '../src/data/cities';
import { SPAWN_PRESETS, presetsFor } from '../src/data/spawn';
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

  it("presetsFor('sydney') returns exactly the single circularquay preset", () => {
    const keys = presetsFor('sydney').map(([k]) => k);
    expect(keys).toEqual(['circularquay']);
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
