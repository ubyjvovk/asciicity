/**
 * Load a tiled city directory (`public/data/<id>/`) as the index, a
 * `CityData`-shaped globals view, or a reconstructed monolithic city
 * (index globals ∪ every tile). Used by tests that previously read
 * `public/data/city.json` / `kyiv.json` / `nyc.json`.
 *
 * T-0101: the index / globals / full reconstruction loaders are memoized per
 * city id. Vitest runs one worker per test file, so each parsed object is
 * computed once per process and returned by reference afterwards, collapsing
 * the repeat fs reads (SF = 69 files ≈ 15 MB) that made dataset-heavy files
 * time out on slow CI runners. Callers must treat the returned objects as
 * read-only.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CityData, TileData, TileIndexData } from '../src/data/types';

const DATA_ROOT = resolve(__dirname, '..', 'public', 'data');

/** Parsed `index.json` per city id (T-0101 memo cache). */
const indexCache = new Map<string, TileIndexData>();
/** `CityData` globals view per city id (T-0101 memo cache). */
const globalsCache = new Map<string, CityData>();
/** Reconstructed monolithic `CityData` per city id (T-0101 memo cache). */
const cityCache = new Map<string, CityData>();

/** Parse `public/data/<id>/index.json`, memoized per id. */
export function loadTiledIndex(id: string): TileIndexData {
  const cached = indexCache.get(id);
  if (cached !== undefined) return cached;
  const index = JSON.parse(
    readFileSync(join(DATA_ROOT, id, 'index.json'), 'utf8'),
  ) as TileIndexData;
  indexCache.set(id, index);
  return index;
}

/** One tile file `public/data/<id>/tiles/<key>.json`. */
export function loadTiledTile(id: string, key: string): TileData {
  return JSON.parse(
    readFileSync(join(DATA_ROOT, id, 'tiles', `${key}.json`), 'utf8'),
  ) as TileData;
}

/** Index globals as a fresh `CityData` (`roads` = `bridgeRoads`, empty buildings). */
function buildGlobals(index: TileIndexData): CityData {
  return {
    v: 1,
    origin: index.origin,
    bbox: index.bbox,
    buildings: [],
    roads: index.bridgeRoads,
    places: index.places,
    water: index.water,
    waterLevels: index.waterLevels,
    rivers: index.rivers,
    terrain: index.terrain,
  };
}

/**
 * Index globals as a `CityData` (`roads` = `bridgeRoads`, empty buildings).
 * Enough for deck/terrain/water tests that never need tiled footprints.
 * Memoized per id; callers must not mutate the returned object.
 */
export function loadTiledGlobals(id: string): CityData {
  const cached = globalsCache.get(id);
  if (cached !== undefined) return cached;
  const globals = buildGlobals(loadTiledIndex(id));
  globalsCache.set(id, globals);
  return globals;
}

/** Reconstruct a fresh monolithic `CityData` from an index + every tile. */
function buildCity(index: TileIndexData, id: string): CityData {
  const buildings: CityData['buildings'] = [];
  const roads: CityData['roads'] = [...index.bridgeRoads];
  const trees: NonNullable<CityData['trees']> = [];
  const woods: NonNullable<CityData['woods']> = [];
  for (const key of Object.keys(index.tiles)) {
    const tile = loadTiledTile(id, key);
    buildings.push(...tile.buildings);
    roads.push(...tile.roads);
    if (tile.trees) trees.push(...tile.trees);
    if (tile.woods) woods.push(...tile.woods);
  }
  return {
    v: 1,
    origin: index.origin,
    bbox: index.bbox,
    buildings,
    roads,
    places: index.places,
    water: index.water,
    waterLevels: index.waterLevels,
    rivers: index.rivers,
    trees: trees.length > 0 ? trees : undefined,
    woods: woods.length > 0 ? woods : undefined,
    terrain: index.terrain,
  };
}

/**
 * Reconstruct a monolithic `CityData` from the tiled directory (union of
 * every tile plus global `bridgeRoads` / places / water / terrain).
 * Memoized per id; callers must not mutate the returned object.
 */
export function loadTiledCity(id: string): CityData {
  const cached = cityCache.get(id);
  if (cached !== undefined) return cached;
  const city = buildCity(loadTiledIndex(id), id);
  cityCache.set(id, city);
  return city;
}
