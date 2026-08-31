/**
 * Unit tests for `src/data/cities.ts` — the CityInfo registry and
 * `cityById` lookup. Every entry's `defaultSpawn` is verified against the
 * committed `public/data/<file>.bbox` so a picker choice always lands
 * inside its own city.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CITIES,
  cityById,
  resolveBootRender,
  type CityInfo,
} from '../src/data/cities';
import { SPAWN_PRESETS } from '../src/data/spawn';

interface DatasetHeader {
  bbox: [number, number, number, number];
}

/** Load a dataset's bbox from `public/data/<file>` without touching mesh data. */
function loadBbox(file: string): DatasetHeader['bbox'] {
  const raw = readFileSync(resolve(__dirname, '..', 'public', file), 'utf8');
  return (JSON.parse(raw) as DatasetHeader).bbox;
}

describe('CITIES registry', () => {
  it('lists london first (default), then kyiv, sf, nyc, tokyo', () => {
    expect(CITIES.map((c) => c.id)).toEqual([
      'london',
      'kyiv',
      'sf',
      'nyc',
      'tokyo',
    ]);
  });

  it('carries the expected labels, files and blurbs', () => {
    const london = CITIES[0];
    expect(london.label).toBe('LONDON');
    expect(london.file).toBe('data/london/index.json');
    expect(london.defaultSpawn).toBe('bigben');
    expect(london.blurb).toBe('City of London & Westminster · flat');
    expect(london.tiled).toBe(true);

    const kyiv = CITIES[1];
    expect(kyiv.label).toBe('KYIV');
    expect(kyiv.file).toBe('data/kyiv/index.json');
    expect(kyiv.defaultSpawn).toBe('maidan');
    expect(kyiv.blurb).toBe('Central Kyiv · Dnipro hills, 120 m of relief');
    expect(kyiv.tiled).toBe(true);

    const sf = CITIES[2];
    expect(sf.label).toBe('SAN FRANCISCO');
    expect(sf.file).toBe('data/sf/index.json');
    expect(sf.defaultSpawn).toBe('ggb');
    expect(sf.blurb).toBe('Downtown to the Golden Gate · hills & bay');
    expect(sf.tiled).toBe(true);

    const nyc = CITIES[3];
    expect(nyc.label).toBe('MANHATTAN');
    expect(nyc.file).toBe('data/nyc/index.json');
    expect(nyc.defaultSpawn).toBe('brooklynbridge');
    expect(nyc.blurb).toBe('Battery to Central Park · skyscrapers & bridges');
    expect(nyc.tiled).toBe(true);

    const tokyo = CITIES[4];
    expect(tokyo.label).toBe('TOKYO');
    expect(tokyo.file).toBe('data/tokyo/index.json');
    expect(tokyo.defaultSpawn).toBe('tokyostation');
    expect(tokyo.blurb).toBe('Imperial Palace to the Skytree · streamed');
    expect(tokyo.tiled).toBe(true);
  });

  it('every registry entry is tiled with a data/<id>/index.json path', () => {
    for (const city of CITIES) {
      expect(city.tiled).toBe(true);
      expect(city.file).toBe(`data/${city.id}/index.json`);
    }
  });

  it('only tokyo carries defaultRender, and its value is matrix', () => {
    for (const city of CITIES) {
      if (city.id === 'tokyo') {
        expect(city.defaultRender).toBe('matrix');
      } else {
        expect(city.defaultRender).toBeUndefined();
      }
    }
  });
});

