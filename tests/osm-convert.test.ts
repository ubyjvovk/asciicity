/**
 * Unit tests for `scripts/osm-convert.mjs` (pure OSM→JSON conversion) and for
 * the committed `public/data/london` tiled dataset. Covers the cases listed in
 * T-0003's acceptance criteria, by name.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assembleRings,
  chaikin,
  cleanupMask,
  clipRingToBox,
  contourWaterRings,
  convertOverpass,
  heightOf,
  majorityVoteGrid,
  project,
  protectedNodesFrom,
  roadClassOf,
  round1,
  traceWaterBoundary,
  TREE_CAP,
  waterMaskFromRing,
} from '../scripts/osm-convert';
import type { Vec2 } from '../src/data/types';
import { validateCity, validateTileIndex } from '../src/data/validate';
import { loadTiledCity, loadTiledIndex } from './tiledCity';
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

describe('osm-convert building relations — multi-way outer rings (T-0116)', () => {
  const DEG = Math.PI / 180;
  const COS = Math.cos(ORIGIN.lat * DEG);

  function xzToLonLat(x: number, z: number): { lon: number; lat: number } {
    return {
      lon: ORIGIN.lon + x / (COS * 111320),
      lat: ORIGIN.lat - z / 110574,
    };
  }

  /** A relation-outer member whose geometry is an open local-metre polyline. */
  function outer(ref: number, pts: Array<[number, number]>) {
    return {
      type: 'way' as const,
      role: 'outer' as const,
      ref,
      geometry: pts.map(([x, z]) => xzToLonLat(x, z)),
    };
  }

  function convertElements(elements: unknown[]) {
    return convertOverpass({ elements }, { origin: ORIGIN });
  }

  it('stitches out-of-order, one-reversed outer ways into one closed ring → 1 building via relation tags', () => {
    // Ring A corners (0,0),(10,0),(10,10),(0,10), broken into 3 open ways with
    // way `Ab` reversed and the members listed out of order (like the Opera
    // House's 16 ways). The single assembled ring keeps the relation id.
    const members = [
      outer(1, [[0, 0], [10, 0]]), // bottom edge, left→right
      outer(2, [[10, 10], [10, 0]]), // right edge, REVERSED (top→bottom)
      outer(3, [[10, 10], [0, 10], [0, 0]]), // top + left edge
    ];
    const city = convertElements([
      {
        type: 'relation',
        id: 500,
        tags: { type: 'multipolygon', building: 'yes', name: 'Sydney Opera House', height: '50' },
        members,
      },
    ]);
    expect(city.buildings).toHaveLength(1);
    const b = city.buildings[0];
    expect(b.id).toBe(500);
    expect(b.name).toBe('Sydney Opera House');
    expect(b.h).toBeCloseTo(50, 5);
    expect(b.poly.length).toBeGreaterThanOrEqual(4);
    // Closed ring: first point is not repeated last.
    expect(b.poly[0]).not.toEqual(b.poly[b.poly.length - 1]);
  });

  it('two disjoint outer rings (each multi-way) → two buildings with unique ids', () => {
    // Ring A (0,0)-(10,0)-(10,10)-(0,10) and Ring B (20,0)-(30,0)-(30,10)-(20,10),
    // members interleaved and out of order. The first assembled ring keeps the
    // relation id, the second gets `id*1000+1`.
    const members = [
      outer(1, [[0, 0], [10, 0]]), // A bottom
      outer(4, [[20, 0], [30, 0]]), // B bottom
      outer(5, [[30, 10], [30, 0]]), // B right, reversed
      outer(3, [[10, 10], [0, 10], [0, 0]]), // A top + left
      outer(2, [[10, 10], [10, 0]]), // A right, reversed
      outer(6, [[30, 10], [20, 10], [20, 0]]), // B top + left
    ];
    const city = convertElements([
      {
        type: 'relation',
        id: 700,
        tags: { type: 'multipolygon', building: 'yes', name: 'Twin Halls', height: '60' },
        members,
      },
    ]);
    expect(city.buildings).toHaveLength(2);
    const ids = city.buildings.map((b) => b.id).sort((a, b) => a - b);
    // The first ring keeps the relation id; the second must be `id*1000+1`.
    expect(ids).toEqual([700, 700001]);
    for (const b of city.buildings) {
      expect(b.name).toBe('Twin Halls');
      expect(b.h).toBeCloseTo(60, 5);
      expect(b.poly.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('an open (unstitchable) outer boundary is skipped and counted, never a partial ring', () => {
    const city = convertElements([
      {
        type: 'relation',
        id: 600,
        tags: { type: 'multipolygon', building: 'yes', name: 'Broken', height: '30' },
        members: [
          outer(1, [[0, 0], [10, 0]]),
          outer(2, [[20, 0], [30, 0]]),
        ],
      },
    ]);
    expect(city.buildings.some((b) => b.id === 600)).toBe(false);
    expect(city.buildings).toHaveLength(0);
    expect(city.skippedRelations).toBe(1);
  });

  it('a single closed-way outer member still emits exactly one building (T-0110 behaviour unchanged)', () => {
    // Guildhall: a relation whose only outer member is already a closed way —
    // assembleRingsInternal passes closed ways straight through as rings.
    const closed = outer(1, [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
    const city = convertElements([
      {
        type: 'relation',
        id: 900,
        tags: { type: 'multipolygon', building: 'yes', name: 'Guildhall', height: '20' },
        members: [closed, { type: 'way', role: 'inner', ref: 902, geometry: [] }],
      },
    ]);
    expect(city.buildings).toHaveLength(1);
    const b = city.buildings[0];
    expect(b.id).toBe(900);
    expect(b.name).toBe('Guildhall');
    expect(b.h).toBeCloseTo(20, 5);
  });
});

describe('osm-convert building parts', () => {
  const DEG = Math.PI / 180;
  const COS = Math.cos(ORIGIN.lat * DEG);

  function xzToLonLat(x: number, z: number): { lon: number; lat: number } {
    return {
      lon: ORIGIN.lon + x / (COS * 111320),
      lat: ORIGIN.lat - z / 110574,
    };
  }

  /** Closed Overpass way whose footprint is a local-metre axis-aligned rect. */
  function closedRect(
    id: number,
    tags: Record<string, string>,
    x: number,
    z: number,
    w: number,
    d: number,
  ) {
    const corners = [
      xzToLonLat(x, z),
      xzToLonLat(x + w, z),
      xzToLonLat(x + w, z + d),
      xzToLonLat(x, z + d),
    ];
    return {
      type: 'way' as const,
      id,
      tags,
      geometry: [...corners, corners[0]],
    };
  }

  function convertElements(elements: unknown[]) {
    return convertOverpass({ elements }, { origin: ORIGIN });
  }

  it('building:part with height and min_height converts to h and minH', () => {
    const city = convertElements([
      closedRect(1, { 'building:part': 'yes', height: '80', min_height: '20' }, 0, 0, 10, 10),
    ]);
    const b = city.buildings.find((bd) => bd.id === 1);
    expect(b).toBeDefined();
    expect(b!.h).toBeCloseTo(80, 5);
    expect(b!.minH).toBeCloseTo(20, 5);
  });

  it('building:part from levels uses ×3.3 (+2 for h, +0 for minH)', () => {
    const city = convertElements([
      closedRect(
        1,
        {
          'building:part': 'yes',
          'building:levels': '5',
          'building:min_level': '2',
        },
        0,
        0,
        10,
        10,
      ),
    ]);
    const b = city.buildings.find((bd) => bd.id === 1);
    expect(b).toBeDefined();
    expect(b!.h).toBeCloseTo(5 * 3.3 + 2, 5);
    expect(b!.minH).toBeCloseTo(2 * 3.3, 5);
  });

  it('an outline containing parts is dropped and its name moves to the tallest part', () => {
    const city = convertElements([
      closedRect(
        1,
        { building: 'yes', name: 'Empire State Building', height: '50' },
        0,
        0,
        40,
        40,
      ),
      closedRect(
        2,
        { 'building:part': 'yes', height: '80' },
        5,
        5,
        10,
        10,
      ),
      closedRect(
        3,
        { 'building:part': 'yes', height: '380', min_height: '50' },
        20,
        5,
        10,
        10,
      ),
    ]);
    expect(city.buildings.some((b) => b.id === 1)).toBe(false);
    const short = city.buildings.find((b) => b.id === 2);
    const tall = city.buildings.find((b) => b.id === 3);
    expect(short).toBeDefined();
    expect(tall).toBeDefined();
    expect(tall!.name).toBe('Empire State Building');
    expect(short!.name).toBeUndefined();
    expect(tall!.h).toBeCloseTo(380, 5);
    expect(tall!.minH).toBeCloseTo(50, 5);
  });

  it('a part inside two nested outlines belongs to the smaller one and takes its name', () => {
    const city = convertElements([
      closedRect(
        1,
        { building: 'yes', name: 'Big Station', height: '30' },
        0,
        0,
        40,
        40,
      ),
      closedRect(
        2,
        { building: 'yes', name: 'Small Tower', height: '200' },
        10,
        10,
        10,
        10,
      ),
      closedRect(
        3,
        { 'building:part': 'yes', height: '120' },
        12,
        12,
        4,
        4,
      ),
    ]);
    // Both outlines are replaced by the part; only the SMALLEST containing
    // outline (id 2) may hand its name to the part — id 1 is dropped without
    // transferring its name to a part that belongs to a smaller outline.
    expect(city.buildings.some((b) => b.id === 1)).toBe(false);
    expect(city.buildings.some((b) => b.id === 2)).toBe(false);
    expect(city.buildings).toHaveLength(1);
    const part = city.buildings.find((b) => b.id === 3);
    expect(part).toBeDefined();
    expect(part!.name).toBe('Small Tower');
    expect(part!.h).toBeCloseTo(120, 5);
  });

  it('an outline whose parts all belong to smaller outlines is dropped without renaming anything', () => {
    const city = convertElements([
      closedRect(
        1,
        { building: 'yes', name: 'Grand Complex', height: '20' },
        0,
        0,
        40,
        40,
      ),
      closedRect(
        2,
        { building: 'yes', name: 'Alpha', height: '100' },
        10,
        10,
        6,
        6,
      ),
      closedRect(
        3,
        { building: 'yes', name: 'Beta', height: '100' },
        25,
        25,
        6,
        6,
      ),
      closedRect(
        4,
        { 'building:part': 'yes', height: '80' },
        11,
        11,
        2,
        2,
      ),
      closedRect(
        5,
        { 'building:part': 'yes', height: '90' },
        26,
        26,
        2,
        2,
      ),
    ]);
    // Both parts belong to Alpha/Beta, so the outer Grand Complex is dropped
    // WITHOUT its name landing on either part.
    expect(city.buildings.some((b) => b.id === 1)).toBe(false);
    expect(city.buildings.some((b) => b.id === 2)).toBe(false);
    expect(city.buildings.some((b) => b.id === 3)).toBe(false);
    expect(city.buildings).toHaveLength(2);
    const pa = city.buildings.find((b) => b.id === 4);
    const pb = city.buildings.find((b) => b.id === 5);
    expect(pa).toBeDefined();
    expect(pb).toBeDefined();
    expect(pa!.name).toBe('Alpha');
    expect(pb!.name).toBe('Beta');
    expect(city.buildings.some((b) => b.name === 'Grand Complex')).toBe(false);
  });

  it('a named part keeps its own name', () => {
    const city = convertElements([
      closedRect(
        1,
        { building: 'yes', name: 'Complex', height: '20' },
        0,
        0,
        40,
        40,
      ),
      closedRect(
        2,
        { 'building:part': 'yes', name: 'My Tower', height: '300' },
        10,
        10,
        10,
        10,
      ),
    ]);
    expect(city.buildings.some((b) => b.id === 1)).toBe(false);
    expect(city.buildings).toHaveLength(1);
    const part = city.buildings.find((b) => b.id === 2);
    expect(part).toBeDefined();
    expect(part!.name).toBe('My Tower');
    expect(part!.h).toBeCloseTo(300, 5);
  });

  it('below-grade outlines and parts are skipped and never claim parts', () => {
    // Data-format.md "Building parts" rule 3b: an outline OR part whose tags
    // have `layer` < 0, `location=underground` or `underground=yes` is dropped
    // entirely (not emitted, and never a part-holder). The underground
    // "Grand Central Terminal" relation ring, whose outer is the only outline
    // containing a surface 209 m tower's centroid, must not lend its name.
    const city = convertElements([
      // Below-grade outline sitting under a surface tower (like Manhattan's
      // GCT platform relation vs the 209 m glass tower to its north).
      closedRect(
        1,
        {
          building: 'train_station',
          name: 'Grand Central Terminal',
          height: '10',
          layer: '-2',
          location: 'underground',
          underground: 'yes',
        },
        0,
        0,
        60,
        60,
      ),
      // Surface part inside the below-grade outline.
      closedRect(
        2,
        { 'building:part': 'yes', height: '209' },
        20,
        20,
        10,
        10,
      ),
      // Below-grade part alongside, must also be dropped.
      closedRect(
        3,
        { 'building:part': 'yes', height: '5', underground: 'yes' },
        70,
        0,
        10,
        10,
      ),
    ]);
    // The below-grade outline and below-grade part are gone.
    expect(city.buildings.some((b) => b.id === 1)).toBe(false);
    expect(city.buildings.some((b) => b.id === 3)).toBe(false);
    // The surface part survives, unclaimed by the underground outline.
    const surface = city.buildings.find((b) => b.id === 2);
    expect(surface).toBeDefined();
    expect(surface!.name).toBeUndefined();
    expect(surface!.h).toBeCloseTo(209, 5);
    // No building anywhere carries the underground name.
    expect(city.buildings.some((b) => b.name === 'Grand Central Terminal')).toBe(false);
    expect(city.buildings).toHaveLength(1);
  });

  it('an outline without parts and a part outside every outline are kept unchanged', () => {
    const city = convertElements([
      closedRect(10, { building: 'yes', name: 'Ordinary', height: '14' }, 0, 0, 10, 10),
      closedRect(
        11,
        { 'building:part': 'yes', height: '20', min_height: '5' },
        100,
        100,
        10,
        10,
      ),
    ]);
    const outline = city.buildings.find((b) => b.id === 10);
    const part = city.buildings.find((b) => b.id === 11);
    expect(outline).toBeDefined();
    expect(outline!.name).toBe('Ordinary');
    expect(outline!.minH).toBeUndefined();
    expect(part).toBeDefined();
    expect(part!.h).toBeCloseTo(20, 5);
    expect(part!.minH).toBeCloseTo(5, 5);
    expect(part!.name).toBeUndefined();
  });

  it('heights clamp to [3, 650]', () => {
    expect(heightOf({ height: '1' })).toBe(3);
    expect(heightOf({ height: '650' })).toBe(650);
    expect(heightOf({ height: '651' })).toBe(650);
    expect(heightOf({ height: '1000' })).toBe(650);
    const city = convertElements([
      closedRect(1, { building: 'yes', height: '1' }, 0, 0, 10, 10),
      closedRect(2, { building: 'yes', height: '1000' }, 20, 0, 10, 10),
      closedRect(
        3,
        { 'building:part': 'yes', height: '900', min_height: '100' },
        40,
        0,
        10,
        10,
      ),
    ]);
    expect(city.buildings.find((b) => b.id === 1)?.h).toBe(3);
    expect(city.buildings.find((b) => b.id === 2)?.h).toBe(650);
    const part = city.buildings.find((b) => b.id === 3);
    expect(part?.h).toBe(650);
    expect(part?.minH).toBeCloseTo(100, 5);
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

describe('osm-convert water relations — overlapping bodies + inner islands (T-0116)', () => {
  const DEG = Math.PI / 180;
  const COS = Math.cos(ORIGIN.lat * DEG);

  function xzToLonLat(x: number, z: number) {
    return {
      lon: ORIGIN.lon + x / (COS * 111320),
      lat: ORIGIN.lat - z / 110574,
    };
  }

  /** A water-relation member whose geometry is a closed local-metre ring. */
  function closedMember(role: 'outer' | 'inner', corners: Array<[number, number]>) {
    const geometry = corners.map(([x, z]) => xzToLonLat(x, z));
    geometry.push(geometry[0]); // close the ring
    return { type: 'way' as const, role: role as 'outer' | 'inner', geometry };
  }

  /** A water-relation member whose geometry is an OPEN local-metre chain. */
  function openMember(role: 'outer' | 'inner', pts: Array<[number, number]>) {
    return {
      type: 'way' as const,
      role: role as 'outer' | 'inner',
      geometry: pts.map(([x, z]) => xzToLonLat(x, z)),
    };
  }

  /** Shoelace area (m²) of a projected local ring. */
  function ringAreaLocal(ring: Array<[number, number]>): number {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, z1] = ring[i];
      const [x2, z2] = ring[(i + 1) % ring.length];
      a += x1 * z2 - x2 * z1;
    }
    return Math.abs(a) / 2;
  }

  function convertElements(elements: unknown[]) {
    return convertOverpass({ elements }, { origin: ORIGIN });
  }

  const SQ = [...([[0, 0], [400, 0], [400, 400], [0, 400]] as Array<[number, number]>)]; // 0.16 km²
  const ISLAND = [[150, 150], [250, 150], [250, 250], [150, 250]] as Array<[number, number]>; // 100×100 m

  it('two overlapping same-body relations → one outer kept (dedup ≥ 0.1 km², coverage ≥ 0.85)', () => {
    // Port Jackson ⊇ Sydney Harbour: two relations map the same 0.16 km² body;
    // the dedup keeps the larger/first and drops the duplicate so the odd-parity
    // rule reads it as a single water body, not as land in the overlap.
    const city = convertElements([
      {
        type: 'relation',
        id: 1001,
        tags: { type: 'multipolygon', natural: 'water', name: 'Port Jackson' },
        members: [closedMember('outer', SQ)],
      },
      {
        type: 'relation',
        id: 1002,
        tags: { type: 'multipolygon', natural: 'water', name: 'Sydney Harbour' },
        members: [closedMember('outer', SQ)],
      },
    ]);
    const rings = city.water ?? [];
    expect(rings).toHaveLength(1); // the duplicate is dropped
    expect(ringAreaLocal(rings[0])).toBeGreaterThan(150000);
  });

  it('two adjacent low-overlap bodies → both kept', () => {
    // Parramatta River / Lane Cove River: adjacent, non-overlapping bodies
    // have ~0 coverage against each other, so neither is dropped.
    const B = [[450, 0], [850, 0], [850, 400], [450, 400]] as Array<[number, number]>;
    const city = convertElements([
      {
        type: 'relation',
        id: 1001,
        tags: { type: 'multipolygon', natural: 'water', name: 'A' },
        members: [closedMember('outer', SQ)],
      },
      {
        type: 'relation',
        id: 1002,
        tags: { type: 'multipolygon', natural: 'water', name: 'B' },
        members: [closedMember('outer', B)],
      },
    ]);
    const rings = city.water ?? [];
    expect(rings).toHaveLength(2);
    for (const ring of rings) expect(ringAreaLocal(ring)).toBeGreaterThan(150000);
  });

  it('a shared island inner → emitted once (the duplicate relation contributes no islands)', () => {
    // Both overlapping relations carry the same inner island. After the outer
    // dedup only the kept relation (Port Jackson) contributes its inner, so the
    // island is emitted exactly once — the dropped relation adds nothing.
    const city = convertElements([
      {
        type: 'relation',
        id: 1001,
        tags: { type: 'multipolygon', natural: 'water', name: 'Port Jackson' },
        members: [closedMember('outer', SQ), closedMember('inner', ISLAND)],
      },
      {
        type: 'relation',
        id: 1002,
        tags: { type: 'multipolygon', natural: 'water', name: 'Sydney Harbour' },
        members: [closedMember('outer', SQ), closedMember('inner', ISLAND)],
      },
    ]);
    const rings = city.water ?? [];
    // 1 kept outer + the island, but only one island survives.
    const islands = rings.filter((r) => ringAreaLocal(r) < 150000);
    expect(rings).toHaveLength(2);
    expect(islands).toHaveLength(1);
    expect(ringAreaLocal(islands[0])).toBeGreaterThan(9000); // ~100×100 m
  });

  it('an open (unstitchable) inner chain is skipped and counted, never a partial island', () => {
    const city = convertElements([
      {
        type: 'relation',
        id: 1001,
        tags: { type: 'multipolygon', natural: 'water', name: 'Port Jackson' },
        members: [closedMember('outer', SQ), openMember('inner', [[50, 50], [50, 100]])],
      },
    ]);
    const rings = city.water ?? [];
    expect(rings).toHaveLength(1); // only the outer; the broken inner is not emitted
    expect(ringAreaLocal(rings[0])).toBeGreaterThan(150000);
    expect(city.droppedOpenInnerChains).toBe(1);
  });

  it('waterFull skips bbox clipping for RELATION rings only (standalone ways still clip)', () => {
    // T-0116, Answers 4: fetch-osm.mjs pre-fetches the complete member
    // geometry of every water relation so its assembled outer ring includes
    // vertices way outside the bbox. With `waterFull: true` the converter
    // must NOT clip those rings (a shoreline-hugging closure through open
    // ocean is preferable to a bbox slice that encloses the peninsulas).
    // Standalone `natural=water` ways still clip as before — they are
    // full ways within the bbox, not partial members of a bigger relation.
    const FAR_EAST = 20000; // 20 km east — well outside any real clipBox
    const OUTER_FAR = [
      [-500, -500],
      [FAR_EAST, -500],
      [FAR_EAST, 500],
      [-500, 500],
    ] as Array<[number, number]>;
    const relEl = {
      type: 'relation',
      id: 3001,
      tags: { type: 'multipolygon', natural: 'water', name: 'Port Jackson (full)' },
      members: [closedMember('outer', OUTER_FAR)],
    };
    const standaloneWay = {
      type: 'way',
      id: 3002,
      tags: { natural: 'water' },
      // Same shape as a standalone way — the projection lands 20 km east.
      geometry: OUTER_FAR
        .concat([OUTER_FAR[0]])
        .map(([x, z]) => xzToLonLat(x, z)),
    };
    const bbox: [number, number, number, number] = [-0.09, 51.512, -0.087, 51.514];

    const full = convertOverpass(
      { elements: [relEl, standaloneWay] },
      { origin: ORIGIN, bbox, waterFull: true },
    );
    const fullRings = full.water ?? [];
    // The relation ring KEEPS its far-east vertex (no clip); the standalone
    // way ring is clipped to bbox+300 m and does NOT reach the far east.
    const reachesFarEast = (ring: Array<[number, number]>) =>
      ring.some(([x]) => x > FAR_EAST - 100);
    expect(fullRings.some(reachesFarEast)).toBe(true);
    // Sanity: without `waterFull`, the RELATION ring gets clipped and no
    // ring reaches the far east.
    const clipped = convertOverpass(
      { elements: [relEl, standaloneWay] },
      { origin: ORIGIN, bbox },
    );
    for (const ring of clipped.water ?? []) {
      expect(reachesFarEast(ring)).toBe(false);
    }
  });
});

describe('osm-convert water-dem DEM contour (T-0116)', () => {
  const STEP = 20;
  const COLS = 10;
  const ROWS = 10;
  const X0 = 0;
  const Z0 = 0;

  /** Row-major heights grid, uniform 0 (sea level) unless overridden. */
  function grid(
    bumps: Array<{ r: number; c: number; h: number }> = [],
  ): number[] {
    const h = new Array(COLS * ROWS).fill(0);
    for (const { r, c, val } of bumps as Array<{ r: number; c: number; val: number }>) {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) h[r * COLS + c] = val;
    }
    return h;
  }

  /** A ring enclosing the whole grid (all nodes "inside the giant"). */
  const WHOLE: Array<[number, number]> = [
    [-20, -20],
    [220, -20],
    [220, 220],
    [-20, 220],
  ];

  it('node mask: inside the ring AND height ≤ level+threshold (level 0, threshold 2)', () => {
    const heights = grid([
      { r: 2, c: 2, val: 0.5 }, // water
      { r: 3, c: 3, val: 5 }, // land (above threshold)
      { r: 4, c: 4, val: 1.9 }, // water (≤ 2)
    ]);
    const mask = waterMaskFromRing(WHOLE, 0, 2, heights, COLS, ROWS, X0, Z0, STEP);
    expect(mask[2 * COLS + 2]).toBe(1);
    expect(mask[3 * COLS + 3]).toBe(0); // 5 > 0+2
    expect(mask[4 * COLS + 4]).toBe(1); // 1.9 ≤ 2
  });

  it('node mask: a node OUTSIDE the giant ring is land even when low', () => {
    // Narrow ring that excludes the far-east columns of the grid.
    const narrow: Array<[number, number]> = [
      [-20, -20],
      [120, -20],
      [120, 220],
      [-20, 220],
    ];
    const heights = grid([{ r: 5, c: 9, val: 0 }]); // low but column 9 is outside
    const mask = waterMaskFromRing(narrow, 0, 2, heights, COLS, ROWS, X0, Z0, STEP);
    expect(mask[5 * COLS + 9]).toBe(0);
    expect(mask[5 * COLS + 2]).toBe(1);
  });

  it('majority vote removes a lone water node and keeps a solid region', () => {
    const mask = new Uint8Array(COLS * ROWS);
    mask[5 * COLS + 5] = 1;
    const voted = majorityVoteGrid(mask, COLS, ROWS);
    expect(voted[5 * COLS + 5]).toBe(0);
    // A full-water grid survives everywhere (every 3×3 window >= 5 water).
    const full = new Uint8Array(COLS * ROWS).fill(1);
    const v = majorityVoteGrid(full, COLS, ROWS);
    for (let i = 0; i < full.length; i++) expect(v[i]).toBe(1);
  });

  it('speck: a small unprotected land component ≤ 8 nodes flips to water; a protected one stays', () => {
    // Water everywhere except a 2×2 (4-node) land island at rows/cols 3..4.
    const mask = new Uint8Array(COLS * ROWS).fill(1);
    for (let r = 3; r <= 4; r++) for (let c = 3; c <= 4; c++) mask[r * COLS + c] = 0;
    const protNone = new Uint8Array(COLS * ROWS);
    cleanupMask(mask, COLS, ROWS, protNone);
    // The unprotected island ≤ 8 nodes is flipped to water.
    for (let r = 3; r <= 4; r++) for (let c = 3; c <= 4; c++) expect(mask[r * COLS + c]).toBe(1);

    // Same layout but one node occupied by a protected (building/road) point.
    const mask2 = new Uint8Array(COLS * ROWS).fill(1);
    for (let r = 3; r <= 4; r++) for (let c = 3; c <= 4; c++) mask2[r * COLS + c] = 0;
    const prot = protectedNodesFrom([[70, 70]], COLS, ROWS, X0, Z0, STEP);
    cleanupMask(mask2, COLS, ROWS, prot);
    // Protected land speck survives.
    for (let r = 3; r <= 4; r++) for (let c = 3; c <= 4; c++) expect(mask2[r * COLS + c]).toBe(0);
  });

  it('puddle: a water component < 6 nodes is dropped to land', () => {
    const mask = new Uint8Array(COLS * ROWS);
    // A 2×2 (4-node) water puddle in the middle of land.
    for (let r = 4; r <= 5; r++) for (let c = 4; c <= 5; c++) mask[r * COLS + c] = 1;
    cleanupMask(mask, COLS, ROWS, new Uint8Array(COLS * ROWS));
    for (let r = 4; r <= 5; r++) for (let c = 4; c <= 5; c++) expect(mask[r * COLS + c]).toBe(0);
  });

  it('marching squares: a solid 3-node water blob traces one outer ring', () => {
    const mask = new Uint8Array(COLS * ROWS);
    for (let r = 3; r <= 5; r++) for (let c = 3; c <= 5; c++) mask[r * COLS + c] = 1;
    const rings = traceWaterBoundary(mask, COLS, ROWS, X0, Z0, STEP);
    expect(rings).toHaveLength(1);
    const ring = rings[0];
    // A 3×3 node block is 60 m × 60 m ≈ 3600 m².
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, z1] = ring[i];
      const [x2, z2] = ring[(i + 1) % ring.length];
      a += x1 * z2 - x2 * z1;
    }
    expect(Math.abs(a) / 2).toBeCloseTo(3600, -1);
  });

  it('hole emission: a land island inside water yields a negative (island) ring', () => {
    const mask = new Uint8Array(COLS * ROWS).fill(1);
    // A single-node land hole at (5,5) — traces an island ring inside the outer.
    mask[5 * COLS + 5] = 0;
    const rings = traceWaterBoundary(mask, COLS, ROWS, X0, Z0, STEP);
    expect(rings).toHaveLength(2);
    const signed = rings.map((r) => {
      let a = 0;
      for (let i = 0; i < r.length; i++) {
        const [x1, z1] = r[i];
        const [x2, z2] = r[(i + 1) % r.length];
        a += x1 * z2 - x2 * z1;
      }
      return a / 2;
    });
    const positives = signed.filter((s) => s > 0); // outer shoreline (water inside)
    const negatives = signed.filter((s) => s < 0); // island holes (land inside)
    expect(positives).toHaveLength(1);
    expect(negatives).toHaveLength(1);
  });

  it('traceWaterBoundary: a saddle-heavy fractal mask traces bounded simple rings (regression: no unbounded ring/OOM)', () => {
    // A dense checkerboard saddle pattern + scattered land holes forces the
    // ambiguous diagonal-corner junctions that could balloon the OLD tracer
    // (which always followed the first neighbour) into a near-10M-point ring
    // and OOM. The angular-successor tracer must complete with bounded rings.
    const N = 48;
    const m = new Uint8Array(N * N).fill(1); // all water
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        // Diagonal-only land in one quadrant: every interior corner is a saddle.
        if (r < N / 2 && c < N / 2 && (r + c) % 2 === 1) m[r * N + c] = 0;
        // Scattered single-pixel land holes elsewhere.
        if (r >= N / 2 && c % 5 === 2 && r % 3 === 1) m[r * N + c] = 0;
      }
    }
    const rings = traceWaterBoundary(m, N, N, 0, 0, STEP);
    expect(rings.length).toBeGreaterThan(1);
    let maxLen = 0;
    let signedAreaSum = 0;
    const waterCells = Array.from(m).filter((v) => v === 1).length;
    for (const ring of rings) {
      expect(ring.length).toBeGreaterThanOrEqual(3);
      expect(ring.length).toBeLessThanOrEqual(N * N * 4); // bounded, no 10M ring
      maxLen = Math.max(maxLen, ring.length);
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, z1] = ring[i];
        const [x2, z2] = ring[(i + 1) % ring.length];
        a += x1 * z2 - x2 * z1;
      }
      signedAreaSum += a / 2;
    }
    // Global closure invariant: outer rings CCW (+) minus hole rings CW (−)
    // nets exactly the water-pixel area. Catches mis-threading on saddles.
    expect(signedAreaSum).toBeCloseTo(waterCells * STEP * STEP, -3);
    expect(maxLen).toBeLessThanOrEqual(N * N * 4);
  });

  it('contourWaterRings: an elevated island is emitted as its own ring, not flipped (parity land)', () => {
    // Heights: sea level 0 except a block island (Goat-Island scale) set to 8 m.
    const heights = new Array(COLS * ROWS).fill(0);
    for (let r = 2; r <= 7; r++) for (let c = 2; c <= 7; c++) heights[r * COLS + c] = 8;
    const { rings } = contourWaterRings({
      ring: WHOLE,
      level: 0,
      heights,
      cols: COLS,
      rows: ROWS,
      x0: X0,
      z0: Z0,
      step: STEP,
    });
    // Outer shoreline (water inside) + island hole.
    expect(rings.length).toBeGreaterThanOrEqual(2);
    const pointIn = (x: number, z: number, poly: Array<[number, number]>) => {
      let ins = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        const straddles = yi > z !== yj > z;
        if (straddles && x < ((xj - xi) * (z - yi)) / (yj - yi) + xi) ins = !ins;
      }
      return ins;
    };
    // A point in the island is inside exactly two rings (outer + island = even → LAND).
    expect(rings.filter((r) => pointIn(90, 90, r)).length).toBe(2);
    // A point in open water (inside the grid, off the island) is inside exactly one ring (odd → WATER).
    expect(rings.filter((r) => pointIn(30, 30, r)).length).toBe(1);
  });

  it('chaikin softens a square (doubles vertices, stays closed)', () => {
    const sq: Array<[number, number]> = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const out = chaikin(sq, 1);
    expect(out).toHaveLength(8);
    // Edge (0,0)→(100,0): first new vertex is the 0.75/0.25 blend = 25.
    expect(out[0][0]).toBeCloseTo(25, 5);
    expect(out[0][1]).toBeCloseTo(0, 5);
    expect(out[1][0]).toBeCloseTo(75, 5);
    expect(out[1][1]).toBeCloseTo(0, 5);
  });

  it('convertOverpass: --water-dem replaces a sloppy giant with a shoreline + island hole', () => {
    const DEG = Math.PI / 180;
    const COS = Math.cos(ORIGIN.lat * DEG);
    const xzToLonLat = (x: number, z: number) => ({
      lon: ORIGIN.lon + x / (COS * 111320),
      lat: ORIGIN.lat - z / 110574,
    });
    // A 4000×4000 m giant relation (16 km² ≥ 1 km²) with NO inner members: a
    // SLOPPY solid polygon that would swallow any elevated island as water.
    const corners: Array<[number, number]> = [
      [0, 0],
      [4000, 0],
      [4000, 4000],
      [0, 4000],
    ];
    const geom = corners.map(([x, z]) => xzToLonLat(x, z));
    geom.push(geom[0]);
    const elements = [
      {
        type: 'relation',
        id: 3000,
        tags: { type: 'multipolygon', natural: 'water', name: 'Port Jackson' },
        members: [{ type: 'way', role: 'outer', ref: 1, geometry: geom }],
      },
    ];
    const bbox: Array<number> = [
      ORIGIN.lon,
      ORIGIN.lat - 4500 / 110574,
      ORIGIN.lon + 4500 / (COS * 111320),
      ORIGIN.lat,
    ];
    // Bare-earth DEM: sea level (0) everywhere except an elevated island.
    const stubDem = {
      elevationAt(lat: number, lon: number) {
        const [x, z] = project(lon, lat, ORIGIN);
        const inIsland = x >= 1500 && x <= 2300 && z >= 1500 && z <= 2300;
        return inIsland ? 8 : 0;
      },
    };
    const opts = {
      origin: ORIGIN,
      bbox,
      dem: stubDem,
      step: 20,
    };
    // Without waterDem the sloppy giant is emitted whole — no island.
    const plain = convertOverpass({ elements }, opts);
    expect(plain.water).toHaveLength(1);
    // (The island reads water under the single solid ring.)

    // With waterDem the giant is DEM-contoured: shoreline + island hole.
    const dembed = convertOverpass({ elements }, { ...opts, waterDem: true });
    const rings = dembed.water ?? [];
    expect(rings.length).toBeGreaterThanOrEqual(2);
    expect(dembed.waterLevels?.length).toBe(rings.length);
    const pointIn = (x: number, z: number, poly: Array<[number, number]>) => {
      let ins = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        const straddles = yi > z !== yj > z;
        if (straddles && x < ((xj - xi) * (z - yi)) / (yj - yi) + xi) ins = !ins;
      }
      return ins;
    };
    // Island point inside two rings (even → LAND); open water inside one (WATER).
    expect(rings.filter((r) => pointIn(1900, 1900, r)).length).toBe(2);
    expect(rings.filter((r) => pointIn(200, 200, r)).length).toBe(1);
    // Without waterDem, terrain flattening reads the island point as water.
    const plainT = plain.terrain as {
      x0: number;
      z0: number;
      step: number;
      cols: number;
      rows: number;
      heights: number[];
    };
    const cIs = Math.round((1900 - plainT.x0) / plainT.step);
    const rIs = Math.round((1900 - plainT.z0) / plainT.step);
    expect(plainT.heights[rIs * plainT.cols + cIs]).toBeLessThanOrEqual(2); // water-flattened
  });

  it('rule 3: a building/road node below threshold is FORCED LAND after the majority vote', () => {
    // All nodes at sea level (water under the whole ring) except one node
    // occupied by a protected building centroid / non-bridge road vertex.
    const heights = new Array(COLS * ROWS).fill(0);
    const prot = new Uint8Array(COLS * ROWS);
    prot[5 * COLS + 5] = 1;
    const { mask } = contourWaterRings({
      ring: WHOLE,
      level: 0,
      heights,
      cols: COLS,
      rows: ROWS,
      x0: X0,
      z0: Z0,
      step: STEP,
      protectedNodes: prot,
    });
    // The protected node reads LAND in the final mask (force-LAND beats water).
    expect(mask[5 * COLS + 5]).toBe(0);
    // An unprotected below-threshold node stays WATER.
    expect(mask[2 * COLS + 2]).toBe(1);
  });

  /** Build a giant `natural=water` relation (outer + optional inner ring) fixture. */
  function giantRelation(inner?: Array<[number, number]>) {
    const DEG = Math.PI / 180;
    const COS = Math.cos(ORIGIN.lat * DEG);
    const xzToLonLat = (x: number, z: number) => ({
      lon: ORIGIN.lon + x / (COS * 111320),
      lat: ORIGIN.lat - z / 110574,
    });
    const corners: Array<[number, number]> = [
      [0, 0],
      [4000, 0],
      [4000, 4000],
      [0, 4000],
    ];
    const geom = corners.map(([x, z]) => xzToLonLat(x, z));
    geom.push(geom[0]);
    const members: unknown[] = [{ type: 'way', role: 'outer', ref: 1, geometry: geom }];
    if (inner) {
      const ig = inner.map(([x, z]) => xzToLonLat(x, z));
      ig.push(ig[0]);
      members.push({ type: 'way', role: 'inner', ref: 2, geometry: ig });
    }
    return { DEG, COS, xzToLonLat, elements: [
      { type: 'relation', id: 4000, tags: { type: 'multipolygon', natural: 'water' }, members },
    ] };
  }

  it('rule 5: an inner island ring on mask-WATER is rescued and emitted (parity LAND)', () => {
    // Inner island 300×300 m mid-giant; DEM is all sea level so the contour
    // carves NO hole — the mask reads WATER at the island, so the OSM inner
    // ring is rescued and emitted to flip its interior to land by parity.
    const island: Array<[number, number]> = [
      [1900, 1800],
      [2200, 1800],
      [2200, 2100],
      [1900, 2100],
    ];
    const { elements } = giantRelation(island);
    const bbox: Array<number> = [
      ORIGIN.lon,
      ORIGIN.lat - 4500 / 110574,
      ORIGIN.lon + 4500 / (111320 * Math.cos(ORIGIN.lat * (Math.PI / 180))),
      ORIGIN.lat,
    ];
    const stubDem = { elevationAt() { return 0; } }; // all sea level
    const opts = { origin: ORIGIN, bbox, dem: stubDem, step: 20 };
    const dembed = convertOverpass({ elements }, { ...opts, waterDem: true });
    const rings = dembed.water ?? [];
    const pointIn = (x: number, z: number, poly: Array<[number, number]>) => {
      let ins = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        const straddles = yi > z !== yj > z;
        if (straddles && x < ((xj - xi) * (z - yi)) / (yj - yi) + xi) ins = !ins;
      }
      return ins;
    };
    // Island centre: contour outer (1) + rescued inner (1) = 2 → LAND.
    expect(rings.filter((r) => pointIn(2050, 1950, r)).length).toBe(2);
    // Open water: only the contour outer (1) → WATER.
    expect(rings.filter((r) => pointIn(200, 200, r)).length).toBe(1);
    expect(dembed.waterLevels?.length).toBe(rings.length);
  });

  it('rule 5: an inner island on a contour HOLE (elevated DEM) is NOT double-emitted', () => {
    // Same giant but the DEM is elevated over the island → the contour carves
    // its own hole, the mask reads LAND at the island, so the OSM inner ring
    // must NOT be added a second time (no double ring).
    const island: Array<[number, number]> = [
      [1900, 1800],
      [2200, 1800],
      [2200, 2100],
      [1900, 2100],
    ];
    const { elements } = giantRelation(island);
    const bbox: Array<number> = [
      ORIGIN.lon,
      ORIGIN.lat - 4500 / 110574,
      ORIGIN.lon + 4500 / (111320 * Math.cos(ORIGIN.lat * (Math.PI / 180))),
      ORIGIN.lat,
    ];
    const stubDem = {
      elevationAt(_lat: number, lon: number) {
        const [x, z] = project(lon, _lat, ORIGIN);
        return x >= 1800 && x <= 2200 && z >= 1800 && z <= 2200 ? 8 : 0;
      },
    };
    const opts = { origin: ORIGIN, bbox, dem: stubDem, step: 20 };
    const dembed = convertOverpass({ elements }, { ...opts, waterDem: true });
    const rings = dembed.water ?? [];
    // Exactly outer + contour hole — the inner was dropped (no third ring).
    expect(rings.length).toBe(2);
    const pointIn = (x: number, z: number, poly: Array<[number, number]>) => {
      let ins = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        const straddles = yi > z !== yj > z;
        if (straddles && x < ((xj - xi) * (z - yi)) / (yj - yi) + xi) ins = !ins;
      }
      return ins;
    };
    // Island centre inside outer + contour hole = 2 → LAND (no double ring).
    expect(rings.filter((r) => pointIn(2050, 1950, r)).length).toBe(2);
    expect(dembed.waterLevels?.length).toBe(rings.length);
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

describe('committed public/data/london', () => {
  const city = loadTiledCity('london');
  const index = loadTiledIndex('london');

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
    // Tiling splits non-bridge roads at 1000 m boundaries, so array length is
    // not stable — unique OSM ids still match the monolithic count.
    const uniqueRoads = new Set(
      (city.roads as Array<{ id: number }>).map((r) => r.id),
    ).size;
    expect(uniqueRoads).toBeGreaterThanOrEqual(Math.round(7803 * 0.95));
    expect(uniqueRoads).toBeLessThanOrEqual(Math.round(7803 * 1.05));
    expect(city.places.length).toBeGreaterThanOrEqual(Math.round(99 * 0.95));
    expect(city.places.length).toBeLessThanOrEqual(Math.round(99 * 1.05));
    const water = city.water ?? [];
    expect(water.length).toBeGreaterThanOrEqual(Math.round(31 * 0.95));
    expect(water.length).toBeLessThanOrEqual(Math.round(31 * 1.05));
  });

  it('has a building named Palace of Westminster', () => {
    const names = city.buildings
      .map((b) => b.name)
      .filter((n): n is string => n !== undefined && /westminster/i.test(n));
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
    const dir = resolve(__dirname, '../public/data/london');
    let total = statSync(join(dir, 'index.json')).size;
    for (const name of readdirSync(join(dir, 'tiles'))) {
      total += statSync(join(dir, 'tiles', name)).size;
    }
    expect(total).toBeLessThan(10 * 1024 * 1024);
  });

  it('passes validateCity with no throw', () => {
    expect(() => validateTileIndex(index)).not.toThrow();
  });
});

