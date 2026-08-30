/**
 * Validator cases for wave-10 building parts (`minH`) and the raised height
 * clamp (docs/data-format.md "Building parts"). Broader `validateCity` cases
 * live in `tests/data.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { validateCity, validateTileIndex } from '../src/data/validate';
import { syntheticCity } from '../src/data/synthetic';
import type { TileIndexData } from '../src/data/types';

/** Deep copy of a valid synthetic city for mutation in checks. */
function base(): ReturnType<typeof syntheticCity> {
  return structuredClone(syntheticCity(1, 3));
}

describe('validateCity building parts', () => {
  it('minH must be a finite number in [0, h − 1)', () => {
    const c = base();
    c.buildings[0].h = 20;
    c.buildings[0].minH = 5;
    expect(() => validateCity(c)).not.toThrow();
    c.buildings[0].minH = 0;
    expect(() => validateCity(c)).not.toThrow();
    c.buildings[0].minH = 18.999;
    expect(() => validateCity(c)).not.toThrow();

    c.buildings[0].minH = 19; // === h − 1, exclusive upper bound
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    c.buildings[0].minH = 20;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    c.buildings[0].minH = -0.1;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    (c.buildings[0] as { minH?: unknown }).minH = NaN;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    (c.buildings[0] as { minH?: unknown }).minH = Infinity;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    (c.buildings[0] as { minH?: unknown }).minH = '5';
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    delete c.buildings[0].minH;
    expect(() => validateCity(c)).not.toThrow();
  });

  it('h up to 650 is valid', () => {
    const c = base();
    c.buildings[0].h = 650;
    expect(() => validateCity(c)).not.toThrow();
    c.buildings[0].h = 600;
    expect(() => validateCity(c)).not.toThrow();
    c.buildings[0].h = 3;
    expect(() => validateCity(c)).not.toThrow();
    c.buildings[0].h = 651;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.h/);
    c.buildings[0].h = 2.9;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.h/);
  });
});

describe('validateTileIndex', () => {
  function goodIndex(): TileIndexData {
    return {
      v: 1,
      tiled: true,
      origin: { lat: 51.5133, lon: -0.0887 },
      bbox: [-0.106, 51.506, -0.07, 51.521],
      tileSize: 1000,
      bridgeRoads: [
        { id: 1, name: 'Bridge', cls: 'primary', bridge: true, pts: [[0, 0], [100, 0]] },
      ],
      landmarks: [{ name: 'Bank', x: 0, z: 0 }],
      places: [{ name: 'Centre', x: 0, z: 0 }],
      tiles: {
        '0_0': { buildings: 1, roads: 1, trees: 0, bytes: 100 },
        '-3_2': { buildings: 0, roads: 2, trees: 1, bytes: 200 },
      },
    };
  }

  it('accepts a good index and returns the same object', () => {
    const idx = goodIndex();
    expect(validateTileIndex(idx)).toBe(idx);
  });

  it('rejects a bad tile key', () => {
    const idx = goodIndex();
    idx.tiles = { '3_2_1': { buildings: 1, roads: 0, trees: 0, bytes: 40 } };
    expect(() => validateTileIndex(idx)).toThrow(/bad tile key/);
    idx.tiles = { '3.5_2': { buildings: 1, roads: 0, trees: 0, bytes: 40 } };
    expect(() => validateTileIndex(idx)).toThrow(/bad tile key/);
  });

  it('rejects a non-positive tileSize', () => {
    const idx = goodIndex();
    idx.tileSize = 0;
    expect(() => validateTileIndex(idx)).toThrow(/tileSize/);
    idx.tileSize = -100;
    expect(() => validateTileIndex(idx)).toThrow(/tileSize/);
    idx.tileSize = NaN;
    expect(() => validateTileIndex(idx)).toThrow(/tileSize/);
  });

  it('rejects missing bridgeRoads', () => {
    const idx = goodIndex();
    delete (idx as { bridgeRoads?: unknown }).bridgeRoads;
    expect(() => validateTileIndex(idx)).toThrow(/bridgeRoads/);
  });

  it('rejects a monolithic (non-tiled) file', () => {
    const idx = goodIndex();
    (idx as { tiled: unknown }).tiled = false;
    expect(() => validateTileIndex(idx)).toThrow(/tiled/);
  });
});
