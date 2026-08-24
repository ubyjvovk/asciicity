/**
 * Unit tests for `scripts/osm-convert.mjs` (pure OSM→JSON conversion) and for
 * the committed `public/data/city.json` dataset. Covers the cases listed in
 * T-0003's acceptance criteria, by name.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assembleRings,
  clipRingToBox,
  convertOverpass,
  heightOf,
  project,
  roadClassOf,
  round1,
} from '../scripts/osm-convert';
import type { Vec2 } from '../src/data/types';
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
  const rows: Array<[string, string | null]> = [
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
    ['footway', null],
  ];

  it('maps every row of the data-format table', () => {
    for (const [highway, cls] of rows) {
      expect(roadClassOf(highway)).toBe(cls);
    }
  });

  it('steps → null (unmapped)', () => {
    expect(roadClassOf('steps')).toBeNull();
  });

  it('keeps mapped highway ways and drops unmapped ones (footway & steps)', () => {
    const city = convert();
    const ids = city.roads.map((r) => r.id);
    expect(ids).toContain(10); // primary "Cheapside"
    expect(ids).toContain(11); // secondary_link
    expect(ids).toContain(12); // residential
    expect(ids).toContain(16); // residential
    expect(ids).toContain(17); // primary "Westminster Bridge" (bridge=yes)
    expect(ids).toContain(18); // secondary (bridge=no)
    expect(ids).not.toContain(13); // footway dropped
    expect(ids).not.toContain(14); // steps dropped
  });

  it('copies road name and class', () => {
    const city = convert();
    const cheapside = city.roads.find((r) => r.id === 10);
    expect(cheapside?.name).toBe('Cheapside');
    expect(cheapside?.cls).toBe('primary');
  });

  it('sets bridge: true on a road with bridge=yes', () => {
    const city = convert();
    const wb = city.roads.find((r) => r.id === 17);
    expect(wb?.name).toBe('Westminster Bridge');
    expect(wb?.bridge).toBe(true);
  });

  it('omits the bridge key for a road with bridge=no', () => {
    const city = convert();
    const r = city.roads.find((rd) => rd.id === 18);
    expect(r).toBeDefined();
    expect(r?.bridge).toBeUndefined();
  });

  it('omits the bridge key when the tag is absent', () => {
    const city = convert();
    for (const r of city.roads) {
      if (r.id !== 17) expect(r.bridge).toBeUndefined();
    }
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

describe('osm-convert water', () => {
  const city = convert();

  it('emits water rings from the closed way and the chained relation outer', () => {
    expect(city.water).toHaveLength(2);
    for (const ring of city.water ?? []) {
      expect(ring.length).toBeGreaterThanOrEqual(3);
      // Closed ring: first point must not repeat last (validateCity rule).
      expect(ring[0]).not.toEqual(ring[ring.length - 1]);
    }
  });

  it('counts the uncloseable open water way as a dropped open chain', () => {
    expect(city.skippedOpenWaterChains).toBe(1);
  });
});

describe('osm-convert assembleRings', () => {
  it('passes a closed way straight through as a ring', () => {
    const ways = [
      {
        id: 1,
        geometry: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 0 },
          { lon: 1, lat: 1 },
          { lon: 0, lat: 0 },
        ],
      },
    ];
    const rings = assembleRings(ways);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toEqual([
      { lon: 0, lat: 0 },
      { lon: 1, lat: 0 },
      { lon: 1, lat: 1 },
      { lon: 0, lat: 0 },
    ]);
  });

  it('chains two open ways into one closed ring', () => {
    const ways = [
      {
        id: 1,
        geometry: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 0 },
          { lon: 1, lat: 1 },
        ],
      },
      {
        id: 2,
        geometry: [
          { lon: 1, lat: 1 },
          { lon: 0, lat: 1 },
          { lon: 0, lat: 0 },
        ],
      },
    ];
    const rings = assembleRings(ways);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toEqual([
      { lon: 0, lat: 0 },
      { lon: 1, lat: 0 },
      { lon: 1, lat: 1 },
      { lon: 0, lat: 1 },
      { lon: 0, lat: 0 },
    ]);
  });

  it('drops open chains that cannot close', () => {
    const ways = [
      {
        id: 1,
        geometry: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 0 },
        ],
      },
      {
        id: 2,
        geometry: [
          { lon: 5, lat: 5 },
          { lon: 6, lat: 6 },
        ],
      },
    ];
    expect(assembleRings(ways)).toHaveLength(0);
  });
});

describe('osm-convert rivers', () => {
  const city = convert();

  it('emits the fixture river way as a projected + cleaned polyline', () => {
    // The single waterway=river way (id 32) has a point that collapses onto
    // the first after 0.1 m rounding; the emitted polyline drops it, leaving
    // 3 distinct points (same consecutive-duplicate cleanup as roads).
    expect(city.rivers).toHaveLength(1);
    const r = city.rivers![0];
    expect(r.length).toBe(3);
    expect(r[0][0]).toBeCloseTo(0, 5); // first point is the origin
    expect(r[0][1]).toBeCloseTo(0, 5);
    expect(r[2][0]).toBeCloseTo(13.9, 5); // east of the origin
    // No consecutive duplicate points survive cleaning.
    for (let i = 1; i < r.length; i++) {
      expect(r[i]).not.toEqual(r[i - 1]);
    }
  });
});

describe('osm-convert clipRingToBox', () => {
  it('clips a square straddling the box edge down to the box', () => {
    const ring: Vec2[] = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ];
    const clipped = clipRingToBox(ring, {
      minX: -5,
      minZ: -5,
      maxX: 100,
      maxZ: 100,
    });
    expect(clipped).toHaveLength(4);
    // Shoelace area of [(-5,-5),(10,-5),(10,10),(-5,10)] is 15 * 15 = 225.
    let area = 0;
    for (let i = 0; i < clipped.length; i++) {
      const [x1, z1] = clipped[i];
      const [x2, z2] = clipped[(i + 1) % clipped.length];
      area += x1 * z2 - x2 * z1;
    }
    expect(Math.abs(area) / 2).toBeCloseTo(225, 5);
  });

  it('returns < 3 points for a ring fully outside the box', () => {
    const ring: Vec2[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const clipped = clipRingToBox(ring, {
      minX: 10,
      minZ: 10,
      maxX: 20,
      maxZ: 20,
    });
    expect(clipped.length).toBeLessThan(3);
  });
});

describe('osm-convert output invariants', () => {
  const city = convert();

  it('coordinates are rounded to 0.1 m', () => {
    const all = [
      ...city.buildings.flatMap((b) => b.poly),
      ...city.roads.flatMap((r) => r.pts),
      ...(city.rivers ?? []).flatMap((r) => r),
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
    expect(city.roads).toHaveLength(6); // footway and steps dropped, bridge ways kept
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

  it('has the Westminster→Aldgate bbox', () => {
    expect(city.bbox).toEqual([-0.13, 51.497, -0.07, 51.521]);
  });

  it('has >= 6000 buildings', () => {
    expect(city.buildings.length).toBeGreaterThanOrEqual(6000);
  });

  it('has >= 500 roads', () => {
    expect(city.roads.length).toBeGreaterThanOrEqual(500);
  });

  it('has 0 footway roads (footways are dropped)', () => {
    expect(city.roads.filter((r: { cls: string }) => r.cls === 'footway')).toHaveLength(0);
  });

  it('has >= 5 roads carrying the bridge flag', () => {
    expect(
      city.roads.filter((r: { bridge?: boolean }) => r.bridge === true).length,
    ).toBeGreaterThanOrEqual(5);
  });

  it('a road named Westminster Bridge has bridge: true', () => {
    // OSM splits Westminster Bridge across several named ways; the river-crossing
    // segments carry `bridge=yes`. Assert at least one named road is flagged.
    const hasBridged = city.roads.some(
      (r: { name?: string; bridge?: boolean }) =>
        r.name === 'Westminster Bridge' && r.bridge === true,
    );
    expect(hasBridged).toBe(true);
  });

  it('counts are within ±5 % of the Westminster dataset baseline', () => {
    expect(city.buildings.length).toBeGreaterThanOrEqual(Math.round(9061 * 0.95));
    expect(city.buildings.length).toBeLessThanOrEqual(Math.round(9061 * 1.05));
    expect(city.roads.length).toBeGreaterThanOrEqual(Math.round(7803 * 0.95));
    expect(city.roads.length).toBeLessThanOrEqual(Math.round(7803 * 1.05));
    expect(city.places.length).toBeGreaterThanOrEqual(Math.round(99 * 0.95));
    expect(city.places.length).toBeLessThanOrEqual(Math.round(99 * 1.05));
    const water = city.water ?? [];
    expect(water.length).toBeGreaterThanOrEqual(Math.round(31 * 0.95));
    expect(water.length).toBeLessThanOrEqual(Math.round(31 * 1.05));
  });

  it('has a building named Palace of Westminster', () => {
    const names = city.buildings
      .filter((b: { name?: string }) => b.name && /westminster/i.test(b.name))
      .map((b: { name: string }) => b.name);
    expect(names).toContain('Palace of Westminster');
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

  it('has at least one water ring with a point z > 600 (the Thames)', () => {
    const water: Array<Array<[number, number]>> = city.water ?? [];
    expect(water.length).toBeGreaterThan(0);
    const hasRiver = water.some((ring) => ring.some(([, z]) => z > 600));
    expect(hasRiver).toBe(true);
  });

  it('has a water ring with a point x < -2000 (the Thames at Westminster)', () => {
    const water: Array<Array<[number, number]>> = city.water ?? [];
    expect(water.length).toBeGreaterThan(0);
    const hasWest = water.some((ring) => ring.some(([x]) => x < -2000));
    expect(hasWest).toBe(true);
  });

  it('file size is under 10 MB', () => {
    expect(raw.length).toBeLessThan(10 * 1024 * 1024);
  });

  it('passes validateCity with no throw', () => {
    expect(() => validateCity(city)).not.toThrow();
  });
});
