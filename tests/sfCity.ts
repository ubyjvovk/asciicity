/**
 * Load the tiled San Francisco dataset (`public/data/sf/`) as either the
 * index, a `CityData`-shaped globals view, or a reconstructed monolithic
 * city (index globals ∪ every tile). Used by tests that previously read
 * `public/data/sf.json`.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CityData, TileData, TileIndexData } from '../src/data/types';

const SF_DIR = resolve(__dirname, '..', 'public', 'data', 'sf');

/** Parse `public/data/sf/index.json`. */
export function loadSfIndex(): TileIndexData {
  return JSON.parse(readFileSync(join(SF_DIR, 'index.json'), 'utf8')) as TileIndexData;
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
 */
export function loadSfGlobals(): CityData {
  const index = loadSfIndex();
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
 * Reconstruct a monolithic `CityData` from the tiled directory (union of
 * every tile plus global `bridgeRoads` / places / water / terrain).
 */
export function loadSfCity(): CityData {
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