describe('cityById', () => {
  it("cityById('KYIV ') → kyiv (trimmed + case-insensitive)", () => {
    expect(cityById('KYIV ')?.id).toBe('kyiv');
    expect(cityById('  london')?.id).toBe('london');
    expect(cityById('KyIv')?.id).toBe('kyiv');
  });

  it('cityById(null) → undefined', () => {
    expect(cityById(null)).toBeUndefined();
  });

  it('cityById(undefined) → undefined', () => {
    expect(cityById(undefined)).toBeUndefined();
  });

  it("cityById('') → undefined", () => {
    expect(cityById('')).toBeUndefined();
    expect(cityById('   ')).toBeUndefined();
  });

  it('cityById of an unknown id → undefined', () => {
    expect(cityById('paris')).toBeUndefined();
  });

  it("cityById('sf') → the San Francisco entry (resolvable)", () => {
    expect(cityById('sf')?.id).toBe('sf');
    expect(cityById('SF ')?.id).toBe('sf');
  });

  it("cityById('nyc') → the Manhattan entry (resolvable, wave 10)", () => {
    expect(cityById('nyc')?.id).toBe('nyc');
    expect(cityById(' NYC ')?.id).toBe('nyc');
    expect(cityById('NyC')?.label).toBe('MANHATTAN');
  });

  it("cityById('tokyo') → the Tokyo entry (resolvable, wave 11)", () => {
    expect(cityById('tokyo')?.id).toBe('tokyo');
    expect(cityById(' TOKYO ')?.id).toBe('tokyo');
    expect(cityById('Tokyo')?.label).toBe('TOKYO');
  });
});

describe("resolveBootRender — architecture.md §4.20 precedence chain", () => {
  // The precedence tests live here (not tests/settings.test.ts) because the
  // chain function lives in src/data/cities.ts: settings.ts is frozen
  // (read-only per the ticket's out-of-scope fence), so it cannot host it.
  const tokyo = cityById('tokyo') as CityInfo;
  const london = cityById('london') as CityInfo;

  it('explicit URL style beats the city default', () => {
    expect(resolveBootRender('ascii', tokyo, 'gloom')).toBe('ascii');
    expect(resolveBootRender('pico8', tokyo, 'gloom')).toBe('pico8');
  });

  it('city default beats the persisted setting', () => {
    expect(resolveBootRender(undefined, tokyo, 'gloom')).toBe('matrix');
    expect(resolveBootRender(undefined, tokyo, 'ascii')).toBe('matrix');
  });

  it('persisted setting used when the city has no default', () => {
    expect(resolveBootRender(undefined, london, 'gloom')).toBe('gloom');
    expect(resolveBootRender(undefined, london, 'ascii')).toBe('ascii');
  });

  it('unknown defaultRender id falls through to the persisted setting', () => {
    const bogus: CityInfo = { ...london, defaultRender: 'not-a-style' };
    expect(resolveBootRender(undefined, bogus, 'pico8')).toBe('pico8');
  });

  it('synthetic unaffected — no city, persisted setting wins', () => {
    expect(resolveBootRender(undefined, undefined, 'pico8')).toBe('pico8');
    expect(resolveBootRender(undefined, undefined, 'ascii')).toBe('ascii');
  });
});

describe("every CITIES entry's defaultSpawn is a fixed-coordinate preset inside its bbox", () => {
  for (const city of CITIES) {
    it(`${city.id}.defaultSpawn (${city.defaultSpawn}) is a fixed coordinate inside its bbox`, () => {
      const preset = SPAWN_PRESETS[city.defaultSpawn];
      expect(preset).toBeDefined();
      // Must be a fixed-coordinate preset (has lon/lat, no `building`) — the
      // fallback must resolve to a coordinate `resolveSpawn` can project.
      expect('building' in preset).toBe(false);
      expect('lon' in preset).toBe(true);
      const fixed = preset as { lon: number; lat: number; bearingDeg: number };
      expect(Number.isFinite(fixed.lon)).toBe(true);
      expect(Number.isFinite(fixed.lat)).toBe(true);
      expect(Number.isFinite(fixed.bearingDeg)).toBe(true);
      const bbox = loadBbox(city.file);
      expect(fixed.lon).toBeGreaterThanOrEqual(bbox[0]);
      expect(fixed.lon).toBeLessThanOrEqual(bbox[2]);
      expect(fixed.lat).toBeGreaterThanOrEqual(bbox[1]);
      expect(fixed.lat).toBeLessThanOrEqual(bbox[3]);
    });
  }
});

describe('every city sizeBytes equals the committed index.json size', () => {
  for (const city of CITIES) {
    it(`${city.id}.sizeBytes (${city.sizeBytes}) is within 1 % of stat(public/${city.file})`, () => {
      const actual = statSync(resolve(__dirname, '..', 'public', city.file)).size;
      expect(actual).toBeGreaterThan(0);
      expect(city.sizeBytes).toBe(actual);
    });
  }
});
