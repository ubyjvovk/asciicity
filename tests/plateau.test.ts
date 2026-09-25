/**
 * T-0162 — PLATEAU prototype helpers (`scripts/plateau/citygml.mjs`,
 * `scripts/plateau/map.mjs`) on a tiny inline CityGML fixture, plus a
 * `validateCity` pass over the prototype output when it has been generated
 * (`node scripts/plateau/fetch-cell.mjs` → `.cache/plateau/out/0_0.json`).
 *
 * T-0163 — the production converter's pure half (`scripts/plateau/merge.mjs`):
 * tile assignment = the tiler's rule, merge rules 3/4/5 on a hand-made
 * fixture, the PLATEAU id range, tiers never with roof, determinism.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buildingChunks,
  meshBounds,
  meshCode3,
  meshesForBbox,
  parseBuilding,
  parsePosList,
  texturedPolygonIds,
} from '../scripts/plateau/citygml';
import {
  checkBuildings,
  classifyRoof,
  cleanRing,
  intersectionArea,
  iou,
  lod2Tiers,
  matchFootprints,
  numericId,
  ringArea,
  splitHoles,
  toBuilding,
  unionFacets,
  unionFacetsWithHoles,
} from '../scripts/plateau/map';
import {
  PLATEAU_ID_BASE,
  assignIds,
  buildTiers,
  buildingTileKey,
  convertBuilding,
  coveredShare,
  isPlateauId,
  mergeBuildings,
  osmPartFlags,
  plateauId,
  retile,
} from '../scripts/plateau/merge';
import { tileCity } from '../scripts/tile-city';
import type { Building, TileData, Vec2 } from '../src/data/types';
import { syntheticCity } from '../src/data/synthetic';
import { validateCity } from '../src/data/validate';

const ORIGIN = { lat: 35.6812, lon: 139.7671 };
const KX = Math.cos((ORIGIN.lat * Math.PI) / 180) * 111320;

type P3 = [number, number, number];

/** Local `[x, z, y]` → posList text (`lat lon h`), ring closed like PLATEAU writes it. */
function posList(pts: P3[]): string {
  return [...pts, pts[0]!]
    .map(([x, z, y]) => `${ORIGIN.lat - z / 110574} ${ORIGIN.lon + x / KX} ${y}`)
    .join(' ');
}

function polygon(id: string, pts: P3[]): string {
  return `<gml:surfaceMember>
  <gml:Polygon gml:id="${id}">
    <gml:exterior>
      <gml:LinearRing gml:id="linr-${id}">
        <gml:posList>${posList(pts)}</gml:posList>
      </gml:LinearRing>
    </gml:exterior>
  </gml:Polygon>
</gml:surfaceMember>`;
}

function surface(kind: string, id: string, pts: P3[]): string {
  return `<bldg:boundedBy><bldg:${kind} gml:id="surface-${id}"><bldg:lod2MultiSurface><gml:MultiSurface>
${polygon(id, pts)}
</gml:MultiSurface></bldg:lod2MultiSurface></bldg:${kind}></bldg:boundedBy>`;
}

/** Box footprint `[x0, z0]–[x1, z1]` at height y. */
function rect(x0: number, z0: number, x1: number, z1: number, y: number): P3[] {
  return [
    [x0, z0, y],
    [x1, z0, y],
    [x1, z1, y],
    [x0, z1, y],
  ];
}

function lod1(x0: number, z0: number, x1: number, z1: number, base: number, top: number): string {
  return `<bldg:lod1Solid><gml:Solid><gml:exterior><gml:CompositeSurface>
<gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${posList(rect(x0, z0, x1, z1, base))}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
<gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${posList(rect(x0, z0, x1, z1, top))}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
</gml:CompositeSurface></gml:exterior></gml:Solid></bldg:lod1Solid>`;
}

