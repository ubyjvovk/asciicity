/**
 * Type declarations for `scripts/plateau/citygml.mjs`, so the vitest test
 * and `tsc --noEmit` can import the JS module without `allowJs`. The `.mjs`
 * runtime is authoritative.
 */

/** `[lat, lon, h]` — EPSG:6697 posList order. */
export type GeoPoint = [number, number, number];

/** One LOD2 roof facet: exterior ring + the ids of its gml:Polygon(s). */
export interface PlateauRoof {
  ring: GeoPoint[];
  polyIds: string[];
}

/** A parsed `<bldg:Building>` / `<bldg:BuildingPart>`. */
export interface PlateauBuilding {
  gmlId: string;
  buildingId?: string;
  city?: string;
  name?: string;
  measuredHeight?: number;
  storeys?: number;
  usage?: string;
  fireproof?: string;
  lodType?: string;
  lod0: GeoPoint[][];
  lod1: GeoPoint[][];
  roofs: PlateauRoof[];
  grounds: GeoPoint[][];
  walls: number;
  wallPolyIds: string[];
  installations: number;
  parts: PlateauBuilding[];
}

/** PLATEAU data-catalog API root. */
export const DATACATALOG: string;
/** 3rd-order JIS X 0410 mesh code containing (lon, lat). */
export function meshCode3(lon: number, lat: number): string;
/** `[minLon, minLat, maxLon, maxLat]` of a 3rd-order mesh. */
export function meshBounds(code: string): [number, number, number, number];
/** Every 3rd-order mesh intersecting `[minLon, minLat, maxLon, maxLat]`. */
export function meshesForBbox(bbox: [number, number, number, number]): string[];
/** Top-level `<bldg:Building>` chunks of a CityGML document. */
export function buildingChunks(xml: string): Generator<string>;
/** posList text → `[lat, lon, h]` triples. */
export function parsePosList(text: string): GeoPoint[];
/** Parse one building chunk. */
export function parseBuilding(xml: string): PlateauBuilding;
/** Polygon ids targeted by a `ParameterizedTexture`. */
export function texturedPolygonIds(xml: string): Set<string>;
