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
  TREE_CAP,
} from '../scripts/osm-convert';
import type { Vec2 } from '../src/data/types';
import { validateCity } from '../src/data/validate';
import { distToSegment, pointInPolygon } from '../src/world/collision';

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
    ['motorway', 'primary'],
    ['motorway_link', 'primary'],
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
    ['cycleway', null],
  ];

  it('maps every row of the data-format table', () => {
    for (const [highway, cls] of rows) {
      expect(roadClassOf(highway)).toBe(cls);
    }
  });

  it('maps motorway and motorway_link to primary (bridge flag kept)', () => {
    expect(roadClassOf('motorway')).toBe('primary');
    expect(roadClassOf('motorway_link')).toBe('primary');
    const city = convertOverpass(
      {
        elements: [
          {
            type: 'way',
            id: 70,
            tags: { highway: 'motorway', bridge: 'yes', name: 'Golden Gate Freeway' },
            geometry: [
              { lon: -0.0887, lat: 51.5133 },
              { lon: -0.0886, lat: 51.5134 },
            ],
          },
          {
            type: 'way',
            id: 71,
            tags: { highway: 'motorway_link', name: 'GGB onramp' },
            geometry: [
              { lon: -0.0887, lat: 51.5133 },
              { lon: -0.0886, lat: 51.5134 },
            ],
          },
        ],
      },
      { origin: ORIGIN },
    );
    const motorway = city.roads.find((r) => r.id === 70);
    expect(motorway).toBeDefined();
    expect(motorway?.cls).toBe('primary');
    expect(motorway?.bridge).toBe(true);
    expect(motorway?.name).toBe('Golden Gate Freeway');
    const link = city.roads.find((r) => r.id === 71);
    expect(link).toBeDefined();
    expect(link?.cls).toBe('primary');
    expect(link?.bridge).toBeUndefined();
  });

  it('steps → null (unmapped)', () => {
    expect(roadClassOf('steps')).toBeNull();
  });

  it('keeps mapped highway ways and drops unmapped ones (footway & steps & plain cycleway)', () => {
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
    expect(ids).not.toContain(41); // plain cycleway dropped
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
    const bridgedIds = new Set([17, 19, 40]); // 17 Westminster, 19 footway-bridge, 40 cycleway-bridge
    for (const r of city.roads) {
      if (!bridgedIds.has(r.id)) expect(r.bridge).toBeUndefined();
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

describe('osm-convert --lang', () => {
  it('without lang the plain (Cyrillic) name is used for buildings', () => {
    const city = convert();
    const b = city.buildings.find((bd) => bd.id === 1);
    expect(b?.name).toBe('Софійський собор');
  });

  it('without lang the plain name is used for roads', () => {
    const city = convert();
    const r = city.roads.find((rd) => rd.id === 10);
    expect(r?.name).toBe('Cheapside');
  });

  it("lang: 'en' picks name:en for the fixture building", () => {
    const city = convertOverpass(loadFixture(), { origin: ORIGIN, lang: 'en' });
    const b = city.buildings.find((bd) => bd.id === 1);
    expect(b?.name).toBe('Saint Sophia Cathedral');
  });

  it("lang: 'en' picks name:en for the fixture road", () => {
    const city = convertOverpass(loadFixture(), { origin: ORIGIN, lang: 'en' });
    const r = city.roads.find((rd) => rd.id === 10);
    expect(r?.name).toBe('Cheapside (English)');
  });

  it("lang: 'en' falls back to name where name:en is absent (Guildhall relation)", () => {
    const city = convertOverpass(loadFixture(), { origin: ORIGIN, lang: 'en' });
    const b = city.buildings.find((bd) => bd.id === 900);
    // The relation has only `name: Guildhall` (no name:en) — the fallback keeps it.
    expect(b?.name).toBe('Guildhall');
  });

  it("lang: 'en' still finds the Bank place (no name:en, falls back to name)", () => {
    const city = convertOverpass(loadFixture(), { origin: ORIGIN, lang: 'en' });
    expect(city.places.some((p) => p.name === 'Bank')).toBe(true);
  });
});

describe('osm-convert footway bridges (wave 5)', () => {
  const city = convert();

  it("emits a footway+bridge=yes way as cls 'pedestrian' with bridge: true", () => {
    const r = city.roads.find((rd) => rd.id === 19);
    expect(r).toBeDefined();
    expect(r?.cls).toBe('pedestrian');
    expect(r?.bridge).toBe(true);
    expect(r?.name).toBe('Park Bridge');
  });

  it('still drops a plain footway (no bridge tag)', () => {
    expect(city.roads.some((r) => r.id === 13)).toBe(false);
  });
});

describe('osm-convert cycleway bridges (T-0047)', () => {
  const city = convert();

  it("emits a cycleway+bridge=yes way as cls 'pedestrian' with bridge: true", () => {
    const r = city.roads.find((rd) => rd.id === 40);
    expect(r).toBeDefined();
    expect(r?.cls).toBe('pedestrian');
    expect(r?.bridge).toBe(true);
    expect(r?.name).toBe('Trukhaniv Cycle Bridge');
  });

  it('still drops a plain cycleway (no bridge tag)', () => {
    expect(city.roads.some((r) => r.id === 41)).toBe(false);
  });

  it("roadClassOf('cycleway') stays null", () => {
    expect(roadClassOf('cycleway')).toBeNull();
  });
});

describe('osm-convert --dem terrain', () => {
  // A stub Dem: elevation rises linearly with lat so the sampler produces
  // finite, formula-consistent heights without needing a real SRTM tile.
  const stubDem = {
    elevationAt(lat: number, _lon: number): number {
      return 100 + (lat - 51.5133) * 1000;
    },
  };

  it('emits terrain with cols/rows matching the buildTerrain formula', () => {
    const bbox: [number, number, number, number] = [
      -0.09,
      51.512,
      -0.087,
      51.514,
    ];
    const city = convertOverpass(loadFixture(), {
      origin: ORIGIN,
      bbox,
      dem: stubDem,
      step: 20,
    });
    expect(city.terrain).toBeDefined();
    const t = city.terrain!;
    // Formula (data-format.md §Terrain): x0 = floor(minX/step)*step − step, etc.
    // Just check that heights.length matches cols*rows and step is 20.
    expect(t.step).toBe(20);
    expect(t.cols).toBeGreaterThanOrEqual(2);
    expect(t.rows).toBeGreaterThanOrEqual(2);
    expect(t.heights).toHaveLength(t.cols * t.rows);
    for (const h of t.heights) expect(Number.isFinite(h)).toBe(true);
  });

  it('emits waterLevels with the same length as water (fixture has 2 rings)', () => {
    const city = convertOverpass(loadFixture(), {
      origin: ORIGIN,
      dem: stubDem,
      step: 20,
    });
    expect(city.water).toBeDefined();
    expect(city.waterLevels).toBeDefined();
    expect(city.waterLevels!.length).toBe(city.water!.length);
    for (const lvl of city.waterLevels!) expect(Number.isFinite(lvl)).toBe(true);
  });

  it('without dem, neither terrain nor waterLevels appears', () => {
    const city = convert();
    expect(city.terrain).toBeUndefined();
    expect(city.waterLevels).toBeUndefined();
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

describe('osm-convert trees', () => {
  const city = convert();
  const tagged = city.trees?.find((t) => Math.abs(t[0] - 100) < 0.2 && Math.abs(t[1] + 100) < 0.2);
  const seeded = city.trees?.find((t) => Math.abs(t[0] - 108) < 0.2 && Math.abs(t[1] + 100) < 0.2);
  const wood = city.woods?.[0];
  const woodBuilding = city.buildings.find((b) => b.id === 50);
  const woodRoad = city.roads.find((r) => r.id === 51);

  it('node trees emitted with their heights (12 vs seeded 6–14)', () => {
    expect(tagged).toBeDefined();
    expect(tagged![2]).toBeCloseTo(12, 5);
    expect(tagged![3]).toBeCloseTo(0.35 * 12, 5);
    expect(seeded).toBeDefined();
    expect(seeded![2]).toBeGreaterThanOrEqual(6);
    expect(seeded![2]).toBeLessThan(14);
    expect(seeded![3]).toBeCloseTo(round1(0.35 * seeded![2]), 5);
  });

  it('the row yields 3–4 trees ≈ 8 m apart', () => {
    const row = (city.trees ?? []).filter(
      (t) => Math.abs(t[1] + 200) < 0.5 && t[0] >= 199 && t[0] <= 231,
    );
    expect(row.length).toBeGreaterThanOrEqual(3);
    expect(row.length).toBeLessThanOrEqual(4);
    const sorted = [...row].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i][0] - sorted[i - 1][0]).toBeCloseTo(8, 1);
    }
  });

  it('the wood fill has ~24 ± 8 trees and none inside the building or within 6 m of the road', () => {
    expect(wood).toBeDefined();
    expect(woodBuilding).toBeDefined();
    expect(woodRoad).toBeDefined();
    const fills = (city.trees ?? []).filter((t) => pointInPolygon([t[0], t[1]], wood!));
    expect(fills.length).toBeGreaterThanOrEqual(16);
    expect(fills.length).toBeLessThanOrEqual(32);
    for (const t of fills) {
      expect(pointInPolygon([t[0], t[1]], woodBuilding!.poly)).toBe(false);
      const pts = woodRoad!.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        expect(distToSegment([t[0], t[1]], pts[i], pts[i + 1])).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('output is byte-identical across two runs', () => {
    const a = convert();
    const b = convert();
    expect(JSON.stringify(a.trees)).toBe(JSON.stringify(b.trees));
    expect(JSON.stringify(a.woods)).toBe(JSON.stringify(b.woods));
  });

  it('the cap thins fills only (tiny cap parameter)', () => {
    expect(TREE_CAP).toBe(40000);
    const full = convert();
    const mapped = (full.trees ?? []).filter((t) => !pointInPolygon([t[0], t[1]], wood!));
    const fills = (full.trees ?? []).filter((t) => pointInPolygon([t[0], t[1]], wood!));
    expect(fills.length).toBeGreaterThan(0);
    const cap = mapped.length + 2;
    const capped = convertOverpass(loadFixture(), { origin: ORIGIN, treeCap: cap });
    const cappedMapped = (capped.trees ?? []).filter((t) => !pointInPolygon([t[0], t[1]], wood!));
    const cappedFills = (capped.trees ?? []).filter((t) => pointInPolygon([t[0], t[1]], wood!));
    expect(cappedMapped).toEqual(mapped);
    expect(cappedFills.length).toBeLessThan(fills.length);
    const n = mapped.length + fills.length;
    const k = Math.ceil(n / cap);
    expect(cappedFills).toEqual(fills.filter((_, i) => i % k === 0));
    expect(capped.treesDropped).toBe(fills.length - cappedFills.length);
  });

  it('emits the wood ring and every tree validates', () => {
    expect(city.woods).toHaveLength(1);
    expect(wood!.length).toBeGreaterThanOrEqual(3);
    expect(() => validateCity(city)).not.toThrow();
    for (const t of city.trees ?? []) {
      expect(t).toHaveLength(4);
      expect(t[2]).toBeGreaterThanOrEqual(3);
      expect(t[2]).toBeLessThanOrEqual(40);
      expect(t[3]).toBeGreaterThanOrEqual(1);
      expect(t[3]).toBeLessThanOrEqual(15);
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
      ...city.places.map((p) => [p.x, p.z] as [number, number]),
      ...(city.trees ?? []).map((t) => [t[0], t[1]] as [number, number]),
      ...(city.woods ?? []).flatMap((r) => r),
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
    expect(city.buildings).toHaveLength(7); // + wood-interior building 50
    expect(city.roads).toHaveLength(9); // footway (13), steps (14), plain cycleway (41) dropped; footway-bridge (19) + cycleway-bridge (40) kept; + wood-crossing 51
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
