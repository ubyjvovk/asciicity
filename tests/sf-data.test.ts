/**
 * Unit tests for the committed tiled San Francisco dataset (T-0077 / T-0095):
 * the Golden Gate Bridge roadway is `highway=motorway`, so it must arrive as
 * a `cls: 'primary'` bridge road in `index.bridgeRoads` (and the two sidewalks
 * must survive). Bridges are global — never split into tiles.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { project } from '../scripts/osm-convert';
import { loadSfCity, loadSfGlobals, loadSfIndex } from './sfCity';
import { loadTiledCity, loadTiledGlobals, loadTiledIndex } from './tiledCity';

// T-0101: dataset-heavy file — a cold-cache first load on a slow CI runner
// can exceed vitest's default 5 s per test. Give this file 30 s slack.
vi.setConfig({ testTimeout: 30_000 });

// T-0101: the tiled loaders must memoize — two calls return the SAME object
// reference (vitest runs each file in its own worker, so the cache is
// per-file). That is what lets dataset-heavy files read each city's
// index/globals/full reconstruction only once instead of per test.
// Callers must treat the shared objects as read-only.
describe('tiled loaders memoize (T-0101)', () => {
  it('sf loaders return the same object reference across calls', () => {
    expect(loadSfIndex()).toBe(loadSfIndex());
    expect(loadSfGlobals()).toBe(loadSfGlobals());
    expect(loadSfCity()).toBe(loadSfCity());
  });

  it('tiled loaders return the same object reference across calls per city', () => {
    for (const id of ['kyiv', 'nyc'] as const) {
      expect(loadTiledIndex(id), id).toBe(loadTiledIndex(id));
      expect(loadTiledGlobals(id), id).toBe(loadTiledGlobals(id));
      expect(loadTiledCity(id), id).toBe(loadTiledCity(id));
    }
  });
});

const SF = loadSfIndex();

const ORIGIN = { lon: -122.4075, lat: 37.788 };
// SF bbox (minLon,minLat,maxLon,maxLat) — same as the fetch CLI.
const BBOX = [-122.487, 37.764, -122.383, 37.835];

describe('sf.json Golden Gate Bridge roadway (T-0077)', () => {
  it('sf.json carries the Golden Gate Bridge roadway as a primary bridge road', () => {
    const roadways = SF.bridgeRoads.filter(
      (r) => r.name === 'Golden Gate Bridge' && r.cls === 'primary' && r.bridge === true,
    );
    expect(roadways.length).toBeGreaterThanOrEqual(1);
  });

  it('every Golden Gate Bridge roadway point falls inside the sf bbox', () => {
    // Project the bbox corners to local metres (same project() as the
    // converter) and require every roadway point inside the rectangle.
    const corners: Array<[number, number]> = [
      [BBOX[0], BBOX[1]],
      [BBOX[2], BBOX[1]],
      [BBOX[2], BBOX[3]],
      [BBOX[0], BBOX[3]],
    ];
    const proj = corners.map(([lon, lat]) => project(lon, lat, ORIGIN));
    const xs = proj.map(([x]) => x);
    const zs = proj.map(([, z]) => z);
    const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
    const [minZ, maxZ] = [Math.min(...zs), Math.max(...zs)];

    const roadways = SF.bridgeRoads.filter(
      (r) => r.name === 'Golden Gate Bridge' && r.cls === 'primary' && r.bridge === true,
    );
    expect(roadways.length).toBeGreaterThanOrEqual(1);
    for (const r of roadways) {
      for (const [x, z] of r.pts) {
        expect(x).toBeGreaterThanOrEqual(minX);
        expect(x).toBeLessThanOrEqual(maxX);
        expect(z).toBeGreaterThanOrEqual(minZ);
        expect(z).toBeLessThanOrEqual(maxZ);
      }
    }
  });

  it('sf.json still carries both Golden Gate Bridge sidewalks', () => {
    const east = SF.bridgeRoads.filter(
      (r) => r.name === 'Golden Gate Bridge East Sidewalk',
    );
    const west = SF.bridgeRoads.filter(
      (r) => r.name === 'Golden Gate Bridge West Sidewalk',
    );
    expect(east.length).toBeGreaterThanOrEqual(1);
    expect(west.length).toBeGreaterThanOrEqual(1);
    for (const r of [...east, ...west]) {
      expect(r.cls).toBe('pedestrian');
      expect(r.bridge).toBe(true);
    }
  });

  it('sf.json is under 16 MB and passes validateCity', async () => {
    const dir = resolve(__dirname, '..', 'public', 'data', 'sf');
    let total = statSync(join(dir, 'index.json')).size;
    for (const name of readdirSync(join(dir, 'tiles'))) {
      total += statSync(join(dir, 'tiles', name)).size;
    }
    expect(total).toBeLessThan(16 * 1024 * 1024);
    const { validateTileIndex } = await import('../src/data/validate');
    expect(() => validateTileIndex(SF)).not.toThrow();
  });
});
