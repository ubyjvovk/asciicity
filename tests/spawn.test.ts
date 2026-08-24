/**
 * Unit tests for spawn presets and `?at=` resolution (`src/data/spawn.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  landmarkSpawn,
  parseAt,
  resolveSpawn,
  SPAWN_PRESETS,
} from '../src/data/spawn';
import type { CityData } from '../src/data/types';
import { project } from '../src/geo';

// Bank preset doublets as the test origin (matches SPAWN_PRESETS.bank).
const ORIGIN = { lat: 51.5133, lon: -0.0887 };

/** Wrap `a` into `(−π, π]` to compare against the resolver's yaw output. */
function normalizeAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r <= -Math.PI) r += twoPi;
  return r;
}

// Tiny hand-made city: "Test Tower" is a 20×20 square centred at (100, 0);
// road vertices sit 30 / 70 / 120 m from that centroid along +x.
const CITY: Pick<CityData, 'buildings' | 'roads'> = {
  buildings: [
    {
      id: 1,
      h: 10,
      name: 'Test Tower',
      poly: [
        [90, -10],
        [110, -10],
        [110, 10],
        [90, 10],
      ],
    },
  ],
  roads: [
    {
      id: 1,
      cls: 'residential',
      pts: [
        [130, 0],
        [170, 0],
        [220, 0],
      ],
    },
  ],
};

describe('parseAt', () => {
  it('returns null for a null input', () => {
    expect(parseAt(null)).toBeNull();
  });

  it('returns null for an empty / whitespace input', () => {
    expect(parseAt('')).toBeNull();
    expect(parseAt('   ')).toBeNull();
  });

  it('returns the preset key for a matching name, case-insensitive and trimmed', () => {
    expect(parseAt('Gherkin ')).toEqual({ preset: 'gherkin' });
    expect(parseAt('  BANK')).toEqual({ preset: 'bank' });
  });

  it('parses each Westminster preset key', () => {
    expect(parseAt('bigben')).toEqual({ preset: 'bigben' });
    expect(parseAt('parliament')).toEqual({ preset: 'parliament' });
    expect(parseAt('trafalgar')).toEqual({ preset: 'trafalgar' });
    expect(parseAt('embankment')).toEqual({ preset: 'embankment' });
  });

  it('returns the numeric coordinates for lon,lat,bearing', () => {
    expect(parseAt('-0.0984,51.5138,90')).toEqual({
      lon: -0.0984,
      lat: 51.5138,
      bearingDeg: 90,
    });
  });

  it('returns coordinates without bearing (bearing optional)', () => {
    expect(parseAt('-0.0984,51.5138')).toEqual({
      lon: -0.0984,
      lat: 51.5138,
    });
  });

  it('returns null for a bad coordinate value', () => {
    expect(parseAt('-0.0984,abc')).toBeNull();
  });

  it('returns null for an unknown name or wrong arity', () => {
    expect(parseAt('nope')).toBeNull();
    expect(parseAt('-0.0984')).toBeNull();
    expect(parseAt('1,2,3,4')).toBeNull();
  });
});

