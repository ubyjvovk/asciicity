#!/usr/bin/env node
/**
 * PLATEAU prototype (T-0162): convert the PLATEAU buildings of ONE Tokyo
 * tile into our `Building[]`, match them against the shipped OSM tile and
 * print coverage / match stats. Research tool — writes ONLY under
 * `.cache/plateau/` (gitignored), never `public/data/`.
 *
 *   node scripts/plateau/fetch-cell.mjs [--tile 0_0] [--coverage]
 *
 * - Mesh files come from the PLATEAU data-catalog API
 *   (`/datacatalog/citygml/m:<mesh>`), which lists per-mesh CityGML URLs
 *   (served gzip-encoded, ≈ 8:1) with feature / LOD counts; raw files are
 *   cached in `.cache/plateau/raw/`, API answers in `.cache/plateau/catalog/`.
 * - Output: `.cache/plateau/out/<tile>.json` (`{ v: 1, buildings }`),
 *   `<tile>.prisms.json` (the LOD2-tiers what-if) and `<tile>.stats.json`.
 * - `--coverage` also sums the API's per-mesh counts over the whole Tokyo
 *   bbox (no geometry download).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildingChunks,
  meshBounds,
  meshesForBbox,
  parseBuilding,
  texturedPolygonIds,
} from './citygml.mjs';
import { meshFiles as catalogFiles, meshGml as cachedGml } from './fetch.mjs';
import {
  checkBuildings,
  lod2Tiers,
  matchFootprints,
  ringArea,
  toBuilding,
} from './map.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE = join(ROOT, '.cache/plateau');
const CITY = join(ROOT, 'public/data/tokyo');
const TILE = 1000;
const OSM_DEFAULT_H = new Set([10, 14, 15, 20, 30]);

/** Local metres → lon/lat (inverse of osm-convert `project`). */
function unproject(x, z, origin) {
  return [origin.lon + x / (Math.cos((origin.lat * Math.PI) / 180) * 111320), origin.lat - z / 110574];
}

/** Catalog entry for one mesh: every city's bldg file for it (`fetch.mjs`, shared cache). */
function meshFiles(code) {
  return catalogFiles(code, CACHE);
}

