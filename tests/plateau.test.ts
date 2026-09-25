/**
 * T-0162 — PLATEAU prototype helpers (`scripts/plateau/citygml.mjs`,
 * `scripts/plateau/map.mjs`) on a tiny inline CityGML fixture, plus a
 * `validateCity` pass over the prototype output when it has been generated
 * (`node scripts/plateau/fetch-cell.mjs` → `.cache/plateau/out/0_0.json`).
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
  iou,
  lod2Tiers,
  matchFootprints,
  numericId,
  ringArea,
  toBuilding,
  unionFacets,
} from '../scripts/plateau/map';
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
