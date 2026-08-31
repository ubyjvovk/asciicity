/**
 * Load a tiled city directory (`public/data/<id>/`) as the index, a
 * `CityData`-shaped globals view, or a reconstructed monolithic city
 * (index globals ∪ every tile). Used by tests that previously read
 * `public/data/city.json` / `kyiv.json` / `nyc.json`.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CityData, TileData, TileIndexData } from '../src/data/types';

const DATA_ROOT = resolve(__dirname, '..', 'public', 'data');

/** Parse `public/data/<id>/index.json`. */
export function loadTiledIndex(id: string): TileIndexData {
  return JSON.parse(
    readFileSync(join(DATA_ROOT, id, 'index.json'), 'utf8'),
  ) as TileIndexData;
}

/** One tile file `public/data/<id>/tiles/<key>.json`. */
export function loadTiledTile(id: string, key: string): TileData {
  return JSON.parse(
    readFileSync(join(DATA_ROOT, id, 'tiles', `${key}.json`), 'utf8'),
  ) as TileData;
}

/**
 * Index globals as a `CityData` (`roads` = `bridgeRoads`, empty buildings).
 * Enough for deck/terrain/water tests that never need tiled footprints.
 */
export function loadTiledGlobals(id: string): CityData {
  const index = loadTiledIndex(id);
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
export function loadTiledCity(id: string): CityData {
  const index = loadTiledIndex(id);
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
