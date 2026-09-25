/**
 * PLATEAU CityGML (i-UR / uro 3.x, spec 5.0) building reader — zero deps.
 *
 * Pure string scanning, no XML library: PLATEAU files are machine-written
 * (FME) with a fixed element vocabulary, so a handful of regexes over one
 * `<bldg:Building>` chunk at a time is enough and keeps a 166 MB mesh file
 * in the tens of seconds. Coordinates stay in the file's CRS (EPSG:6697,
 * JGD2011 geographic + T.P. height): posList triples are `lat lon h`.
 * Projection to our local metres happens in `map.mjs`.
 *
 * Also: JIS X 0410 standard-mesh helpers (PLATEAU ships buildings per 3rd
 * order mesh, 30″ lat × 45″ lon ≈ 0.92 × 1.13 km at Tokyo).
 */

/** PLATEAU data-catalog API root (per-mesh file lists with feature/LOD counts). */
export const DATACATALOG = 'https://api.plateau.reearth.io/datacatalog';

/**
 * 3rd-order (≈1 km) JIS X 0410 mesh code containing a point.
 * @param {number} lon degrees
 * @param {number} lat degrees
 * @returns {string} 8-digit code, e.g. `"53394611"`
 */
export function meshCode3(lon, lat) {
  const latIdx = Math.floor(lat * 120 + 1e-9);
  const lonIdx = Math.floor((lon - 100) * 80 + 1e-9);
  return meshFromIdx(latIdx, lonIdx);
}

/** Mesh code from 30″ latitude / 45″ longitude cell indices. */
function meshFromIdx(latIdx, lonIdx) {
  const p = Math.floor(latIdx / 80);
  const q = Math.floor((latIdx % 80) / 10);
  const r = latIdx % 10;
  const u = Math.floor(lonIdx / 80);
  const v = Math.floor((lonIdx % 80) / 10);
  const w = lonIdx % 10;
  return `${String(p).padStart(2, '0')}${String(u).padStart(2, '0')}${q}${v}${r}${w}`;
}

/**
 * Geographic bounds of a 3rd-order mesh.
 * @param {string} code 8-digit mesh code
 * @returns {[number, number, number, number]} `[minLon, minLat, maxLon, maxLat]`
 */
export function meshBounds(code) {
  if (!/^\d{8}$/.test(code)) throw new Error(`mesh: expected an 8-digit code, got ${code}`);
  const d = code.split('').map(Number);
  const latIdx = (d[0] * 10 + d[1]) * 80 + d[4] * 10 + d[6];
  const lonIdx = (d[2] * 10 + d[3]) * 80 + d[5] * 10 + d[7];
  return [100 + lonIdx / 80, latIdx / 120, 100 + (lonIdx + 1) / 80, (latIdx + 1) / 120];
}

/**
 * Every 3rd-order mesh intersecting a bbox, row-major south→north, west→east.
 * @param {[number, number, number, number]} bbox `[minLon, minLat, maxLon, maxLat]`
 * @returns {string[]}
 */
export function meshesForBbox(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const la0 = Math.floor(minLat * 120 + 1e-9);
  const la1 = Math.ceil(maxLat * 120 - 1e-9) - 1;
  const lo0 = Math.floor((minLon - 100) * 80 + 1e-9);
  const lo1 = Math.ceil((maxLon - 100) * 80 - 1e-9) - 1;
  const out = [];
  for (let a = la0; a <= la1; a++) for (let o = lo0; o <= lo1; o++) out.push(meshFromIdx(a, o));
  return out;
}

/**
 * Yield each top-level `<bldg:Building …>…</bldg:Building>` chunk of a file.
 * `BuildingPart` / `BuildingInstallation` never match the open tag (they
 * continue the name before the space) and close with their own tags.
 * @param {string} xml whole CityGML document
 * @returns {Generator<string>}
 */
export function* buildingChunks(xml) {
  const OPEN = '<bldg:Building ';
  const CLOSE = '</bldg:Building>';
  let i = xml.indexOf(OPEN);
  while (i >= 0) {
    const j = xml.indexOf(CLOSE, i);
    if (j < 0) return;
    yield xml.slice(i, j + CLOSE.length);
    i = xml.indexOf(OPEN, j);
  }
}

/**
 * Parse a posList into `[lat, lon, h]` triples (srsDimension 3).
 * @param {string} text whitespace-separated numbers
 * @returns {number[][]}
 */
export function parsePosList(text) {
  const n = text.trim().split(/\s+/).map(Number);
  const out = [];
  for (let i = 0; i + 2 < n.length; i += 3) out.push([n[i], n[i + 1], n[i + 2]]);
  return out;
}