/** Download and cache a mesh GML (`fetch.mjs`); returns its path. */
function meshGml(file) {
  return cachedGml(file, CACHE, console.log);
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)} %` : 'n/a');
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const tally = (arr) => Object.fromEntries([...arr.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]));

/** Whole-bbox coverage from the catalog API (counts only). */
async function coverage(index) {
  const meshes = meshesForBbox(index.bbox);
  const [bx0, by0, bx1, by1] = index.bbox;
  let features = 0;
  let lod2 = 0;
  let bytes = 0;
  let wFeatures = 0;
  let wLod2 = 0;
  let wBytes = 0;
  const cities = new Set();
  for (const code of meshes) {
    const files = await meshFiles(code);
    if (!files.length) continue;
    // A mesh on a ward boundary is published whole by every ward (verified
    // byte-identical for 53394611) → take one copy, the largest.
    const f = files.sort((a, b) => b.features - a.features)[0];
    files.forEach((x) => cities.add(x.city));
    const [mx0, my0, mx1, my1] = meshBounds(code);
    const w = (Math.max(0, Math.min(mx1, bx1) - Math.max(mx0, bx0)) * Math.max(0, Math.min(my1, by1) - Math.max(my0, by0))) / ((mx1 - mx0) * (my1 - my0));
    features += f.features;
    lod2 += f.lod2;
    bytes += f.fileSize;
    wFeatures += w * f.features;
    wLod2 += w * f.lod2;
    wBytes += w * f.fileSize;
  }
  const osm = Object.values(index.tiles).reduce((s, t) => s + t.buildings, 0);
  return {
    meshes: meshes.length,
    cities: [...cities].sort(),
    meshUnion: { features, lod2, lod2Share: lod2 / features, gmlBytes: bytes },
    bboxWeighted: { features: Math.round(wFeatures), lod2: Math.round(wLod2), gmlBytes: Math.round(wBytes) },
    osmBuildings: osm,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const tileKey = args.includes('--tile') ? args[args.indexOf('--tile') + 1] : '0_0';
  const [ti, tj] = tileKey.split('_').map(Number);
  const index = JSON.parse(readFileSync(join(CITY, 'index.json'), 'utf8'));
  const origin = index.origin;
  const rect = [ti * TILE, tj * TILE, (ti + 1) * TILE, (tj + 1) * TILE];
  const [lon0, lat1] = unproject(rect[0], rect[1], origin);
  const [lon1, lat0] = unproject(rect[2], rect[3], origin);
  const meshes = meshesForBbox([lon0, lat0, lon1, lat1]);
  console.log(`tile ${tileKey}: lon ${lon0.toFixed(5)}–${lon1.toFixed(5)}, lat ${lat0.toFixed(5)}–${lat1.toFixed(5)} → meshes ${meshes.join(', ')}`);

  const t0 = Date.now();
  const seen = new Set();
  const rows = [];
  let parsedTotal = 0;
  let textured = 0;
  const catalog = [];
  for (const code of meshes) {
    const files = await meshFiles(code);
    if (!files.length) continue;
    const file = files.sort((a, b) => b.features - a.features)[0];
    catalog.push({ code, city: file.city, cities: files.map((f) => f.city), features: file.features, lod2: file.lod2, fileSize: file.fileSize });
    const xml = readFileSync(await meshGml(file), 'utf8');
    const tex = texturedPolygonIds(xml);
    for (const chunk of buildingChunks(xml)) {
      parsedTotal++;
      const pb = parseBuilding(chunk);
      if (seen.has(pb.gmlId)) continue;
      seen.add(pb.gmlId);
      const conv = toBuilding(pb, origin);
      const poly = conv.building?.poly;
      // Same exclusive anchor rule as the tiler: vertex mean of the ring.
      if (poly) {
        const ax = poly.reduce((s, p) => s + p[0], 0) / poly.length;
        const az = poly.reduce((s, p) => s + p[1], 0) / poly.length;
        if (ax < rect[0] || ax >= rect[2] || az < rect[1] || az >= rect[3]) continue;
      } else {
        const r = pb.lod1[0] ?? pb.lod0[0];
        if (!r) continue;
        const [lon, lat] = [r[0][1], r[0][0]];
        if (lon < lon0 || lon >= lon1 || lat < lat0 || lat >= lat1) continue;
      }
      const isTex = [...pb.roofs.flatMap((r) => r.polyIds), ...pb.wallPolyIds].some((id) => tex.has(id));
      if (isTex) textured++;
      rows.push({ pb, conv, isTex });
    }
  }
  const parseSec = (Date.now() - t0) / 1000;

  // --- OSM side: tile + 8 neighbours for candidates, stats on the tile only.
  const osmTile = [];
  const osmCand = [];
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const f = join(CITY, 'tiles', `${ti + di}_${tj + dj}.json`);
      if (!existsSync(f)) continue;
      const t = JSON.parse(readFileSync(f, 'utf8'));
      for (const b of t.buildings) {
        osmCand.push(b);
        if (di === 0 && dj === 0) osmTile.push(b);
      }
    }
  }
  const osmTileBytes = existsSync(join(CITY, 'tiles', `${tileKey}.json`))
    ? readFileSync(join(CITY, 'tiles', `${tileKey}.json`)).length
    : 0;

  const out = rows.filter((r) => r.conv.building);
  const t1 = Date.now();
  const matches = matchFootprints(out.map((r) => r.conv.building.poly), osmCand.map((b) => b.poly));
  const matchSec = (Date.now() - t1) / 1000;
  const matchedOsm = new Set();
  const dh = [];
  const dhDefault = [];
  let named = 0;
  out.forEach((r, k) => {
    const m = matches[k];
    r.match = m;
    if (m.iou >= 0.5) {
      const o = osmCand[m.j];
      matchedOsm.add(o);
      // osm-convert fallbacks (HEIGHT_BY_BUILDING, final 14 m) = no height/levels tag.
      (OSM_DEFAULT_H.has(o.h) ? dhDefault : dh).push(r.conv.building.h - o.h);
      // Merge rule (docs/plateau.md Q5): OSM names win (English, landmark tables key on them).
      if (o.name) {
        r.conv.building.name = o.name;
        named++;
      }
    }
  });
  const osmTileMatched = osmTile.filter((b) => matchedOsm.has(b)).length;
  // Reverse direction: OSM tile buildings that PLATEAU does not cover (merge rule: keep them).
  const reverse = matchFootprints(osmTile.map((b) => b.poly), out.map((r) => r.conv.building.poly));
  const osmUncovered = reverse.filter((m) => m.covered < 0.2).length;

  // --- Outputs.
  const buildings = out.map((r) => r.conv.building);
  const prisms = [];
  let prismParents = 0;
  let unionFallbacks = 0;
  for (const r of out) {
    const k = r.conv.roof.kind;
    if ((k === 'stepped' || k === 'complex') && r.conv.base !== undefined) {
      const { tiers, fallback } = lod2Tiers(r.pb, origin, r.conv.base, r.conv.building.id);
      if (fallback) unionFallbacks++;
      if (tiers.length) {
        prismParents++;
        prisms.push(...tiers);
        continue;
      }
    }
    prisms.push(r.conv.building);
  }
  const errs = [...checkBuildings(buildings), ...checkBuildings(prisms).map((e) => `prisms: ${e}`)];
  mkdirSync(join(CACHE, 'out'), { recursive: true });
  const outJson = JSON.stringify({ v: 1, buildings });
  const prismJson = JSON.stringify({ v: 1, buildings: prisms });
  writeFileSync(join(CACHE, 'out', `${tileKey}.json`), outJson);
  writeFileSync(join(CACHE, 'out', `${tileKey}.prisms.json`), prismJson);
  const osmBuildingBytes = JSON.stringify(osmTile).length;

  const lod2Rows = rows.filter((r) => r.pb.roofs.length);
  const flatFam = out.filter((r) => (r.conv.roof.kind === 'flat' || r.conv.roof.kind === 'stepped') && Number.isFinite(r.conv.roof.mainY) && r.conv.base !== undefined);
  const ious = matches.map((m) => m.iou);
  const absDh = dh.map(Math.abs);
  const stats = {
    tile: tileKey,
    meshes: catalog,
    parse: { chunks: parsedTotal, unique: seen.size, seconds: parseSec },
    plateau: {
      inTile: rows.length,
      lod2: lod2Rows.length,
      lod2Share: lod2Rows.length / rows.length,
      textured,
      withName: rows.filter((r) => r.pb.name).length,
      withMeasuredHeight: rows.filter((r) => r.pb.measuredHeight > 0).length,
      withStoreys: rows.filter((r) => r.pb.storeys > 0).length,
      buildingParts: rows.reduce((s, r) => s + r.pb.parts.length, 0),
      multiPolygonLod0: rows.filter((r) => r.pb.lod0.length > 1).length,
      installations: rows.reduce((s, r) => s + r.pb.installations, 0),
      lodType: tally(rows.map((r) => r.pb.lodType ?? '-')),
      usage: tally(rows.map((r) => r.pb.usage ?? '-')),
      fireproofStructureType: tally(rows.map((r) => r.pb.fireproof ?? '-')),
      skipped: tally(rows.filter((r) => r.conv.skip).map((r) => r.conv.skip)),
      roofKinds: tally(rows.map((r) => r.conv.roof.kind)),
      roofEmitted: tally(buildings.filter((b) => b.roof).map((b) => b.roof.shape)),
      maxH: Math.max(...buildings.map((b) => b.h)),
      steppedPenthouseLike: rows.filter((r) => r.conv.roof.kind === 'stepped' && r.conv.roof.topShare < 0.2).length,
      // measuredHeight vs the LOD2 roof: top flat level / largest flat level (flat family).
      hMinusTopLevelMedian: median(flatFam.map((r) => r.conv.building.h - (r.conv.roof.topY - r.conv.base))),
      hMinusMainLevelMedian: median(flatFam.map((r) => r.conv.building.h - (r.conv.roof.mainY - r.conv.base))),
      hMinusMainLevelGt3: flatFam.filter((r) => r.conv.building.h - (r.conv.roof.mainY - r.conv.base) > 3).length,
      flatFamily: flatFam.length,
    },
    osm: {
      inTile: osmTile.length,
      parts: osmTile.filter((b) => (b.minH ?? 0) > 0).length,
      named: osmTile.filter((b) => b.name).length,
      withRoof: osmTile.filter((b) => b.roof).length,
      tileBytes: osmTileBytes,
      buildingBytes: osmBuildingBytes,
    },
    match: {
      seconds: matchSec,
      iouGe05: ious.filter((u) => u >= 0.5).length,
      iouGe07: ious.filter((u) => u >= 0.7).length,
      iouMedian: median(ious),
      noOverlap: matches.filter((m) => m.j < 0).length,
      splitOrMerged: matches.filter((m) => m.iou < 0.5 && m.covered >= 0.5).length,
      uncovered: matches.filter((m) => m.covered < 0.2).length,
      osmTileMatched,
      osmUncovered,
      namesFromOsm: named,
      osmTaggedHeightPairs: dh.length,
      osmDefaultHeightPairs: dhDefault.length,
      defaultHeightDiffMedian: median(dhDefault),
      heightDiffMedian: median(dh),
      heightAbsDiffMedian: median(absDh),
      heightAbsDiffGt5: absDh.filter((d) => d > 5).length,
      heightAbsDiffGt10: absDh.filter((d) => d > 10).length,
    },
    output: {
      buildings: buildings.length,
      bytes: outJson.length,
      bytesPerBuilding: outJson.length / buildings.length,
      footprintAreaM2: Math.round(buildings.reduce((s, b) => s + ringArea(b.poly), 0)),
      osmFootprintAreaM2: Math.round(osmTile.reduce((s, b) => s + ringArea(b.poly), 0)),
      prisms: prisms.length,
      prismParents,
      unionFallbacks,
      prismBytes: prismJson.length,
      validationErrors: errs.length,
    },
  };
  if (args.includes('--coverage')) stats.coverage = await coverage(index);
  writeFileSync(join(CACHE, 'out', `${tileKey}.stats.json`), JSON.stringify(stats, null, 2));

  const p = stats.plateau;
  const m = stats.match;
  const o = stats.output;
  console.log(`parsed ${parsedTotal} chunks (${seen.size} unique) in ${parseSec.toFixed(1)} s`);
  console.log(`PLATEAU in tile: ${p.inTile} buildings, LOD2 ${p.lod2} (${pct(p.lod2, p.inTile)}), textured ${p.textured} (${pct(p.textured, p.inTile)}), named ${p.withName}, measuredHeight ${p.withMeasuredHeight}, storeys ${p.withStoreys}, parts ${p.buildingParts}, installations ${p.installations}`);
  console.log(`  lodType ${JSON.stringify(p.lodType)} skipped ${JSON.stringify(p.skipped)}`);
  console.log(`  roof kinds ${JSON.stringify(p.roofKinds)} → emitted roof ${JSON.stringify(p.roofEmitted)}; max h ${p.maxH}`);
  console.log(`OSM in tile: ${stats.osm.inTile} buildings (${stats.osm.parts} parts, ${stats.osm.named} named, ${stats.osm.withRoof} with roof); tile file ${stats.osm.tileBytes} B`);
  console.log(`match (${m.seconds.toFixed(1)} s): IoU≥0.5 ${m.iouGe05}/${out.length} (${pct(m.iouGe05, out.length)}), IoU≥0.7 ${m.iouGe07} (${pct(m.iouGe07, out.length)}), median IoU ${m.iouMedian.toFixed(2)}; split/merged ${m.splitOrMerged}; uncovered by OSM ${m.uncovered}; OSM tile buildings matched ${m.osmTileMatched}/${stats.osm.inTile} (${pct(m.osmTileMatched, stats.osm.inTile)}), not covered by PLATEAU ${m.osmUncovered}; names from OSM ${m.namesFromOsm}`);
  console.log(`  height PLATEAU−OSM on matches with a TAGGED OSM height (${m.osmTaggedHeightPairs}): median ${m.heightDiffMedian.toFixed(1)} m, median |Δ| ${m.heightAbsDiffMedian.toFixed(1)} m, |Δ|>5 m ${m.heightAbsDiffGt5}, |Δ|>10 m ${m.heightAbsDiffGt10}; vs OSM default heights (${m.osmDefaultHeightPairs}): median ${m.defaultHeightDiffMedian.toFixed(1)} m`);
  console.log(`  flat-family roofs (${p.flatFamily}): measuredHeight − top level median ${p.hMinusTopLevelMedian.toFixed(1)} m, − largest level median ${p.hMinusMainLevelMedian.toFixed(1)} m (> 3 m: ${p.hMinusMainLevelGt3}); stepped with top level < 20 % (penthouse-like) ${p.steppedPenthouseLike}`);
  console.log(`output: ${o.buildings} buildings, ${o.bytes} B (${o.bytesPerBuilding.toFixed(0)} B/building; OSM buildings in tile ${stats.osm.buildingBytes} B), footprint area ${o.footprintAreaM2} m² vs OSM ${o.osmFootprintAreaM2} m²`);
  console.log(`  tiers what-if: ${o.prisms} entries (${o.prismParents} stepped/complex buildings → tiers, ${o.unionFallbacks} union fallbacks), ${o.prismBytes} B`);
  console.log(`validation: ${errs.length ? errs.slice(0, 10).join('; ') : 'OK (0 errors)'}`);
  if (stats.coverage) {
    const c = stats.coverage;
    console.log(`coverage (Tokyo bbox, ${c.meshes} meshes, wards ${c.cities.join(',')}): mesh union ${c.meshUnion.features} buildings, LOD2 ${c.meshUnion.lod2} (${pct(c.meshUnion.lod2, c.meshUnion.features)}), GML ${(c.meshUnion.gmlBytes / 1e9).toFixed(2)} GB; bbox-area-weighted ≈ ${c.bboxWeighted.features} buildings, LOD2 ≈ ${c.bboxWeighted.lod2}; OSM shipped ${c.osmBuildings}`);
  }
  console.log(`wrote .cache/plateau/out/${tileKey}.json, ${tileKey}.prisms.json, ${tileKey}.stats.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