// Gabled house: 10 × 6 m, ground 5, eaves 11, ridge 14 running east-west (z = 3).
const GABLE_N: P3[] = [[0, 0, 11], [10, 0, 11], [10, 3, 14], [0, 3, 14]];
const GABLE_S: P3[] = [[0, 6, 11], [0, 3, 14], [10, 3, 14], [10, 6, 11]];

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<core:CityModel>
<app:appearanceMember><app:Appearance><app:theme>rgbTexture</app:theme>
<app:surfaceDataMember><app:ParameterizedTexture><app:imageURI>x/RoofSurfaceTexture_1.jpg</app:imageURI>
<app:target uri="#poly-roof-n"><app:TexCoordList><app:textureCoordinates ring="#linr-poly-roof-n">0 0 1 0 1 1 0 1 0 0</app:textureCoordinates></app:TexCoordList></app:target>
</app:ParameterizedTexture></app:surfaceDataMember>
<app:surfaceDataMember><app:X3DMaterial><app:diffuseColor>1 1 1</app:diffuseColor><app:target>#poly-wall-1</app:target></app:X3DMaterial></app:surfaceDataMember>
</app:Appearance></app:appearanceMember>
<core:cityObjectMember>
<bldg:Building gml:id="bldg_house">
  <gml:name>テストハウス</gml:name>
  <bldg:usage codeSpace="../../codelists/Building_usage.xml">411</bldg:usage>
  <bldg:measuredHeight uom="m">9</bldg:measuredHeight>
  <bldg:storeysAboveGround>2</bldg:storeysAboveGround>
  <bldg:lod0RoofEdge><gml:MultiSurface>${polygon('lod0-house', rect(0, 0, 10, 6, 0))}</gml:MultiSurface></bldg:lod0RoofEdge>
  ${lod1(0, 0, 10, 6, 5, 14)}
  ${surface('GroundSurface', 'poly-ground', rect(0, 0, 10, 6, 5))}
  ${surface('RoofSurface', 'poly-roof-n', GABLE_N)}
  ${surface('RoofSurface', 'poly-roof-s', GABLE_S)}
  ${surface('WallSurface', 'poly-wall-1', [[0, 0, 5], [10, 0, 5], [10, 0, 11], [0, 0, 11]])}
  <bldg:outerBuildingInstallation><bldg:BuildingInstallation gml:id="inst-1"><bldg:lod2Geometry><gml:MultiSurface>
    ${surface('RoofSurface', 'poly-canopy', rect(-2, -2, 0, 0, 8))}
  </gml:MultiSurface></bldg:lod2Geometry></bldg:BuildingInstallation></bldg:outerBuildingInstallation>
  <uro:buildingDetailAttribute><uro:BuildingDetailAttribute><uro:fireproofStructureType>1003</uro:fireproofStructureType></uro:BuildingDetailAttribute></uro:buildingDetailAttribute>
  <uro:bldgDataQualityAttribute><uro:DataQualityAttribute><uro:lodType>2.2</uro:lodType></uro:DataQualityAttribute></uro:bldgDataQualityAttribute>
  <uro:buildingIDAttribute><uro:BuildingIDAttribute><uro:buildingID>13102-bldg-1</uro:buildingID><uro:city>13102</uro:city></uro:BuildingIDAttribute></uro:buildingIDAttribute>
</bldg:Building>
</core:cityObjectMember>
<core:cityObjectMember>
<bldg:Building gml:id="bldg_lod1">
  <bldg:measuredHeight uom="m">-9999</bldg:measuredHeight>
  <bldg:lod0FootPrint><gml:MultiSurface>${polygon('lod0-lod1', rect(20, 0, 32, 8, 0))}</gml:MultiSurface></bldg:lod0FootPrint>
  ${lod1(20, 0, 32, 8, 4, 16)}
  <uro:buildingIDAttribute><uro:BuildingIDAttribute><uro:buildingID>13101-bldg-42</uro:buildingID><uro:city>13101</uro:city></uro:BuildingIDAttribute></uro:buildingIDAttribute>
</bldg:Building>
</core:cityObjectMember>
<core:cityObjectMember>
<bldg:Building gml:id="bldg_parent">
  <bldg:measuredHeight uom="m">30</bldg:measuredHeight>
  <bldg:consistsOfBuildingPart><bldg:BuildingPart gml:id="part_1">
    <bldg:measuredHeight uom="m">12</bldg:measuredHeight>
    ${lod1(40, 0, 50, 10, 3, 15)}
  </bldg:BuildingPart></bldg:consistsOfBuildingPart>
