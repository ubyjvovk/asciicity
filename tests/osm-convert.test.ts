/**
 * Unit tests for `scripts/osm-convert.mjs` (pure OSM→JSON conversion) and for
 * the committed `public/data/city.json` dataset. Covers the cases listed in
 * T-0003's acceptance criteria, by name.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  convertOverpass,
  heightOf,
  project,
  roadClassOf,
  round1,
} from '../scripts/osm-convert';
import { validateCity } from '../src/data/validate';

const ORIGIN = { lat: 51.5133, lon: -0.0887 };

function loadFixture() {
  const raw = readFileSync(
    resolve(__dirname, 'fixtures/overpass-small.json'),
    'utf8',
  );
  return JSON.parse(raw);
}

function convert() {
  return convertOverpass(loadFixture(), { origin: ORIGIN });
}

describe('osm-convert project', () => {
  it('projects the origin to (0, 0)', () => {
    const [x, z] = project(ORIGIN.lon, ORIGIN.lat, ORIGIN);
    expect(x).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  it('projects east/north deltas per the data-format formulas', () => {
    // 0.0001° lon east of origin, 0.0001° lat north (more negative z).
    const [x, z] = project(-0.0886, 51.5134, ORIGIN);
    expect(x).toBeCloseTo(0.0001 * Math.cos((51.5133 * Math.PI) / 180) * 111320, 4);
    expect(z).toBeCloseTo(-0.0001 * 110574, 4);
  });
});

describe('osm-convert height rules', () => {
  const city = convert();

  it('height "20 m" → 20', () => {
    expect(city.buildings.find((b) => b.id === 1)?.h).toBeCloseTo(20, 5);
  });

  it('height "60 ft" → 18.29 (±0.01)', () => {
    const b = city.buildings.find((b) => b.id === 2);
    expect(b?.h).toBeCloseTo(18.29, 2);
    expect(Math.abs((b?.h ?? 0) - 60 * 0.3048)).toBeLessThan(0.01);
  });

  it('levels 5 → 18.5', () => {
    expect(city.buildings.find((b) => b.id === 3)?.h).toBeCloseTo(18.5, 5);
  });

  it('church with no height → default 30', () => {
    expect(city.buildings.find((b) => b.id === 4)?.h).toBeCloseTo(30, 5);
  });
});

describe('osm-convert building selection', () => {
  const city = convert();

  it('building:part ways are skipped', () => {
    expect(city.buildings.some((b) => b.id === 5)).toBe(false);
  });

  it('open (non-closed) building ways are skipped', () => {
    expect(city.buildings.some((b) => b.id === 6)).toBe(false);
  });

  it('degenerate ring (< 1 m²) is dropped', () => {
    expect(city.buildings.some((b) => b.id === 7)).toBe(false);
  });

  it('relation outer member emitted with the relation id, inner ignored', () => {
    const b = city.buildings.find((bd) => bd.id === 900);
    expect(b).toBeDefined();
    expect(b?.name).toBe('Guildhall');
    // Inner-ring ref 902 never appears as a building.
    expect(city.buildings.some((bd) => bd.id === 902)).toBe(false);
    // Only one building from the relation (its single closed outer member).
    expect(city.buildings.filter((bd) => bd.id === 900)).toHaveLength(1);
  });

  it('buildings have their repeated closing point dropped (poly no closure)', () => {
    for (const b of city.buildings) {
      const first = b.poly[0];
      const last = b.poly[b.poly.length - 1];
      expect([first[0], first[1]]).not.toEqual([last[0], last[1]]);
    }
  });

  it('rounds a near-duplicate ring cleanly (≥ 3 points, no repeats)', () => {
    // Building 15 has its second node within ~1 cm of the first and its
    // penultimate node within ~1 cm of the last; both collapse to duplicates
    // after 0.1 m rounding and must be dropped while the ring keeps ≥ 3 pts.
    const b = city.buildings.find((bd) => bd.id === 15);
    expect(b).toBeDefined();
    expect(b!.poly.length).toBeGreaterThanOrEqual(3);
    // No consecutive duplicate points.
    for (let i = 1; i < b!.poly.length; i++) {
      expect(b!.poly[i]).not.toEqual(b!.poly[i - 1]);
    }
    // First point not repeated as last.
    expect(b!.poly[0]).not.toEqual(b!.poly[b!.poly.length - 1]);
  });

  it('highway with consecutive identical nodes loses the duplicate', () => {
    const r = city.roads.find((rd) => rd.id === 16);
    expect(r).toBeDefined();
    // The middle node rounds to the same cell as the first and is dropped;
    // the polyline keeps its 2 distinct endpoints.
    expect(r!.pts).toHaveLength(2);
    expect(r!.pts[0]).not.toEqual(r!.pts[1]);
  });
});

describe('osm-convert roadClassOf mapping table + steps', () => {
  const rows = [
    ['trunk', 'primary'],
    ['trunk_link', 'primary'],
    ['primary', 'primary'],
    ['primary_link', 'primary'],
    ['secondary', 'secondary'],
    ['secondary_link', 'secondary'],
    ['tertiary', 'tertiary'],
    ['unclassified', 'tertiary'],
    ['residential', 'residential'],
    ['living_street', 'residential'],
    ['service', 'service'],
    ['pedestrian', 'pedestrian'],
    ['footway', 'footway'],
  ];

  it('maps every row of the data-format table', () => {
    for (const [highway, cls] of rows) {
      expect(roadClassOf(highway)).toBe(cls);
    }
  });

  it('steps → null (unmapped)', () => {
    expect(roadClassOf('steps')).toBeNull();
  });

  it('keeps mapped highway ways and drops unmapped ones', () => {
    const city = convert();
    const ids = city.roads.map((r) => r.id);
    expect(ids).toContain(10); // primary "Cheapside"
    expect(ids).toContain(11); // secondary_link
    expect(ids).toContain(12); // residential
    expect(ids).toContain(13); // footway
    expect(ids).not.toContain(14); // steps dropped
  });

  it('copies road name and class', () => {
    const city = convert();
    const cheapside = city.roads.find((r) => r.id === 10);
    expect(cheapside?.name).toBe('Cheapside');
    expect(cheapside?.cls).toBe('primary');
  });
});

describe('osm-convert places', () => {
  it('dedupes places by name and includes the station', () => {
    const city = convert();
    expect(city.places).toHaveLength(2);
    const banks = city.places.filter((p) => p.name === 'Bank');
    expect(banks).toHaveLength(1); // two "Bank" nodes collapsed to one
    expect(banks[0].x).toBeCloseTo(0, 5); // first Bank node is at the origin
    expect(banks[0].z).toBeCloseTo(0, 5);
    expect(city.places.some((p) => p.name === 'Bank Station')).toBe(true);
  });
});

describe('osm-convert output invariants', () => {
  const city = convert();

  it('coordinates are rounded to 0.1 m', () => {
    const all = [
      ...city.buildings.flatMap((b) => b.poly),
      ...city.roads.flatMap((r) => r.pts),
      ...city.places.map((p) => [p.x, p.z]),
    ];
    for (const [x, z] of all) {
      expect(x * 10).toBeCloseTo(Math.round(x * 10), 6);
      expect(z * 10).toBeCloseTo(Math.round(z * 10), 6);
    }
  });

  it('ids are unique within each array', () => {
    const uniq = (arr: { id: number }[]) =>
      new Set(arr.map((x) => x.id)).size === arr.length;
    expect(uniq(city.buildings)).toBe(true);
    expect(uniq(city.roads)).toBe(true);
    expect(city.buildings).toHaveLength(6);
    expect(city.roads).toHaveLength(5);
  });

  it('round1 rounds to a single decimal', () => {
    expect(round1(1.234)).toBe(1.2);
    expect(round1(11.0574)).toBe(11.1);
    expect(round1(6.9278)).toBe(6.9);
  });
});

describe('committed public/data/city.json', () => {
  const raw = readFileSync(resolve(__dirname, '../public/data/city.json'), 'utf8');
  const city = JSON.parse(raw);

  it('has v === 1', () => {
    expect(city.v).toBe(1);
  });

  it('has >= 3000 buildings', () => {
    expect(city.buildings.length).toBeGreaterThanOrEqual(3000);
  });

  it('has >= 500 roads', () => {
    expect(city.roads.length).toBeGreaterThanOrEqual(500);
  });

  it('has >= 10 places', () => {
    expect(city.places.length).toBeGreaterThanOrEqual(10);
  });

  it('every poly has >= 3 points', () => {
    for (const b of city.buildings) {
      expect(b.poly.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('every h is in [3, 320]', () => {
    for (const b of city.buildings) {
      expect(b.h).toBeGreaterThanOrEqual(3);
      expect(b.h).toBeLessThanOrEqual(320);
    }
  });

  it('file size is under 6 MB', () => {
    expect(raw.length).toBeLessThan(6 * 1024 * 1024);
  });

  it('passes validateCity with no throw', () => {
    expect(() => validateCity(city)).not.toThrow();
  });
});
