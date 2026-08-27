/**
 * Unit tests for spawn presets and `?at=` resolution (`src/data/spawn.ts`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  landmarkSpawn,
  parseAt,
  presetsFor,
  resolveSpawn,
  SPAWN_PRESETS,
} from '../src/data/spawn';
import type { CityData, Vec2 } from '../src/data/types';
import { project } from '../src/geo';
import { CollisionGrid, distToSegment } from '../src/world/collision';
import { applyLandmarks } from '../src/world/landmarks';
import { ROAD_WIDTH } from '../src/world/roads';

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

  it('passes its blocked function through to landmarkSpawn (skips blocked vertices)', () => {
    // h=10 → target 82 m, range [42,142]. 100 m is nearest but blocked; the
    // resolver must hand `blocked` to `landmarkSpawn` so it picks the 60 m one.
    const gherkinCity: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [{
        id: 7,
        h: 10,
        name: '30 St Mary Axe',
        poly: [[-10, -10], [10, -10], [10, 10], [-10, 10]],
      }],
      roads: [{ id: 2, cls: 'secondary', pts: [[100, 0], [60, 0]] }],
    };
    const spawn = resolveSpawn('gherkin', ORIGIN, (p) => p[0] === 100, gherkinCity);
    expect(spawn.x).toBeCloseTo(60, 6);
    expect(spawn.z).toBeCloseTo(0, 6);
  });

  it('falls through to the preset fixed coordinate when every vertex is blocked', () => {
    // Nothing free on the roads → landmarkSpawn returns null → resolveSpawn
    // uses the hybrid preset's own WGS84 fallback (which walks +x).
    const cityBuild: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [{
        id: 1,
        h: 10,
        name: 'Saint Sophia Cathedral',
        poly: [[-10, -10], [10, -10], [10, 10], [-10, 10]],
      }],
      roads: [{ id: 2, cls: 'residential', pts: [[60, 0]] }],
    };
    const sop = SPAWN_PRESETS.sophia as { lon: number; lat: number };
    const [ex, ez] = project(sop.lon, sop.lat, ORIGIN);
    const spawn = resolveSpawn('sophia', ORIGIN, () => true, cityBuild);
    expect(Math.hypot(spawn.x - ex, spawn.z - ez)).toBeLessThan(5);
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
    // London + Westminster + Kyiv (wave 7, T-0059) presets.
    expect(Object.keys(SPAWN_PRESETS).sort()).toEqual([
      'andriyivskyy',
      'arch',
      'arsenalna',
      'bank',
      'barbican',
      'bessarabka',
      'bigben',
      'embankment',
      'funicular',
      'gherkin',
      'glassbridge',
      'goldengate',
      'hydropark',
      'lavra',
      'leadenhall',
      'liverpoolst',
      'lloyds',
      'maidan',
      'metrobridge',
      'michael',
      'monument',
      'motherland',
      'nicholas',
      'olimpiyskiy',
      'parkbridge',
      'parliament',
      'podil',
      'rada',
      'sophia',
      'stpauls',
      'tower',
      'trafalgar',
      'volodymyr',
      'walkietalkie',
    ]);
    expect(SPAWN_PRESETS.gherkin.label).toBe('Facing the Gherkin');
    expect(SPAWN_PRESETS.bigben.label).toBe(
      'Westminster Bridge, facing Big Ben',
    );
  });

  it('datadriven presets carry a city and a building name', () => {
    expect(SPAWN_PRESETS.gherkin.city).toBe('london');
    expect(SPAWN_PRESETS.lavra.city).toBe('kyiv');
    expect('building' in SPAWN_PRESETS.lavra).toBe(true);
  });
});

describe('presetsFor', () => {
  it("presetsFor('kyiv') has no London keys and vice versa", () => {
    const kyiv = new Set(presetsFor('kyiv').map(([k]) => k));
    const london = new Set(presetsFor('london').map(([k]) => k));
    expect(kyiv.has('maidan')).toBe(true);
    expect(kyiv.has('sophia')).toBe(true);
    expect(kyiv.has('bank')).toBe(false);
    expect(london.has('bank')).toBe(true);
    expect(london.has('sophia')).toBe(false);
    expect(london.has('maidan')).toBe(false);
  });

  it('every preset carries a city and every city id occurs in its presets', () => {
    for (const [, p] of Object.entries(SPAWN_PRESETS)) {
      expect(['london', 'kyiv']).toContain(p.city);
    }
    const all = new Set(presetsFor('kyiv').map(([k]) => k));
    for (const [k, p] of Object.entries(SPAWN_PRESETS)) {
      if (p.city === 'kyiv') expect(all.has(k)).toBe(true);
    }
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

  it('exact match beats includes (Sophia Hotel listed before Saint Sophia Cathedral)', () => {
    // 'Saint Sophia Cathedral Hotel' is listed first and would win a bare
    // substring search, but an EXACT name match must beat it and pick the
    // real cathedral instead.
    const exactCity: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [
        {
          id: 1,
          h: 10,
          name: 'Saint Sophia Cathedral Hotel',
          poly: [
            [990, -10],
            [1010, -10],
            [1010, 10],
            [990, 10],
          ] as Vec2[],
        },
        {
          id: 2,
          h: 10,
          name: 'Saint Sophia Cathedral',
          poly: [
            [-10, -10],
            [10, -10],
            [10, 10],
            [-10, 10],
          ] as Vec2[],
        },
      ],
      roads: [{ id: 5, cls: 'residential', pts: [[-70, 0]] }],
    };
    const spawn = landmarkSpawn('Saint Sophia Cathedral', exactCity);
    expect(spawn).not.toBeNull();
    // Picked the exact cathedral (centroid ~0), not the hotel (~1000).
    expect(spawn!.x).toBeCloseTo(-70, 6);
  });

  it('scales the default spawn distance with building height: 96 m → 150–220 m, 10 m → 70–130 m', () => {
    const build = (h: number, roadDist: number): Pick<CityData, 'buildings' | 'roads'> => ({
      buildings: [
        {
          id: 1,
          h,
          name: 'Tall Tower',
          poly: [
            [-10, -10],
            [10, -10],
            [10, 10],
            [-10, 10],
          ] as Vec2[],
        },
      ],
      roads: [{ id: 2, cls: 'residential', pts: [[roadDist, 0]] }],
    });
    // 96 m height → targetDist 185.2 m, range [145.2, 245.2] → road at 200.
    const tall = landmarkSpawn('tall tower', build(96, 200));
    expect(tall).not.toBeNull();
    expect(Math.hypot(tall!.x, tall!.z)).toBeGreaterThanOrEqual(150);
    expect(Math.hypot(tall!.x, tall!.z)).toBeLessThanOrEqual(220);
    // 10 m height → targetDist 82 m, range [42, 142] → road at 100.
    const low = landmarkSpawn('tall tower', build(10, 100));
    expect(low).not.toBeNull();
    expect(Math.hypot(low!.x, low!.z)).toBeGreaterThanOrEqual(70);
    expect(Math.hypot(low!.x, low!.z)).toBeLessThanOrEqual(130);
  });

  it('an explicit targetDist argument overrides the height-derived default', () => {
    const cityBuild: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [
        {
          id: 1,
          h: 96,
          name: 'Tall Tower',
          poly: [
            [-10, -10],
            [10, -10],
            [10, 10],
            [-10, 10],
          ] as Vec2[],
        },
      ],
      roads: [{ id: 2, cls: 'residential', pts: [[70, 0]] }],
    };
    // Explicit 70 wins over the 96 m → 185.2 m default.
    const spawn = landmarkSpawn('tall tower', cityBuild, 70);
    expect(spawn).not.toBeNull();
    expect(spawn!.x).toBeCloseTo(70, 6);
  });

  it('returns null for an unknown or unnamed building', () => {
    expect(landmarkSpawn('nope', CITY)).toBeNull();
    const noName: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [{ id: 2, h: 10, poly: [[0, 0], [10, 0], [10, 10], [0, 10]] }],
      roads: CITY.roads,
    };
    expect(landmarkSpawn('base', noName)).toBeNull();
  });

  it('skips a blocked nearest-destination vertex and picks the next free one', () => {
    // Centroid at (0,0), h=10 → target 82 m, range [42,142]. 100 m is the
    // closest in-range vertex but is blocked; the free 60 m vertex must win.
    const cityBuild: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [{
        id: 1,
        h: 10,
        name: 'Test Tower',
        poly: [[-10, -10], [10, -10], [10, 10], [-10, 10]],
      }],
      roads: [{ id: 2, cls: 'residential', pts: [[100, 0], [60, 0]] }],
    };
    const spawn = landmarkSpawn('test tower', cityBuild, undefined, (p) => p[0] === 100);
    expect(spawn).not.toBeNull();
    expect(spawn!.x).toBeCloseTo(60, 6);
    expect(spawn!.z).toBeCloseTo(0, 6);
  });

  it('returns null when every road vertex is blocked', () => {
    const cityBuild: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [{
        id: 1,
        h: 10,
        name: 'Test Tower',
        poly: [[-10, -10], [10, -10], [10, 10], [-10, 10]],
      }],
      roads: [{ id: 2, cls: 'residential', pts: [[60, 0], [100, 0]] }],
    };
    expect(landmarkSpawn('test tower', cityBuild, undefined, () => true)).toBeNull();
  });

  it('a wall 6 m in front of the nearest vertex picks a clear vertex further away', () => {
    // Building at (0,0), h=10 → target 82, range [42,142]. Vertex 100 is the
    // nearest to target, but a wall slab at x≈94 sits 6 m ahead along its
    // corridor toward the centroid; the clear 60 m vertex must win.
    const cityBuild: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [{
        id: 1,
        h: 10,
        name: 'Test Tower',
        poly: [[-10, -10], [10, -10], [10, 10], [-10, 10]],
      }],
      roads: [{ id: 2, cls: 'residential', pts: [[100, 0], [60, 0]] }],
    };
    // Vertical wall slab [90, 98] across the x-axis; ignores the radius arg.
    const blocked = (p: Vec2): boolean => Math.abs(p[0] - 94) < 4;
    const spawn = landmarkSpawn('test tower', cityBuild, undefined, blocked);
    expect(spawn).not.toBeNull();
    // The wall in front of 100 rejects it; the clear 60 m vertex is chosen.
    expect(spawn!.x).toBeCloseTo(60, 6);
    expect(spawn!.z).toBeCloseTo(0, 6);
  });

  it('returns null when every vertex has a wall within 40 m of its corridor', () => {
    // Both vertices keep 6 m footprint clearance, but a wall slab [38, 62]
    // lies inside every corridor toward the centroid (100 at k=40, 70 at
    // k=12) → no candidate survives, so landmarkSpawn returns null.
    const cityBuild: Pick<CityData, 'buildings' | 'roads'> = {
      buildings: [{
        id: 1,
        h: 10,
        name: 'Test Tower',
        poly: [[-10, -10], [10, -10], [10, 10], [-10, 10]],
      }],
      roads: [{ id: 2, cls: 'residential', pts: [[100, 0], [70, 0]] }],
    };
    const blocked = (p: Vec2): boolean => Math.abs(p[0] - 50) < 12;
    expect(landmarkSpawn('test tower', cityBuild, undefined, blocked)).toBeNull();
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

// Kyiv-specific coverage for the T-0045 per-city fallback / bbox check.
describe('resolveSpawn (per-city fallback + bbox check)', () => {
  const KYIV: CityData = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'public', 'data', 'kyiv.json'), 'utf8'),
  );
  const KYIV_ORIGIN = KYIV.origin;
  const KYIV_BBOX = KYIV.bbox;

  it('unknown London preset in Kyiv falls back to the given fallback preset', () => {
    // `gherkin` is a London-only named-building preset that will not resolve
    // in kyiv.json → resolveSpawn must land on the `maidan` fallback.
    const spawn = resolveSpawn(
      'gherkin',
      KYIV_ORIGIN,
      () => false,
      KYIV,
      'maidan',
    );
    const maidan = SPAWN_PRESETS.maidan as { lon: number; lat: number };
    const [ex, ez] = project(maidan.lon, maidan.lat, KYIV_ORIGIN);
    expect(Math.hypot(spawn.x - ex, spawn.z - ez)).toBeLessThan(5);
  });

  it("a London coordinate '-0.1,51.5' in Kyiv falls back to the fallback preset", () => {
    // The point is outside the Kyiv bbox → drop it and take the maidan preset.
    const spawn = resolveSpawn(
      '-0.1,51.5',
      KYIV_ORIGIN,
      () => false,
      KYIV,
      'maidan',
    );
    const maidan = SPAWN_PRESETS.maidan as { lon: number; lat: number };
    const [ex, ez] = project(maidan.lon, maidan.lat, KYIV_ORIGIN);
    expect(Math.hypot(spawn.x - ex, spawn.z - ez)).toBeLessThan(5);
  });

  it('every Kyiv preset coordinate falls back inside the Kyiv bbox', () => {
    for (const [key, preset] of presetsFor('kyiv')) {
      const p = preset as { lon?: number; lat?: number };
      expect(p.lon).toBeDefined();
      expect(p.lat).toBeDefined();
      expect(p.lon!).toBeGreaterThanOrEqual(KYIV_BBOX[0]);
      expect(p.lon!).toBeLessThanOrEqual(KYIV_BBOX[2]);
      expect(p.lat!).toBeGreaterThanOrEqual(KYIV_BBOX[1]);
      expect(p.lat!).toBeLessThanOrEqual(KYIV_BBOX[3]);
    }
  });

  it('every Kyiv building preset resolves via landmarkSpawn against applyLandmarks(kyiv.json)', () => {
    // The fixes (architecture.md §4.13) make the named buildings resolvable.
    const city = applyLandmarks(KYIV, 'kyiv');
    const buildingKeys = presetsFor('kyiv')
      .filter(([, p]) => 'building' in p)
      .map(([k]) => k);
    expect(buildingKeys.length).toBeGreaterThan(5);
    for (const key of buildingKeys) {
      const preset = SPAWN_PRESETS[key] as { building: string };
      const found = landmarkSpawn(preset.building, city);
      expect(found, `landmarkSpawn(${preset.building}) on applied kyiv`).not.toBeNull();
    }
  });

  it('throws when the fallback preset is a building form (no fixed coordinate)', () => {
    // `sophia` in Kyiv is a hybrid (building + coord), but with the coord
    // stripped the resolver has nothing to fall back to. Sanity check by
    // asking for an unknown-fallback name — `stpauls` in London is pure
    // building (no coord), so using it as a fallback in Kyiv must throw.
    expect(() =>
      // Force the bbox-outside branch → must consult the fallback.
      resolveSpawn('-0.1,51.5', KYIV_ORIGIN, () => false, KYIV, 'stpauls'),
    ).toThrow(/fixed-coordinate/);
  });
});

// T-0047: the Parkovyi and Klitschko bridges are `highway=cycleway` +
// `bridge=yes`, so resolveSpawn against the committed kyiv.json must land on
// an unblocked bridge vertex and stay walkable 20 m along its bearing.
describe('Kyiv bridge presets (T-0047)', () => {
  const KYIV: CityData = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'public', 'data', 'kyiv.json'), 'utf8'),
  );
  // Build the SAME CollisionGrid main.ts builds (integration.md §5): water
  // rings as fake footprints, bridge roads as corridors over them.
  const collision = new CollisionGrid(
    [
      ...KYIV.buildings,
      ...(KYIV.water ?? []).map((poly, i) => ({ id: -1 - i, h: 1, poly })),
    ],
    25,
    KYIV.roads
      .filter((r) => r.bridge)
      .map((r) => ({ pts: r.pts, halfWidth: ROAD_WIDTH[r.cls] / 2 + 1 })),
  );

  // Every pedestrian bridge polyline in the regenerated dataset.
  const bridgeRoads = KYIV.roads.filter(
    (r) => r.bridge === true && r.cls === 'pedestrian',
  );

  for (const key of ['parkbridge', 'glassbridge'] as const) {
    it(`${key} spawns on an unblocked bridge vertex and can walk 20 m along its bearing`, () => {
      const preset = SPAWN_PRESETS[key] as {
        lon: number;
        lat: number;
        bearingDeg: number;
      };
      const spawn = resolveSpawn(
        key,
        KYIV.origin,
        (p) => collision.blocked(p),
        KYIV,
        'maidan',
      );

      // 1. The spawn point is not blocked.
      expect(collision.blocked([spawn.x, spawn.z])).toBe(false);

      // 2. It lies within 3 m of a bridge:true pedestrian polyline.
      expect(bridgeRoads.length).toBeGreaterThan(0);
      let best = Infinity;
      for (const r of bridgeRoads) {
        for (let i = 0; i < r.pts.length - 1; i++) {
          const d = distToSegment([spawn.x, spawn.z], r.pts[i], r.pts[i + 1]);
          if (d < best) best = d;
        }
      }
      expect(best).toBeLessThan(3);

      // 3. It stays unblocked 20 m further along its bearing: forward
      //    (sin yaw, −cos yaw) from the preset's whole-degree bearing.
      const yaw = (preset.bearingDeg * Math.PI) / 180;
      const fx = Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const from: Vec2 = [spawn.x, spawn.z];
      const to: Vec2 = [spawn.x + 20 * fx, spawn.z + 20 * fz];
      expect(collision.resolve(from, to)).toEqual(to);
    });
  }
});

// T-0059 rework: building presets must not spawn inside/against a building.
// `landmarkSpawn` skips road vertices that are blocked with 6 m of clearance,
// and `resolveSpawn` threads its `blocked` through. Against the real
// `CollisionGrid` (built as `main.ts` does) every Kyiv building preset must
// resolve to a point with `blocked(p, 6) === false`.
describe('Kyiv building presets resolve to unblocked points (T-0059)', () => {
  const KYIV: CityData = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'public', 'data', 'kyiv.json'), 'utf8'),
  );
  // Build the SAME CollisionGrid main.ts builds, but from the APPLIED city so
  // the Motherland Monument footprint (and the fixed heights) are included.
  const city = applyLandmarks(KYIV, 'kyiv');
  const collision = new CollisionGrid(
    city.water?.length
      ? [...city.buildings, ...city.water.map((poly, i) => ({ id: -1 - i, h: 1, poly }))]
      : city.buildings,
    25,
    city.roads
      .filter((r) => r.bridge)
      .map((r) => ({ pts: r.pts, halfWidth: ROAD_WIDTH[r.cls] / 2 + 1 })),
  );

  const buildingKeys = presetsFor('kyiv')
    .filter(([, p]) => 'building' in p)
    .map(([k]) => k);

  it('every Kyiv building preset resolves to an unblocked point (blocked(p, 6) === false)', () => {
    expect(buildingKeys.length).toBeGreaterThan(5);
    const rows: string[] = [];
    for (const key of buildingKeys) {
      const preset = SPAWN_PRESETS[key] as { building: string };
      const spawn = resolveSpawn(
        key,
        city.origin,
        (p, r?: number) => collision.blocked(p, r),
        city,
        'maidan',
      );
      // The spawn must keep 6 m of clearance from every footprint.
      expect(collision.blocked([spawn.x, spawn.z], 6), `preset ${key}`).toBe(false);

      // Prove the building preset (not the fallback) was picked: distance to
      // the resolved building's centroid is within the spawn envelope.
      const needle = preset.building.toLowerCase();
      const b = city.buildings.find(
        (x) => x.name !== undefined && x.name.toLowerCase() === needle,
      );
      expect(b, `building for ${key} must resolve`).toBeDefined();
      let cx = 0;
      let cz = 0;
      for (const [px, pz] of b!.poly) {
        cx += px;
        cz += pz;
      }
      cx /= b!.poly.length;
      cz /= b!.poly.length;
      const dist = Math.hypot(spawn.x - cx, spawn.z - cz);
      expect(dist).toBeLessThanOrEqual(250);

      // The view corridor toward the centroid must be clear to k = 40: the
      // first sample where blocked(q, 1.5) is true must be beyond 40 ("inf").
      const fx = Math.sin(spawn.yaw);
      const fz = -Math.cos(spawn.yaw);
      let firstBlocked: number | 'inf' = 'inf';
      for (let k = 4; k <= 40; k += 4) {
        const q: Vec2 = [spawn.x + k * fx, spawn.z + k * fz];
        if (collision.blocked(q, 1.5)) {
          firstBlocked = k;
          break;
        }
      }
      expect(firstBlocked, `corridor for ${key}`).toBe('inf');
      rows.push(
        `${key}: (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) -> ${dist.toFixed(1)} m, corridor k=${firstBlocked}`,
      );
    }
    console.log(`[kyiv-presets] ${rows.join(' | ')}`);
  });
});