describe('committed public/data/sydney (T-0116)', () => {
  const SYD_ORIGIN = { lat: -33.8613, lon: 151.2110 };
  const city = loadTiledCity('sydney');

  it('Sydney Opera House is a single ≥ 100 m building named exactly, near 151.2153,-33.8568', () => {
    // T-0116: the Opera House is an OSM building RELATION whose 16 outer ways
    // are assembled into one ring (previously the relation was skipped).
    // Assert the assembled footprint via the memoized tile loader: exact name,
    // near the advertised local coords, long axis ≥ 100 m.
    const opera = city.buildings.filter((b) => b.name === 'Sydney Opera House');
    expect(opera).toHaveLength(1);
    const poly = opera[0].poly;
    const xs = poly.map((p) => p[0]);
    const zs = poly.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    // The advertised point (151.2153, -33.8568) projects into its bbox (it
    // sits near the sails' centroid); the Opera House is ~180 m long.
    const [tx, tz] = project(151.2153, -33.8568, SYD_ORIGIN);
    expect(tx).toBeGreaterThanOrEqual(minX);
    expect(tx).toBeLessThanOrEqual(maxX);
    expect(tz).toBeGreaterThanOrEqual(minZ);
    expect(tz).toBeLessThanOrEqual(maxZ);
    expect(Math.max(maxX - minX, maxZ - minZ)).toBeGreaterThanOrEqual(100);
  });
});