</bldg:Building>
</core:cityObjectMember>
</core:CityModel>`;

describe('mesh codes (JIS X 0410, 3rd order)', () => {
  it('meshCode3 locates Tokyo Station east side in 53394611', () => {
    expect(meshCode3(139.7721, 35.6762)).toBe('53394611');
  });

  it('meshBounds is 45″ × 30″ and round-trips through meshCode3', () => {
    const [x0, y0, x1, y1] = meshBounds('53394611');
    expect(x0).toBeCloseTo(139.7625, 9);
    expect(y0).toBeCloseTo(35.675, 9);
    expect(x1 - x0).toBeCloseTo(1 / 80, 12);
    expect(y1 - y0).toBeCloseTo(1 / 120, 12);
    expect(meshCode3((x0 + x1) / 2, (y0 + y1) / 2)).toBe('53394611');
    expect(() => meshBounds('5339461')).toThrow();
  });

  it('meshesForBbox covers our tile 0_0 with 4 meshes and one mesh with 1', () => {
    expect(meshesForBbox([139.7671, 35.67216, 139.77816, 35.6812])).toEqual([
      '53394601',
      '53394602',
      '53394611',
      '53394612',
    ]);
    expect(meshesForBbox(meshBounds('53394611'))).toEqual(['53394611']);
  });
});

describe('CityGML parsing', () => {
  it('buildingChunks yields top-level buildings only (not parts / installations)', () => {
    const chunks = [...buildingChunks(FIXTURE)];
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.startsWith('<bldg:Building ') && c.endsWith('</bldg:Building>'))).toBe(true);
  });

  it('parsePosList reads lat lon h triples', () => {
    expect(parsePosList(' 35.5 139.5 4.1\n35.6 139.6 4.2 ')).toEqual([
      [35.5, 139.5, 4.1],
      [35.6, 139.6, 4.2],
    ]);
  });

  it('parseBuilding reads attributes, LOD0/1/2 geometry and strips installations', () => {
    const [house, flat, parent] = [...buildingChunks(FIXTURE)].map(parseBuilding);
    expect(house!.gmlId).toBe('bldg_house');
    expect(house!.buildingId).toBe('13102-bldg-1');
    expect(house!.city).toBe('13102');
    expect(house!.name).toBe('テストハウス');
    expect(house!.measuredHeight).toBe(9);
    expect(house!.storeys).toBe(2);
    expect(house!.usage).toBe('411');
    expect(house!.fireproof).toBe('1003');
    expect(house!.lodType).toBe('2.2');
    expect(house!.lod0).toHaveLength(1);
    expect(house!.lod0[0]).toHaveLength(5); // closed ring as written
    expect(house!.lod1).toHaveLength(2);
    expect(house!.roofs.map((r) => r.polyIds[0])).toEqual(['poly-roof-n', 'poly-roof-s']); // canopy stripped
    expect(house!.grounds).toHaveLength(1);
    expect(house!.walls).toBe(1);
    expect(house!.installations).toBe(1);
    expect(flat!.measuredHeight).toBeUndefined(); // -9999 = unknown
    expect(flat!.roofs).toHaveLength(0);
    expect(parent!.parts).toHaveLength(1);
    expect(parent!.parts[0]!.gmlId).toBe('part_1');
    expect(parent!.parts[0]!.measuredHeight).toBe(12);
    expect(parent!.lod1).toHaveLength(0); // the part's solid is not the parent's
  });

  it('texturedPolygonIds lists ParameterizedTexture targets only', () => {
    expect([...texturedPolygonIds(FIXTURE)]).toEqual(['poly-roof-n']);
  });
});

describe('classifyRoof', () => {
  it('flat: one level', () => {
    expect(classifyRoof([rect(0, 0, 10, 10, 20)]).kind).toBe('flat');
  });

  it('flat: a bump ≤ 3 m above the roof stays flat', () => {
    expect(classifyRoof([rect(0, 0, 10, 10, 20), rect(0, 10, 3, 13, 22)]).kind).toBe('flat');
  });

  it('stepped: two levels 15 m apart, top level < 70 % of flat area', () => {
    const r = classifyRoof([rect(0, 0, 10, 5, 30), rect(0, 5, 10, 10, 15)]);
    expect(r.kind).toBe('stepped');
    expect(r.levels).toBe(2);
    expect(r.topShare).toBeCloseTo(0.5, 5);
    expect(r.topY).toBeCloseTo(30, 5);
  });

  it('gabled: two opposite slopes, ridge east-west → dir 90, h = ridge − eave', () => {
    const r = classifyRoof([GABLE_N, GABLE_S]);
    expect(r.kind).toBe('gabled');
    expect(r.dir).toBe(90);
    expect(r.h).toBeCloseTo(3, 5);
  });

  it('skillion rising east → dir 0 (roofFrame rises towards dir + 90)', () => {
    const r = classifyRoof([[[0, 0, 10], [10, 0, 13], [10, 6, 13], [0, 6, 10]]]);
    expect(r.kind).toBe('skillion');
    expect(r.dir).toBe(0);
    expect(r.h).toBeCloseTo(3, 5);
  });

  it('hipped: 4 slopes with a 6 m ridge along x → dir 90', () => {
    const r = classifyRoof([
      [[0, 0, 11], [12, 0, 11], [9, 3, 14], [3, 3, 14]],
      [[12, 6, 11], [0, 6, 11], [3, 3, 14], [9, 3, 14]],
      [[0, 6, 11], [0, 0, 11], [3, 3, 14]],
      [[12, 0, 11], [12, 6, 11], [9, 3, 14]],
    ]);
    expect(r.kind).toBe('hipped');
    expect(r.dir).toBe(90);
  });

  it('pyramidal: 4 triangles meeting at one apex', () => {
    const r = classifyRoof([
      [[0, 0, 10], [8, 0, 10], [4, 4, 14]],
      [[8, 0, 10], [8, 8, 10], [4, 4, 14]],
      [[8, 8, 10], [0, 8, 10], [4, 4, 14]],
      [[0, 8, 10], [0, 0, 10], [4, 4, 14]],
    ]);
    expect(r.kind).toBe('pyramidal');
    expect(r.h).toBeCloseTo(4, 5);
  });

  it('complex: half flat, half sloped', () => {
    expect(classifyRoof([rect(0, 0, 10, 10, 20), [[10, 0, 20], [20, 0, 23], [20, 10, 23], [10, 10, 20]]]).kind).toBe(
      'complex',
    );
  });

  it('ignores near-vertical facets and slivers; empty → none', () => {
    expect(classifyRoof([[[0, 0, 0], [10, 0, 0], [10, 0, 10]]]).kind).toBe('none');
    expect(classifyRoof([rect(0, 0, 0.5, 0.5, 3)]).kind).toBe('none');
  });
});

describe('footprint helpers', () => {
  it('cleanRing drops the closing point, duplicates and collinear vertices', () => {
    const r = cleanRing([[0, 0], [5, 0], [10, 0], [10, 10], [10, 10], [0, 10], [0, 0]]);
    expect(r).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });

  it('cleanRing rejects degenerate rings', () => {
    expect(cleanRing([[0, 0], [1, 0], [2, 0]])).toEqual([]);
  });

  it('unionFacets merges edge-sharing facets into one outer ring', () => {
    const u = unionFacets([
      [[0, 0], [5, 0], [5, 5], [0, 5]],
      [[10, 0], [10, 5], [5, 5], [5, 0]], // opposite winding on purpose
    ]);
    expect(u).toHaveLength(1);
    expect(ringArea(u![0]!)).toBeCloseTo(50, 5);
    expect(cleanRing(u![0]!)).toHaveLength(4);
  });

  it('iou: identical 1, disjoint 0, half-offset squares 1/3', () => {
    const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(iou(a, a)).toBeCloseTo(1, 5);
    expect(iou(a, [[20, 0], [30, 0], [30, 10], [20, 10]])).toBe(0);
    expect(iou(a, [[5, 0], [15, 0], [15, 10], [5, 10]])).toBeCloseTo(1 / 3, 2);
  });

  it('matchFootprints picks the best partner, flags no-overlap and split coverage', () => {
    const plateau = [
      [[0, 0], [10, 0], [10, 10], [0, 10]],
      [[100, 100], [110, 100], [110, 110], [100, 110]],
      [[200, 0], [220, 0], [220, 10], [200, 10]],
    ];
    const osm = [
      [[1, 0], [11, 0], [11, 10], [1, 10]], // 0: good match for plateau[0]
      [[200, 0], [210, 0], [210, 10], [200, 10]], // 1 + 2: plateau[2] split in two
      [[210, 0], [220, 0], [220, 10], [210, 10]],
    ];
    const m = matchFootprints(plateau, osm);
    expect(m[0]!.j).toBe(0);
    expect(m[0]!.iou).toBeGreaterThan(0.8);
    expect(m[1]).toEqual({ j: -1, iou: 0, covered: 0 });
    expect(m[2]!.iou).toBeCloseTo(0.5, 1);
    expect(m[2]!.covered).toBeCloseTo(1, 2);
  });
});

describe('toBuilding / ids / tiers', () => {
  const pbs = [...buildingChunks(FIXTURE)].map(parseBuilding);

  it('numericId: buildingID → city × 10⁷ + serial; else a stable hash ≥ 2·10¹²', () => {
    expect(numericId('13102-bldg-3711', 'x')).toBe(131020003711);
    const h = numericId(undefined, 'bldg_abc');
    expect(h).toBeGreaterThanOrEqual(2e12);
    expect(numericId(undefined, 'bldg_abc')).toBe(h);
    expect(numericId(undefined, 'bldg_abd')).not.toBe(h);
    expect(Number.isSafeInteger(h * 1000 + 999)).toBe(true);
  });

  it('LOD2 house: lod0 footprint, measuredHeight, gabled roof, PLATEAU name', () => {
    const { building, roof, base } = toBuilding(pbs[0]!, ORIGIN);
    expect(roof.kind).toBe('gabled');
    expect(base).toBeCloseTo(5, 5);
    expect(building!.id).toBe(131020000001);
    expect(building!.h).toBe(9);
    expect(building!.name).toBe('テストハウス');
    expect(building!.roof).toEqual({ shape: 'gabled', h: 3, dir: 90 });
    expect(building!.poly).toHaveLength(4);
    expect(ringArea(building!.poly)).toBeCloseTo(60, 0);
  });

  it('LOD1-only: height falls back to LOD1 top − base, no roof', () => {
    const { building, roof } = toBuilding(pbs[1]!, ORIGIN);
    expect(roof.kind).toBe('lod1');
    expect(building!.h).toBeCloseTo(12, 5);
    expect(building!.roof).toBeUndefined();
    expect(building!.id).toBe(131010000042);
  });

  it('a building whose geometry lives only in parts is skipped (noFootprint)', () => {
    expect(toBuilding(pbs[2]!, ORIGIN).skip).toBe('noFootprint');
    expect(toBuilding(pbs[2]!.parts[0]!, ORIGIN).building!.h).toBe(12);
  });

  it('lod2Tiers: a stepped roof becomes one grounded prism per level', () => {
    const pb = {
      ...pbs[0]!,
      roofs: [
        { ring: parsePosList(posList(rect(0, 0, 10, 5, 35))), polyIds: [] },
        { ring: parsePosList(posList(rect(0, 5, 10, 10, 20))), polyIds: [] },
        { ring: parsePosList(posList(rect(0, 10, 10, 15, 20))), polyIds: [] },
      ],
    };
    const { tiers, fallback } = lod2Tiers(pb, ORIGIN, 5, 7);
    expect(fallback).toBe(false);
    expect(tiers.map((t) => [t.id, t.h])).toEqual([
      [7000, 30],
      [7001, 15],
    ]);
    expect(ringArea(tiers[1]!.poly)).toBeCloseTo(100, 0); // two facets unioned
    expect(checkBuildings(tiers)).toEqual([]);
  });
});

describe('validation', () => {
  it('checkBuildings accepts the fixture output and validateCity agrees', () => {
    const buildings = [...buildingChunks(FIXTURE)]
      .map(parseBuilding)
      .map((pb) => toBuilding(pb, ORIGIN).building)
      .filter((b) => b !== undefined);
    expect(buildings).toHaveLength(2);
    expect(checkBuildings(buildings)).toEqual([]);
    expect(() =>
      validateCity({ v: 1, origin: ORIGIN, bbox: [139, 35, 140, 36], buildings, roads: [], places: [] }),
    ).not.toThrow();
  });

  it('checkBuildings reports duplicate ids, bad h and bad roof.h', () => {
    const poly = [[0, 0], [1, 0], [1, 1]];
    const errs = checkBuildings([
      { id: 1, h: 10, poly },
      { id: 1, h: 700, poly },
      { id: 2, h: 5, roof: { shape: 'gabled', h: 4.5 }, poly },
    ]);
    expect(errs).toEqual([
      'buildings[1].id: duplicate',
      'buildings[1].h: out of [3, 650]',
      'buildings[2].roof.h: out of range',
    ]);
  });

  const OUT = '.cache/plateau/out/0_0.json';
  it.skipIf(!existsSync(OUT))('prototype output .cache/plateau/out/0_0.json passes validateCity', () => {
    const { buildings } = JSON.parse(readFileSync(OUT, 'utf8')) as { buildings: unknown[] };
    expect(buildings.length).toBeGreaterThan(0);
    expect(checkBuildings(buildings)).toEqual([]);
    expect(() =>
      validateCity({ v: 1, origin: ORIGIN, bbox: [139.692, 35.645, 139.82, 35.715], buildings, roads: [], places: [] }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------- T-0163

/** Axis-aligned box ring `[x0, z0]–[x1, z1]`. */
function box(x0: number, z0: number, x1: number, z1: number): Vec2[] {
  return [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
}

/** A PLATEAU-merge input row. */
function prow(id: number, poly: Vec2[], plateauName?: string): { building: Building; plateauName?: string } {
  return { building: { id: PLATEAU_ID_BASE + id, h: 20, poly }, ...(plateauName ? { plateauName } : {}) };
}

// Stepped tower: 30 × 30 m podium (top 15 m) around a 10 × 10 m tower (top
// 60 m), ground at 5. The podium's roof facets form a ring with a HOLE where
// the tower stands (four trapezoids sharing full edges, like a PLATEAU mesh).
const PODIUM: P3[][] = [
  [[0, 0, 20], [30, 0, 20], [20, 10, 20], [10, 10, 20]],
  [[30, 0, 20], [30, 30, 20], [20, 20, 20], [20, 10, 20]],
  [[30, 30, 20], [0, 30, 20], [10, 20, 20], [20, 20, 20]],
  [[0, 30, 20], [0, 0, 20], [10, 10, 20], [10, 20, 20]],
];
const STEPPED = `<core:CityModel><core:cityObjectMember>
<bldg:Building gml:id="bldg_stepped">
  <bldg:measuredHeight uom="m">60</bldg:measuredHeight>
  <bldg:lod0RoofEdge><gml:MultiSurface>${polygon('lod0-st', rect(0, 0, 30, 30, 0))}</gml:MultiSurface></bldg:lod0RoofEdge>
  ${lod1(0, 0, 30, 30, 5, 65)}
  ${PODIUM.map((r, k) => surface('RoofSurface', `st-podium-${k}`, r)).join('\n')}
  ${surface('RoofSurface', 'st-tower', rect(10, 10, 20, 20, 65))}