describe('resolveSpawn', () => {
  it('defaults to the bigben preset on Westminster Bridge with yaw 268°', () => {
    const [ex, ez] = project(-0.12235, 51.50085, ORIGIN);
    const spawn = resolveSpawn(null, ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(ex, 6);
    expect(spawn.z).toBeCloseTo(ez, 6);
    expect(spawn.yaw).toBeCloseTo(normalizeAngle((268 * Math.PI) / 180), 6);
  });

  it('defaults to bigben for an empty or unknown param', () => {
    const [ex, ez] = project(-0.12235, 51.50085, ORIGIN);
    for (const param of ['', 'nowhere']) {
      const spawn = resolveSpawn(param, ORIGIN, () => false);
      expect(spawn.x).toBeCloseTo(ex, 6);
      expect(spawn.z).toBeCloseTo(ez, 6);
      expect(spawn.yaw).toBeCloseTo(
        normalizeAngle((268 * Math.PI) / 180),
        6,
      );
    }
  });

  it('resolves the bigben preset to its projected point with the preset yaw', () => {
    const spawn = resolveSpawn('bigben', ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(
      project(-0.12235, 51.50085, ORIGIN)[0],
      6,
    );
    expect(spawn.z).toBeCloseTo(
      project(-0.12235, 51.50085, ORIGIN)[1],
      6,
    );
    expect(spawn.yaw).toBeCloseTo(normalizeAngle((268 * Math.PI) / 180), 6);
  });

  it('resolves the parliament preset to its projected point with yaw 90°', () => {
    const spawn = resolveSpawn('parliament', ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(
      project(-0.12655, 51.5006, ORIGIN)[0],
      6,
    );
    expect(spawn.z).toBeCloseTo(
      project(-0.12655, 51.5006, ORIGIN)[1],
      6,
    );
    expect(spawn.yaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('resolves the trafalgar preset to its projected point with yaw 180°', () => {
    const spawn = resolveSpawn('trafalgar', ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(
      project(-0.128, 51.5079, ORIGIN)[0],
      6,
    );
    expect(spawn.z).toBeCloseTo(
      project(-0.128, 51.5079, ORIGIN)[1],
      6,
    );
    expect(spawn.yaw).toBeCloseTo(Math.PI, 6);
  });

  it('resolves the embankment preset to its projected point with yaw 120°', () => {
    const spawn = resolveSpawn('embankment', ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(
      project(-0.122, 51.5074, ORIGIN)[0],
      6,
    );
    expect(spawn.z).toBeCloseTo(
      project(-0.122, 51.5074, ORIGIN)[1],
      6,
    );
    expect(spawn.yaw).toBeCloseTo(normalizeAngle((120 * Math.PI) / 180), 6);
  });

  it('still resolves the bank preset to the origin with yaw −π/2', () => {
    const spawn = resolveSpawn('bank', ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(0, 6);
    expect(spawn.z).toBeCloseTo(0, 6);
    expect(spawn.yaw).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('a named-building preset with no city falls back to the bigben coordinates', () => {
    // `gherkin` is a building preset; without a city there is nothing to
    // resolve against, so it must fall back to the bigben coordinate preset.
    const spawn = resolveSpawn('gherkin', ORIGIN, () => false);
    const [ex, ez] = project(-0.12235, 51.50085, ORIGIN);
    expect(spawn.x).toBeCloseTo(ex, 6);
    expect(spawn.z).toBeCloseTo(ez, 6);
    expect(spawn.yaw).toBeCloseTo(normalizeAngle((268 * Math.PI) / 180), 6);
  });

  it('resolves a named-building preset against the city via landmarkSpawn', () => {
    // A city that does contain "30 St Mary Axe" → landmarkSpawn wins.
    const gherkinCity: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [
        {
          id: 7,
          h: 20,
          name: '30 St Mary Axe',
          poly: [
            [90, -10],
            [110, -10],
            [110, 10],
            [90, 10],
          ],
        },
      ],
      roads: [{ id: 2, cls: 'secondary', pts: [[170, 0]] }],
    };
    const spawn = resolveSpawn('gherkin', ORIGIN, () => false, gherkinCity);
    expect(spawn.x).toBeCloseTo(170, 6);
    expect(spawn.z).toBeCloseTo(0, 6);
  });

  it('falls back to the bigben preset when the named building is absent', () => {
    // CITY has no "30 St Mary Axe" → resolveSpawn must land on bigben.
    const spawn = resolveSpawn('gherkin', ORIGIN, () => false, CITY);
    const [ex, ez] = project(-0.12235, 51.50085, ORIGIN);
    expect(spawn.x).toBeCloseTo(ex, 6);
    expect(spawn.z).toBeCloseTo(ez, 6);
    expect(spawn.yaw).toBeCloseTo(normalizeAngle((268 * Math.PI) / 180), 6);
  });

  it('resolves explicit coordinates with a bearing', () => {
    const spawn = resolveSpawn('-0.0984,51.5138,90', ORIGIN, () => false);
    const [ex, ez] = project(-0.0984, 51.5138, ORIGIN);
    expect(spawn.x).toBeCloseTo(ex, 6);
    expect(spawn.z).toBeCloseTo(ez, 6);
    expect(spawn.yaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('walks +x when the spawn point is blocked, stopping at the first free cell', () => {
    // Uses `bank` so the search starts at x0 = 0; blocked true for x < 3 →
    // the first free step is x = 3.
    const spawn = resolveSpawn('bank', ORIGIN, (p) => p[0] < 3);
    expect(spawn.x).toBe(3);
    expect(spawn.z).toBeCloseTo(0, 6);
    expect(spawn.yaw).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('returns the original point when blocked for the whole 200 m search', () => {
    const spawn = resolveSpawn('bank', ORIGIN, () => true);
    expect(spawn.x).toBeCloseTo(0, 6);
    expect(spawn.z).toBeCloseTo(0, 6);
    expect(spawn.yaw).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('exposes presets with lower-case keys and labels', () => {
    expect(Object.keys(SPAWN_PRESETS).sort()).toEqual([
      'bank',
      'barbican',
      'bigben',
      'embankment',
      'gherkin',
      'leadenhall',
      'liverpoolst',
      'lloyds',
      'monument',
      'parliament',
      'stpauls',
      'tower',
      'trafalgar',
      'walkietalkie',
    ]);
    expect(SPAWN_PRESETS.gherkin.label).toBe('Facing the Gherkin');
    expect(SPAWN_PRESETS.bigben.label).toBe(
      'Westminster Bridge, facing Big Ben',
    );
  });
});

describe('landmarkSpawn', () => {
  it('picks the 70 m road vertex and faces the building centroid', () => {
    const spawn = landmarkSpawn('test tower', CITY);
    expect(spawn).not.toBeNull();
    expect(spawn!.x).toBeCloseTo(170, 6);
    expect(spawn!.z).toBeCloseTo(0, 6);
    // Forward vector (sin yaw, −cos yaw) must point at the centroid.
    const fx = Math.sin(spawn!.yaw);
    const fz = -Math.cos(spawn!.yaw);
    const dx = 100 - spawn!.x;
    const dz = 0 - spawn!.z;
    const len = Math.hypot(dx, dz);
    const dot = (fx * dx + fz * dz) / len;
    expect(dot).toBeGreaterThan(0.99);
    expect(spawn!.yaw).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('matches the name case-insensitively as a substring', () => {
    expect(landmarkSpawn('TEST TOWER', CITY)?.x).toBeCloseTo(170, 6);
    expect(landmarkSpawn('tower', CITY)?.x).toBeCloseTo(170, 6);
  });

  it('returns null for an unknown or unnamed building', () => {
    expect(landmarkSpawn('nope', CITY)).toBeNull();
    const noName: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [{ id: 2, h: 10, poly: [[0, 0], [10, 0], [10, 10], [0, 10]] }],
      roads: CITY.roads,
    };
    expect(landmarkSpawn('base', noName)).toBeNull();
  });

  it('falls back to a road vertex within 200 m when none is in range', () => {
    // Road vertex at 170 m (within 200, outside [30, 130] m ring).
    const farCity: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [{ id: 1, h: 10, name: 'Test Tower', poly: CITY.buildings[0].poly }],
      roads: [{ id: 9, cls: 'service', pts: [[270, 0]] }],
    };
    const spawn = landmarkSpawn('test tower', farCity);
    expect(spawn).not.toBeNull();
    expect(spawn!.x).toBeCloseTo(270, 6);
  });

  it('returns null when no road vertex is within 200 m of the centroid', () => {
    const emptyCity: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [{ id: 1, h: 10, name: 'Test Tower', poly: CITY.buildings[0].poly }],
      roads: [{ id: 3, cls: 'footway', pts: [[500, 0]] }],
    };
    expect(landmarkSpawn('test tower', emptyCity)).toBeNull();
  });
});
