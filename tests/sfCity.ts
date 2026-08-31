/**
 * Load the tiled San Francisco dataset (`public/data/sf/`) as either the
 * index, a `CityData`-shaped globals view, or a reconstructed monolithic
 * city (index globals ∪ every tile). Used by tests that previously read
 * `public/data/sf.json`.
 *
 * T-0101: the index / globals / full reconstruction loaders are memoized.
 * Vitest runs one worker per test file, so each parsed object is computed
 * once per process and returned by reference afterwards, collapsing the
 * repeat fs reads (SF = 69 files ≈ 15 MB) that made dataset-heavy files time
 * out on slow CI runners. Callers must treat the returned objects as
 * read-only.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CityData, TileData, TileIndexData } from '../src/data/types';

const SF_DIR = resolve(__dirname, '..', 'public', 'data', 'sf');

/** Parsed `index.json` (T-0101 memo cache). */
let indexCache: TileIndexData | undefined;
/** `CityData` globals view (T-0101 memo cache). */
let globalsCache: CityData | undefined;
/** Reconstructed monolithic `CityData` (T-0101 memo cache). */
let cityCache: CityData | undefined;

/** Parse `public/data/sf/index.json`, memoized. */
export function loadSfIndex(): TileIndexData {
  if (indexCache !== undefined) return indexCache;
  const index = JSON.parse(
    readFileSync(join(SF_DIR, 'index.json'), 'utf8'),
  ) as TileIndexData;
  indexCache = index;
  return index;
}

/** One tile file `public/data/sf/tiles/<key>.json`. */
export function loadSfTile(key: string): TileData {
  return JSON.parse(
    readFileSync(join(SF_DIR, 'tiles', `${key}.json`), 'utf8'),
  ) as TileData;
}

/**
 * Index globals as a `CityData` (`roads` = `bridgeRoads`, empty buildings).
 * Enough for deck/terrain/water tests that never need tiled footprints.
 * Memoized; callers must not mutate the returned object.
 */
export function loadSfGlobals(): CityData {
  if (globalsCache !== undefined) return globalsCache;
  const index = loadSfIndex();
  const globals: CityData = {
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
  globalsCache = globals;
  return globals;
}

/**
 * Reconstruct a monolithic `CityData` from the tiled directory (union of
 * every tile plus global `bridgeRoads` / places / water / terrain).
 * Memoized; callers must not mutate the returned object.
 */
export function loadSfCity(): CityData {
  if (cityCache !== undefined) return cityCache;
  const index = loadSfIndex();
  const buildings: CityData['buildings'] = [];
  const roads: CityData['roads'] = [...index.bridgeRoads];
  const trees: NonNullable<CityData['trees']> = [];
  const woods: NonNullable<CityData['woods']> = [];
  for (const key of Object.keys(index.tiles)) {
    const tile = loadSfTile(key);
    buildings.push(...tile.buildings);
    roads.push(...tile.roads);
    if (tile.trees) trees.push(...tile.trees);
    if (tile.woods) woods.push(...tile.woods);
  }
  const city: CityData = {
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
  cityCache = city;
  return city;
}