</bldg:Building>
</core:cityObjectMember></core:CityModel>`;

describe('T-0163 id range', () => {
  it('plateauId is a stable hash of gml:id in [2^48, 2^49): no collision with OSM ids or curated extras', () => {
    expect(PLATEAU_ID_BASE).toBe(2 ** 48);
    expect(plateauId('bldg_a1b2c3')).toBe(306127763354995);
    expect(plateauId('bldg_a1b2c3')).toBe(plateauId('bldg_a1b2c3'));
    expect(plateauId('bldg_a1b2c4')).not.toBe(plateauId('bldg_a1b2c3'));
    for (const g of ['bldg_house', 'bldg_x', '', 'bldg_0a4f5b1c-7d2e-4f6a-9b8c-1d2e3f4a5b6c']) {
      const id = plateauId(g);
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(2 ** 48);
      expect(id).toBeLessThan(2 ** 49);
      expect(isPlateauId(id)).toBe(true);
    }
    // OSM way ids (≈ 1.4·10⁹ today, 2^40 headroom), curated extras, prototype ids.
    for (const id of [1, 4247312, 1419103534, 2 ** 40, -1000, -999999, 131020003711]) expect(isPlateauId(id)).toBe(false);
  });

  it('assignIds walks in order and bumps collisions deterministically', () => {
    const rows = [{ gmlId: 'a', building: { id: 0 } }, { gmlId: 'a', building: { id: 0 } }, { gmlId: 'b', building: { id: 0 } }];
    expect(assignIds(rows)).toBe(1);
    expect(rows[0]!.building.id).toBe(plateauId('a'));
    expect(rows[1]!.building.id).toBe(plateauId('a') + 1);
    expect(rows[2]!.building.id).toBe(plateauId('b'));
  });
});

describe('T-0163 tile assignment = tile-city rule', () => {
  it('buildingTileKey floors the unrounded vertex mean (negative keys, exact boundaries)', () => {
    expect(buildingTileKey(box(0, 0, 10, 10), 1000)).toBe('0_0');
    expect(buildingTileKey(box(-10, -10, 0, 0), 1000)).toBe('-1_-1');
    expect(buildingTileKey(box(990, 1990, 1010, 2010), 1000)).toBe('1_2'); // mean exactly on the line
    // A 3-vertex ring whose mean is 999.9666… stays in tile 0 (no rounding).
    expect(buildingTileKey([[999.9, 0], [1000, 0], [1000, 10]], 1000)).toBe('0_0');
  });

  it('retile of a tileCity output with the same buildings reproduces tiles, stats and landmarks exactly', () => {
    const city = syntheticCity(1, 12);
    const tiled = tileCity(city, 100);
    const out = retile(tiled.index, tiled.tiles, city.buildings);
    expect(out.created).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.index).toEqual(tiled.index);
    expect([...out.tiles.keys()]).toEqual([...tiled.tiles.keys()]);
    for (const [k, t] of tiled.tiles) expect(JSON.stringify(out.tiles.get(k))).toBe(JSON.stringify(t));
  });

  it('every building lands in the tile tileCity would put it in; new tiles are created, emptied ones dropped', () => {
    const city = syntheticCity(2, 8);
    const tiled = tileCity(city, 100);
    const moved: Building[] = [
      ...city.buildings.filter((b) => buildingTileKey(b.poly, 100) !== '0_0'),
      { id: 9e6, h: 10, name: 'Far', poly: box(5000, 5000, 5010, 5010) },
    ];
    const expected = tileCity({ ...city, buildings: moved }, 100);
    const out = retile(tiled.index, tiled.tiles, moved);
    expect(out.created).toEqual(['50_50']);
    for (const [k, t] of out.tiles) {
      expect(t.buildings.map((b) => b.id)).toEqual(expected.tiles.get(k)?.buildings.map((b) => b.id) ?? []);
    }
    expect(out.index.landmarks).toEqual(expected.index.landmarks);
    expect(out.tiles.get('50_50')!.roads).toEqual([]);
    expect(out.index.tiles['50_50']).toEqual({
      buildings: 1,
      roads: 0,
      trees: 0,
      bytes: Buffer.byteLength(JSON.stringify(out.tiles.get('50_50')), 'utf8'),
    });
    // A tile with nothing but buildings disappears when they all move out.
    const lone: TileData = { v: 1, buildings: [{ id: 1, h: 5, poly: box(10, 10, 20, 20) }], roads: [] };
    const idx = { ...tiled.index, tiles: { '0_0': { buildings: 1, roads: 0, trees: 0, bytes: 1 } } };
    const r = retile(idx, new Map([['0_0', lone]]), [{ id: 1, h: 5, poly: box(110, 10, 120, 20) }]);
    expect(r.removed).toEqual(['0_0']);
    expect(r.created).toEqual(['1_0']);
    expect(Object.keys(r.index.tiles)).toEqual(['1_0']);
  });
});

describe('T-0163 merge rules 3/4/5', () => {
  const OSM: Building[] = [
    { id: 1, h: 14, name: 'Alpha', poly: box(0, 0, 20, 20) }, // rule 3a partner of P1
    { id: 2, h: 14, name: 'Beta', poly: box(100, 0, 110, 10) }, // inside P2 (IoU 1/9) → rule 3b
    { id: 3, h: 14, poly: box(200, 0, 210, 10) }, // not covered → kept (rule 4)
    { id: 4, h: 14, name: 'Delta', poly: box(300, 0, 310, 10) }, // covered by P5 → replaced, name moves
    { id: 5, h: 14, poly: box(400, 0, 420, 20) }, // 25 % covered → replaced
    { id: 6, h: 14, poly: box(500, 0, 520, 20) }, // 10 % covered → kept
    { id: 7, h: 50, poly: box(600, 0, 620, 20) }, // grounded stack, 3 heights → parts
    { id: 8, h: 100, poly: box(605, 5, 615, 15) },
    { id: 9, h: 200, name: 'Tower', poly: box(608, 8, 612, 12) },
    { id: 10, h: 30, minH: 10, poly: box(700, 0, 710, 10) }, // raised part: 1/3 of P10
    { id: 11, h: 30, minH: 5, poly: box(740, 0, 745, 10) }, // raised part: 1/6 of P11
    { id: 12, h: 14, poly: box(800, 0, 810, 10) }, // duplicated outline, same h → NOT parts
    { id: 13, h: 14, poly: box(800, 0, 810, 10) },
  ];
  const PLATEAU = [
    prow(1, box(0, 0, 20, 19)),
    prow(2, box(95, -5, 125, 25)),
    prow(3, box(900, 0, 910, 10), 'ぴー'),
    prow(4, box(950, 0, 960, 10)),
    prow(5, box(300, 0, 310, 10), 'PLATEAU name loses to OSM'),
    prow(6, box(400, 0, 405, 20)),
    prow(7, box(500, 0, 502, 20)),
    prow(8, box(600, 0, 620, 20)),
    prow(9, box(620, 0, 640, 20)),
    prow(10, box(700, 0, 730, 10)),
    prow(11, box(740, 0, 770, 10)),
  ];

  it('osmPartFlags: raised parts and ≥ 3-height stacks are parts; same-height duplicates are not', () => {
    expect(osmPartFlags(OSM)).toEqual([false, false, false, false, false, false, true, true, true, true, true, false, false]);
  });

  it('coveredShare counts overlapping covers once', () => {
    expect(coveredShare(box(0, 0, 20, 20), [box(0, 0, 10, 20), box(0, 0, 10, 20), box(5, 0, 15, 20)])).toBeCloseTo(0.75, 5);
    expect(coveredShare(box(0, 0, 20, 20), [])).toBe(0);
  });

  const { buildings, stats } = mergeBuildings(PLATEAU, OSM);
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const P = (k: number) => byId.get(PLATEAU_ID_BASE + k);

  it('rule 5: OSM parts are kept and suppress PLATEAU buildings ≥ 30 % under them', () => {
    for (const id of [7, 8, 9, 10, 11]) expect(byId.has(id)).toBe(true);
    expect(P(8)).toBeUndefined(); // 100 % under the stack
    expect(P(10)).toBeUndefined(); // 33 %
    expect(P(9)).toBeDefined(); // adjacent, 0 %
    expect(P(11)).toBeDefined(); // 17 %
    expect(stats.suppressedByParts).toBe(2);
    expect(stats.osmParts).toBe(5);
  });

  it('rule 4: non-part OSM buildings covered < 20 % by PLATEAU stay; the rest are replaced', () => {
    const osmOut = buildings.filter((b) => !isPlateauId(b.id)).map((b) => b.id);
    expect(osmOut).toEqual([3, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(stats.osmKeptUncovered).toBe(4);
    expect(stats.osmDropped).toBe(4);
  });

  it('rule 3: IoU ≥ 0.5 partner name, else the named OSM building ≥ 50 % covered, else gml:name, else none', () => {
    expect(P(1)!.name).toBe('Alpha');
    expect(P(2)!.name).toBe('Beta');
    expect(P(3)!.name).toBe('ぴー');
    expect(P(4)!.name).toBeUndefined();
    expect(P(5)!.name).toBe('Delta');
    expect(P(9)!.name).toBeUndefined(); // no name from the neighbouring parts
    expect(stats).toMatchObject({ namesByIou: 2, namesByCover: 1, namesFromPlateau: 1 });
    // Key order stays id, h, name, …, poly; inputs are not mutated.
    expect(Object.keys(P(1)!)).toEqual(['id', 'h', 'name', 'poly']);
    expect(PLATEAU[0]!.building.name).toBeUndefined();
  });

  it('rule 3b: Shibuya-like split complex: name lands on the most-overlapping unnamed piece; an already named piece is never overwritten', () => {
    const osm: Building[] = [
      { id: 21, h: 30, name: 'Shibuya', poly: box(0, 0, 100, 40) }, // split in 3, no IoU/cover match
      { id: 22, h: 30, name: 'Echo', poly: box(200, 0, 300, 40) }, // every piece already named
    ];
    const plateau = [
      prow(21, box(0, 0, 30, 40)), // 1200 m² overlap, 1200 m² footprint
      prow(22, box(30, 0, 70, 40), 'Named piece'), // most overlap (1600 m²) but named
      prow(23, box(70, -40, 100, 40)), // 1200 m² overlap tie, larger footprint → wins
      prow(24, box(200, 0, 240, 40), 'Gamma'),
      prow(25, box(240, 0, 270, 40), 'Kappa'),
      prow(26, box(270, 0, 300, 40), 'Lambda'),
    ];
    const m = mergeBuildings(plateau, osm);
    const by = new Map(m.buildings.map((b) => [b.id, b]));
    const name = (k: number) => by.get(PLATEAU_ID_BASE + k)!.name;
    expect(m.buildings.some((b) => !isPlateauId(b.id))).toBe(false); // both OSM replaced
    expect(name(23)).toBe('Shibuya');
    expect(name(22)).toBe('Named piece');
    expect(name(21)).toBeUndefined();
    expect([name(24), name(25), name(26)]).toEqual(['Gamma', 'Kappa', 'Lambda']);
    expect(m.stats).toMatchObject({ namesByIou: 0, namesByCover: 0, namesFromPlateau: 4, namesByFallback: 1, namesUnplaced: 1 });
    // The main fixture transfers every name by rules 1–3: 3b does nothing there.
    expect(stats).toMatchObject({ namesByFallback: 0, namesUnplaced: 0 });
  });

  it('determinism: the same input gives byte-identical merge + retile output', () => {
    const again = mergeBuildings(
      PLATEAU.map((r) => ({ ...r, building: { ...r.building } })),
      OSM.map((b) => ({ ...b })),
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify({ buildings, stats }));
    const tiled = tileCity({ v: 1, origin: ORIGIN, bbox: [139, 35, 140, 36], buildings: OSM, roads: [], places: [] }, 100);
    const a = retile(tiled.index, tiled.tiles, buildings);
    const b = retile(tiled.index, tiled.tiles, again.buildings);
    expect(JSON.stringify([a.index, [...a.tiles]])).toBe(JSON.stringify([b.index, [...b.tiles]]));
  });
});

describe('T-0163 tiers', () => {
  const [stepped] = [...buildingChunks(STEPPED)].map(parseBuilding);
  const [house] = [...buildingChunks(FIXTURE)].map(parseBuilding);

  it('unionFacetsWithHoles keeps the podium hole; splitHoles cuts it into plan-disjoint pieces', () => {
    const u = unionFacetsWithHoles(PODIUM.map((r) => r.map(([x, z]) => [x, z])));
    expect(u!.outers).toHaveLength(1);
    expect(u!.holes).toHaveLength(1);
    const pieces = splitHoles(u!.outers[0]!, u!.holes);
    expect(pieces).toHaveLength(2);
    expect(pieces.reduce((s, r) => s + ringArea(r), 0)).toBeCloseTo(800, 5);
    expect(intersectionArea(pieces[0]!, pieces[1]!)).toBe(0);
    for (const r of pieces) expect(intersectionArea(r, box(10, 10, 20, 20))).toBe(0);
  });

  it('stepped LOD2 → tiers (plan-disjoint, h in [1, h], union ≈ poly) and never a roof', () => {
    const conv = convertBuilding(stepped!, ORIGIN);
    expect(conv.kind).toBe('stepped');
    const b = conv.building!;
    expect(b.roof).toBeUndefined();
    expect(Object.keys(b)).toEqual(['id', 'h', 'tiers', 'poly']);
    const tiers = b.tiers!;
    expect(tiers.map((t) => t.h).sort((p, q) => p - q)).toEqual([15, 15, 60]);
    for (const t of tiers) expect(t.h).toBeLessThanOrEqual(b.h);
    expect(tiers.reduce((s, t) => s + ringArea(t.poly), 0)).toBeCloseTo(ringArea(b.poly), 0);
    for (let i = 0; i < tiers.length; i++) {
      for (let j = i + 1; j < tiers.length; j++) expect(intersectionArea(tiers[i]!.poly, tiers[j]!.poly)).toBe(0);
    }
    expect(checkBuildings([b])).toEqual([]);
  });

  it('a sloped LOD2 roof keeps its roof and gets no tiers; the gml:name is returned, not set', () => {
    const conv = convertBuilding(house!, ORIGIN);
    expect(conv.building!.roof?.shape).toBe('gabled');
    expect(conv.building!.tiers).toBeUndefined();
    expect(conv.building!.name).toBeUndefined();
    expect(conv.plateauName).toBe('テストハウス');
  });

  it('buildTiers rejects overlapping (overhanging) levels and single levels', () => {
    const over = {
      ...stepped!,
      roofs: [
        { ring: parsePosList(posList(rect(0, 0, 20, 20, 40))), polyIds: [] },
        { ring: parsePosList(posList(rect(10, 0, 30, 20, 20))), polyIds: [] },
      ],
    };
    expect(buildTiers(over, ORIGIN, 5, 35)).toEqual({ tiers: null, reason: 'overlap' });
    const one = { ...stepped!, roofs: [{ ring: parsePosList(posList(rect(0, 0, 30, 30, 40))), polyIds: [] }] };
    expect(buildTiers(one, ORIGIN, 5, 35)).toEqual({ tiers: null, reason: 'single' });
  });

  it('checkBuildings rejects roof + tiers together and tier h outside [1, h]', () => {
    const poly = box(0, 0, 10, 10);
    expect(
      checkBuildings([
        { id: 1, h: 10, roof: { shape: 'gabled', h: 2 }, tiers: [{ h: 5, poly }], poly },
        { id: 2, h: 10, tiers: [{ h: 11, poly }, { h: 0.5, poly }], poly },
      ]),
    ).toEqual([
      'buildings[0].tiers: together with roof',
      'buildings[1].tiers[0].h: out of [1, h]',
      'buildings[1].tiers[1].h: out of [1, h]',
    ]);
  });
});