/** Text of the first `<tag …>text<` in `xml`, or undefined. */
function tagText(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)<`).exec(xml);
  return m ? m[1].trim() : undefined;
}

/** Remove every `open…close` block; return the rest and the removed blocks. */
function stripBlocks(xml, open, close) {
  const blocks = [];
  let out = '';
  let pos = 0;
  for (;;) {
    const i = xml.indexOf(open, pos);
    if (i < 0) break;
    const j = xml.indexOf(close, i);
    if (j < 0) break;
    out += xml.slice(pos, i);
    blocks.push(xml.slice(i, j + close.length));
    pos = j + close.length;
  }
  return { rest: out + xml.slice(pos), blocks };
}

const EXTERIOR_RE =
  /<gml:exterior>\s*<gml:LinearRing[^>]*>\s*<gml:posList[^>]*>([^<]*)<\/gml:posList>/g;

/** Exterior rings (`[lat, lon, h][]`) of every polygon inside `xml`. */
function exteriors(xml) {
  return [...xml.matchAll(EXTERIOR_RE)].map((m) => parsePosList(m[1]));
}

/** Inner text of the first `<tag>…</tag>` block, or ''. */
function block(xml, tag) {
  const i = xml.indexOf(`<${tag}>`);
  if (i < 0) return '';
  const j = xml.indexOf(`</${tag}>`, i);
  return j < 0 ? '' : xml.slice(i, j);
}

/** Finite number or undefined; PLATEAU writes -9999 for "unknown". */
function num(s) {
  if (s === undefined) return undefined;
  const v = Number(s);
  return Number.isFinite(v) && v > -9999 ? v : undefined;
}

/**
 * Parse one `<bldg:Building>` (or `<bldg:BuildingPart>`) chunk.
 * Geometry is kept per LOD as exterior rings in file coordinates; only
 * exterior rings are read (courtyard holes are rare in LOD0 and irrelevant
 * to roof classification). `BuildingInstallation`s (canopies, rooftop
 * sheds) are stripped before any geometry is read.
 * @param {string} xml the chunk
 * @returns {import('./citygml').PlateauBuilding}
 */
export function parseBuilding(xml) {
  const parts = stripBlocks(xml, '<bldg:consistsOfBuildingPart>', '</bldg:consistsOfBuildingPart>');
  const inst = stripBlocks(parts.rest, '<bldg:outerBuildingInstallation>', '</bldg:outerBuildingInstallation>');
  const own = inst.rest;
  const gmlId = /gml:id="([^"]+)"/.exec(own)?.[1] ?? '';
  const roofs = [];
  for (const m of own.matchAll(/<bldg:RoofSurface\b[^>]*>([\s\S]*?)<\/bldg:RoofSurface>/g)) {
    const polyIds = [...m[1].matchAll(/<gml:Polygon gml:id="([^"]+)"/g)].map((p) => p[1]);
    for (const ring of exteriors(m[1])) roofs.push({ ring, polyIds });
  }
  const grounds = [];
  for (const m of own.matchAll(/<bldg:GroundSurface\b[^>]*>([\s\S]*?)<\/bldg:GroundSurface>/g)) {
    grounds.push(...exteriors(m[1]));
  }
  const wallPolyIds = [];
  let walls = 0;
  for (const m of own.matchAll(/<bldg:WallSurface\b[^>]*>([\s\S]*?)<\/bldg:WallSurface>/g)) {
    walls++;
    for (const p of m[1].matchAll(/<gml:Polygon gml:id="([^"]+)"/g)) wallPolyIds.push(p[1]);
  }
  const lod0Xml = block(own, 'bldg:lod0FootPrint') || block(own, 'bldg:lod0RoofEdge');
  const nameM = /<gml:name>([^<]*)<\/gml:name>/.exec(own);
  return {
    gmlId,
    buildingId: tagText(own, 'uro:buildingID'),
    city: tagText(own, 'uro:city'),
    name: nameM ? nameM[1].trim() || undefined : undefined,
    measuredHeight: num(tagText(own, 'bldg:measuredHeight')),
    storeys: num(tagText(own, 'bldg:storeysAboveGround')),
    usage: tagText(own, 'bldg:usage'),
    fireproof: tagText(own, 'uro:fireproofStructureType'),
    lodType: tagText(own, 'uro:lodType'),
    lod0: exteriors(lod0Xml),
    lod1: exteriors(block(own, 'bldg:lod1Solid')),
    roofs,
    grounds,
    walls,
    wallPolyIds,
    installations: inst.blocks.length,
    parts: parts.blocks.map((b) => {
      const i = b.indexOf('<bldg:BuildingPart');
      const j = b.lastIndexOf('</bldg:BuildingPart>');
      return parseBuilding(i >= 0 && j > i ? b.slice(i, j) : b);
    }),
  };
}

/**
 * Ids of every polygon that a `ParameterizedTexture` (photo texture)
 * targets in the document's appearance section.
 * @param {string} xml whole CityGML document
 * @returns {Set<string>}
 */
export function texturedPolygonIds(xml) {
  const out = new Set();
  for (const m of xml.matchAll(/<app:target uri="#([^"]+)"/g)) out.add(m[1]);
  return out;
}
