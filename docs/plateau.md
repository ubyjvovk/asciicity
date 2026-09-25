# PLATEAU for Tokyo — data access, licence, coverage, mapping (T-0162 spike)

Research for wave 22: rebuild central Tokyo's buildings from Project PLATEAU
(MLIT's open 3D city models) instead of / on top of OSM. Everything below was
measured on 2026-09-25 with the prototype in `scripts/plateau/` unless marked
as an estimate. Our Tokyo extent: bbox `139.692, 35.645, 139.820, 35.715`,
origin `139.7671, 35.6812` (Tokyo Station), tiles of 1 km (data-format.md
"Tiled datasets").

## TL;DR

- **Get it from the PLATEAU data-catalog API, per 1 km mesh, as CityGML.**
  `GET https://api.plateau.reearth.io/datacatalog/citygml/m:<mesh>` lists
  every ward's building file for that mesh (with feature and LOD counts); the
  file URLs serve the raw `.gml` gzip-encoded (≈ 8:1), so a Node 22 `fetch`
  gets it with no zip handling and no npm deps. Latest data: **FY2025, spec
  5.0, published per ward** by the Tokyo Metropolitan Government.
- **Licence OK**: PLATEAU content is under PDL 1.0 and is declared compatible
  with CC BY 4.0. Derived JSON can ship in `public/data/` under our CC
  BY-NC-SA 4.0 with attribution and a "modified" notice (quotes in Q2).
- **Coverage over our bbox**: ≈ 195 k PLATEAU buildings (vs 170.6 k OSM),
  **≈ 35 % of them LOD2**, 100 % with a measured height. On our tile `0_0`
  (Yaesu / Nihonbashi) every building is LOD2 and textured.
- **Biggest win is height**: 86 % of the OSM buildings in tile `0_0` (98 %
  in the residential tile `-4_-3`) sit at one of the converter's DEFAULT
  heights (10/14/15/20/30 m; 83 % of `0_0` at exactly 14 m); PLATEAU gives
  a surveyed `measuredHeight` for 97–98 %.
- **Mapping**: LOD1 → our `Building` 1:1 (footprint + `measuredHeight`).
  LOD2 roofs classify into our `roof` shapes only for 6 % of LOD2 buildings
  (gabled/hipped/skillion/pyramidal); 48 % are *stepped* or *complex* —
  representable today as extra grounded prisms (+120 % bytes on a LOD2 tile)
  or, cleaner, with a new optional `Building.tiers` (PM decision, proposed
  type in Q4).
- **Merge**: keep OSM for roads / water / trees / places / names; replace
  building geometry with PLATEAU; transfer OSM names by footprint IoU ≥ 0.5
  (79 % / 78 % of PLATEAU buildings match on the two cells); keep the ~4 %
  of OSM buildings PLATEAU does not cover.
- **Size**: ≈ 35 MB for the whole Tokyo dataset with LOD1 envelopes (today
  28.3 MB), ≈ 45 MB with LOD2 tiers — inside the 60 MB budget.

## Prototype

```
node scripts/plateau/fetch-cell.mjs [--tile 0_0] [--coverage]
```

- `scripts/plateau/citygml.mjs` — JIS X 0410 mesh helpers + CityGML building
  reader (regex scan per `<bldg:Building>` chunk; no XML dependency).
- `scripts/plateau/map.mjs` — PLATEAU → `Building`, roof classifier, LOD2
  tiers what-if, footprint IoU matching, a TS-free `validateCity` building
  re-check. `.d.ts` siblings for the tests / `tsc`.
- `scripts/plateau/fetch.mjs` — catalog API + GML download with the file
  cache (shared by `fetch-cell.mjs` and `tokyo.mjs` since T-0163).
- `scripts/plateau/fetch-cell.mjs` — the CLI: tile rect → meshes → catalog
  API → cached GML (`.cache/plateau/raw/`, API answers in
  `.cache/plateau/catalog/`) → `.cache/plateau/out/<tile>.json`
  (`{ v: 1, buildings }`), `<tile>.prisms.json` (tiers what-if),
  `<tile>.stats.json`, stats on stdout. Nothing is written to `public/data/`.
- `tests/plateau.test.ts` — the pure helpers on an inline CityGML fixture,
  and `validateCity` over `.cache/plateau/out/0_0.json` when it exists.

A cold run of tile `0_0` (4 meshes, 641 MB of GML, 80 MB on the wire) takes
≈ 1 min; warm ≈ 5 s (parse 2.5 s, IoU matching 0.7 s).

## Production converter (T-0163)

```
npm run fetch-data:tokyo-plateau
# = node scripts/plateau/tokyo.mjs --data public/data/tokyo [--cache .cache/plateau]
```

Post-processes an EXISTING OSM-built tiled Tokyo dataset IN PLACE: only
`buildings` in the tiles and `index.landmarks` / `index.tiles` change;
roads, bridge roads, trees, woods, water, rivers, terrain and places are
untouched. It refuses a dataset that already holds PLATEAU ids (ids in
`[2^48, 2^49)`), so re-run it on a fresh OSM dataset
(`npm run fetch-data:tokyo`), never twice on the same one. Files:

- `scripts/plateau/tokyo.mjs` — the CLI (I/O, stats, validation);
- `scripts/plateau/merge.mjs` — the pure half, unit-tested in
  `tests/plateau.test.ts`: `convertBuilding`, `buildTiers`, `plateauId` /
  `assignIds`, `osmPartFlags`, `coveredShare`, `mergeBuildings`, `retile`;
- `scripts/plateau/map.mjs` — gains `unionFacetsWithHoles`, `splitHoles`,
  `lod2Tiers(…, { splitHoles })`, tier checks in `checkBuildings`.

**Pipeline** (rules: data-format.md "Tokyo from PLATEAU (wave 22)"):

1. Every JIS 3rd-order mesh intersecting `index.bbox` (99) → catalog API
   (latest year per ward) → one download per DISTINCT ward copy (same
   `features` + `fileSize` = the same copy; 32 boundary meshes have two
   copies of different byte size but identical `gml:id` sets) → cached
   under `<cache>/raw/`. Buildings (and `BuildingPart`s, none so far) are
   de-duplicated by `gml:id`, first copy wins (ward copies sorted by
   feature count, then ward code).
2. `convertBuilding` = `toBuilding` (rule 1: LOD1/LOD0 envelope, 0.1 m,
   collinear vertices dropped, `measuredHeight` clamped [3, 650]; rule 2
   roofs for gabled / hipped / skillion / pyramidal) + `buildTiers` for
   `stepped` / `complex` LOD2 roofs. A building keeps it only when its
   vertex-mean anchor lies in the bbox.
3. **Tiers** (rule 2): the `lod2Tiers` levels (1.5 m clustering, facet
   union by edge cancellation). A level's union can have HOLES (a podium
   around its tower): `splitHoles` cuts a holed ring along a vertical line
   through the hole into hole-free pieces, recursively, so tiers stay
   simple rings and plan-disjoint. Each tier `h` = level top − LOD1 base,
   clamped to `[1, h]`. Rejected (envelope only) when < 2 tiers survive,
   > 64, or two tiers overlap by > 5 % of the smaller (overhanging LOD2
   facets, T-junction unions). `roof` is deleted whenever tiers are set
   (never both).
4. **Ids** (rule 1): `plateauId` = low 48 bits of FNV-1a-64(`gml:id`) +
   2^48 → `[2^48, 2^49)`, exact doubles, disjoint from OSM way ids and the
   curated extras. `assignIds` walks the buildings sorted by `gml:id` and
   bumps a collision by +1 (0 collisions on the real data).
5. **OSM parts** (rule 5): our tiles no longer carry the
   `building:part` tag, so `osmPartFlags` recognises parts by geometry — a
   STACK is a set of OSM buildings linked by plan overlaps ≥ 50 % of the
   smaller footprint; every member of a stack holding a raised part
   (`minH > 0`) or ≥ 3 distinct heights is a part (Skytree's decks + mast,
   Tokyo Tower's 30 concentric grounded tiers). Same-height duplicates and
   outline + canopy pairs are not parts (without the 3-heights test,
   944 buildings qualified, including duplicate outlines such as the Bank of
   Japan's). Parts are kept and suppress every PLATEAU building whose
   footprint is ≥ 30 % covered by the UNION of the parts (`coveredShare`,
   so stacked parts count once).
6. **Kept OSM** (rule 4): non-part OSM buildings covered < 20 % by the
   union of the kept PLATEAU footprints stay as they are.
7. **Names** (rule 3, non-part OSM only): the best-IoU partner's name at
   IoU ≥ 0.5 (if that partner is named); else the named OSM building the
   PLATEAU footprint covers ≥ 50 % (largest overlap); else the PLATEAU
   `gml:name`; else none. **Rule 3b** (PM, rework 1): then every
   replaced named OSM building whose name reached none of the PLATEAU
   buildings overlapping it gives the name to the still-unnamed PLATEAU
   building it overlaps most (> 0 m²; ties → larger PLATEAU footprint, then
   input order). Larger OSM footprints choose first; a name set by rules
   1–3 or by an earlier 3b pick is never overwritten. Kept OSM buildings
   (rules 4/5) keep their own name and take no part.
8. **Retile** (`retile`, same anchor as `scripts/tile-city.mjs`: unrounded
   vertex mean, `Math.floor(c / tileSize)`): each tile keeps its roads /
   trees / woods and gets kept OSM buildings (old tile order) then PLATEAU
   buildings (`gml:id` order); `index.tiles` stats are recomputed
   (`bytes` = written length), new tiles are appended in (j, i) order,
   tiles left empty are deleted, and `index.landmarks` is rebuilt from the
   named buildings in tile scan order (tiler rule 4). Files are written
   through `.tmp` + rename.
9. **Validation**: `validateTileIndex(index)`, `validateCity` on every
   tile's buildings and on all buildings as one city (global id
   uniqueness; bridge roads + places), and `checkBuildings` (the `tiers`
   rules until `validate.ts` learns them in T-0164). Any error → exit 1.
   Stats go to `<cache>/tokyo.stats.json`.

**Measured** (2026-09-25, a copy of the committed OSM dataset,
`node scripts/plateau/tokyo.mjs --data .cache/plateau/tokyo-copy`, warm
cache; the cold download of the 132 ward copies — 8.4 GB of GML on disk —
took ≈ 2 min, 105 s of it transfers):

| | |
|---|---:|
| meshes / ward copies parsed | 99 / 132 (8.88 GB GML) |
| building chunks / unique `gml:id` | 309 419 / 225 989 |
| PLATEAU in bbox (outside 32 799; < 2 m² footprints dropped 380) | 192 810 |
| suppressed by OSM parts (rule 5) | 166 |
| **PLATEAU buildings kept** | **192 644** |
| OSM parts kept (rule 5) | 439 |
| **OSM kept, < 20 % covered (rule 4)** | **7 341** |
| OSM replaced by PLATEAU | 162 839 of 170 619 |
| names: IoU partner / ≥ 50 % covered / PLATEAU `gml:name` / fallback 3b | 13 854 / 752 / 688 / 277 (241 OSM buildings found every overlapping piece already named) |
| roof kinds (in bbox) | LOD1-only 118 695, flat 35 823, stepped 15 514, complex 12 457, gabled 7 029, hipped 2 130, skillion 878, pyramidal 283 |
| `roof` emitted | gabled 6 855, hipped 2 114, skillion 869, pyramidal 278 |
| `tiers` emitted | 23 540 buildings, 92 900 tiers (max 63 per building) |
| tiers rejected → envelope | single level 2 665, overlap 1 724, > 64 3 |
| buildings / landmarks / tiles | 200 424 / 16 133 / 129 (none created or removed) |
| **bytes** (index + tiles) | 28 325 662 → **50 487 274** (≤ 60 MB budget) |
| **max tile** | 646 815 → **1 347 764** (`1_-3`) |
| validation | 129 tiles + index + 200 424 buildings: 0 errors |
| wall time (warm cache) | 120 s (PLATEAU parse + convert 63 s, merge 56 s) |
| determinism | runs on fresh copies: byte-identical (sha1 of every file; re-checked after rule 3b) |

Without `splitHoles` the overlap check rejected 6 837 tier sets (podiums
around towers) and the dataset was 45.4 MB; with it, 23 540 buildings keep
their massing for +5 MB.

**Landmarks / presets** on the output: `Tokyo Skytree` (OSM part, 634 m,
anchor unchanged), `Tokyo Tower` (OSM part stack kept — the curated
333 m / `tower` override still applies; the PLATEAU tower block is
suppressed), `Akihabara` (now a PLATEAU building, 20.3 m, anchor moved
32 m), `Tokyo Station` (OSM, unchanged), `Shinjuku` (PLATEAU, 20.7 m, 10
tiers) all resolve. **`Shibuya`** (the station-building outline; only
comments in `spawn.ts` cite its anchor, the `shibuya` preset uses fixed
coordinates) resolves through rule 3b: PLATEAU splits the complex into
buildings that neither match it at IoU ≥ 0.5 nor cover it ≥ 50 %, and the
most-overlapping unnamed piece takes the name (anchor moved 75.6 m).
Before rule 3b, 455 of 14 496 distinct OSM building names (3 %) were lost
that way; with it 212 (1.5 %) are, all on OSM buildings whose overlapping
PLATEAU pieces are already named. 682 new names come in (PLATEAU
`gml:name`s).

## Q1 — Access

**Datasets (G空間情報センター / geospatial.jp CKAN, licence id `plateau`):**

| dataset | spec | notes |
|---|---|---|
| `plateau-<code>-<ward>-2025`, e.g. [plateau-13102-chuo-ku-2025](https://www.geospatial.jp/ckan/dataset/plateau-13102-chuo-ku-2025) | 5.0 | **latest**; one per ward, "pref" (Tokyo Metropolitan Government) build; buildings LOD0/1/2.0/2.2 (+ LOD3/4 in Minato, Taito, Sumida) |
| [plateau-tokyo23ku-2022](https://www.geospatial.jp/ckan/dataset/plateau-tokyo23ku-2022) | 2.3 | all 23 wards in one 5.85 GB CityGML zip (`13100_tokyo23-ku_2022_citygml_1_2_op.zip`) + 9.4 GB 3D Tiles/MVT zip |
| [plateau-tokyo23ku](https://www.geospatial.jp/ckan/dataset/plateau-tokyo23ku) | 1–2 | FY2020 original (5.3 GB CityGML v2, 4.3 GB 3D Tiles/GeoJSON/MVT/Shape, FBX, OBJ, FGDB) |

Wards touching our bbox (from the catalog): 13101 Chiyoda, 13102 Chuo,
13103 Minato, 13104 Shinjuku, 13105 Bunkyo, 13106 Taito, 13107 Sumida,
13108 Koto, 13110 Meguro, 13113 Shibuya, 13114 Nakano, 13116 Toshima.
Their full FY2025 CityGML zips total **12.7 GB** (Chuo alone 2.48 GB;
everything: buildings + textures + roads, DEM, vegetation, flood …).

**What we actually need** — only `udx/bldg/<mesh>_bldg_6697_op.gml` for the
99 third-order meshes (30″ × 45″ ≈ 0.93 × 1.13 km) intersecting the bbox:
**6.75 GB of GML uncompressed, ≈ 0.85 GB on the wire** (the CMS stores them
gzip-encoded; measured 166.0 MB → 20.7 MB = 8.0:1). Tile `0_0` needs meshes
53394601/02/11/12: 641 MB → 80 MB, downloaded in ≈ 13 s.

**Catalog API** (`https://api.plateau.reearth.io/datacatalog`, used by PLATEAU VIEW):
- `/plateau-datasets` — the whole catalog (9 MB JSON: `citygml`,
  `datasets` with 3D Tiles / MVT URLs, sizes, LOD, texture flags);
- `/citygml/<cityCode>` and **`/citygml/m:<mesh>`** — per-mesh file list:
  `{ code, maxLod, url, fileSize, features, lod0, lod1, lod2, lod3, lod4 }`.
  The `url` points inside an extracted copy of the ward zip on
  `assets.cms.plateau.reearth.io` and serves the single `.gml`.

A mesh on a ward boundary is published **whole by every ward** (mesh
53394611 in the Chiyoda and Chuo zips: identical 1 022 `gml:id`s, identical
size) → take one copy per mesh, dedupe by `gml:id` anyway.

**Format choice** — CityGML, for these reasons:
- it is the only format that keeps the semantics we need (`measuredHeight`,
  `RoofSurface` vs `WallSurface`, `lod0RoofEdge` footprints, `buildingID`,
  names, usage) and it is plain text: a regex scan per `<bldg:Building>`
  chunk parses 641 MB in 2.5 s in Node 22 with zero deps;
- **3D Tiles** (FY2025: b3dm/glTF per ward, LOD1 8–58 MB, LOD2 textured up
  to 454 MB) are render meshes — triangles without roof/wall surface
  semantics; parsing glTF (+ possible Draco/meshopt compression) by hand is
  more work for less information;
- **MVT** is only published for roads / land use / zoning / water in
  FY2025 (buildings are 3D Tiles only); FY2020 had a Building-MVT and a
  GeoJSON variant, but it is 5 years older (survey 2016–17);
- **FBX/OBJ** are discontinued for the latest data ("最新データはFBXは提供せず");
- **ZIP range reads** also work (the zips answer `Accept-Ranges: bytes`;
  the prototype's first iteration read the central directory of the 2.5 GB
  Chuo zip — 72 194 entries — and inflated single entries), but the
  per-file URLs make that unnecessary. Keep it as the fallback if the CMS
  per-file URLs ever disappear.

## Q2 — Licence

Every PLATEAU dataset on geospatial.jp is licensed "PLATEAU Site Policy
「３．著作権について」に拠る" → <https://www.mlit.go.jp/plateau/site-policy/>,
section 3 "コンテンツの利用" (quoted 2026-09-25):

> 当ウェブサイトで公開している情報（「G空間情報センター」にて公開している3D都市モデルのオープンデータを含む。…）の著作権は、特記されていない限り国土交通省に帰属し（なお、「G空間情報センター」にて公開している3D都市モデルのオープンデータの著作権は、各地方公共団体に帰属）、権利表記の記載がない限り「公共データ利用規約（第1.0版）」（PDL1.0）に準拠した利用条件の下で、利用することができます。

(Copyright of the 3D city model open data belongs to each local government;
it may be used under the Public Data License 1.0.)

> ① コンテンツを利用する際は出典を記載してください。…（出典記載例）出典：国土交通省 PLATEAUウェブサイト（当該ページのURL）
> ② コンテンツを編集・加工等して利用する場合は、上記出典とは別に、編集・加工等を行ったことを記載してください。なお、編集・加工した情報を、あたかも国土交通省が作成したかのような態様で公表・利用してはいけません。

(Cite the source; when editing/processing, state that you did, and do not
present the result as if MLIT made it.)

> 本利用ルールは、クリエイティブ・コモンズ・ライセンスの表示4.0 国際ライセンス（以下「CC BY」）と互換性があります。国土交通省都市局国際・デジタル政策課は、本利用ルールが適用されるコンテンツについて、利用者がCC BYに従って利用することを許諾します。また、利用者がOpen Data Commonsによる ODC BY 又は ODbL での利用を希望する場合に、それを妨げるものではありません。

(These rules are compatible with CC BY 4.0; MLIT permits users to use the
content under CC BY; ODC-BY or ODbL use is not prevented either.) The
dataset pages add: 「商用利用も含め、どなたでも無償で自由にご利用いただけます。」

**Compatibility with CC BY-NC-SA 4.0 — confirmed** (with conditions). We may
use the data under CC BY 4.0, whose adapter clause only requires that "the
Adapter's License You apply must not prevent recipients of the Adapted
Material from complying with this Public License" — licensing our DERIVED
JSON under BY-NC-SA while keeping the attribution satisfies that, and
PDL 1.0 imposes nothing beyond attribution + a modification notice. Mixing
with OSM (ODbL) is explicitly not hindered. Required attribution (README +
in-game credits line):

> 出典：3D都市モデル（Project PLATEAU）千代田区・中央区・港区・新宿区・文京区・台東区・墨田区・江東区・目黒区・渋谷区・中野区・豊島区（2025年度）（国土交通省 / 東京都, https://www.mlit.go.jp/plateau/ ）を加工して作成
> Building geometry: Project PLATEAU 3D city models, Tokyo wards (FY2025), MLIT / Tokyo Metropolitan Government, used under PDL 1.0 / CC BY 4.0 — modified (converted, simplified) by AsciiCity.

Caveat I could not close: the policy's item (2) warns that some content is
restricted by individual laws, citing the Survey Act (測量法) for public
survey results, with a pointer to the handbooks. Our use is display of the
published open data, not re-use as survey results, and the dataset pages
say free use including commercial — I read that as non-blocking, but it is
a legal reading, not a lawyer's.

## Q3 — Coverage over our bbox

From the catalog API (`--coverage`; one copy per mesh):

| | buildings | LOD2 | LOD2 share |
|---|---:|---:|---:|
| 99 meshes intersecting the bbox (union, 11.25 × 9.26 km) | 226 010 | 79 569 | 35.2 % |
| weighted by each mesh's overlap with the bbox (estimate) | ≈ 194 800 | ≈ 73 100 | ≈ 37.5 % |
| OSM, shipped `public/data/tokyo/` | 170 619 | — | — |

LOD2 share per mesh (`#` ≥ 80 %, `+` 20–80 %, `.` < 20 %; west → east
139.6875 … 139.825, north at the top):

```
......+##+.  35.7083
....+++#+..  35.7000
++..+###+++  35.6917
++.+.+##...  35.6833
...+.+##+..  35.6750
...#####+..  35.6667
++.+####+..  35.6583
++..+####..  35.6500
.+..+####+.  35.6417
```

LOD2 = the central spine (Marunouchi / Tokyo Station / Nihonbashi / Ginza /
Shimbashi / Toranomon / Akasaka / Roppongi / Tokyo Tower) plus parts of
Shinjuku/Shibuya in the west column and Asakusa/Skytree in the north-east;
residential Shinjuku/Bunkyo/Taito/Sumida/Koto are LOD1-only.

Measured on two prototype cells:

| | tile `0_0` (Yaesu/Nihonbashi) | tile `-4_-3` (Shinjuku-ku residential) |
|---|---:|---:|
| PLATEAU buildings (anchor in tile) | 2 001 | 4 841 (13 dropped: footprint < 2 m²) |
| LOD2 / textured | 2 001 / 2 001 (100 %) | 0 / 0 |
| `measuredHeight` present | 1 948 (97.4 %) | 4 765 (98.4 %) |
| `storeysAboveGround` | 2 001 | 4 841 |
| `gml:name` | 16 | 11 |
| `BuildingPart`s | 0 | 0 |
| OSM buildings in the tile | 1 963 (366 named) | 4 472 (54 named) |
| OSM at a converter default height (10/14/15/20/30 m) | 1 688 (86 %) | 4 392 (98 %) |

**Attributes present** (spec 5.0, every building in both cells): `bldg:class`,
`bldg:usage` (codes: 401 office, 411 detached house, 412 apartment, 413
shop+house, 461 …), `measuredHeight`, `storeysAbove/BelowGround`,
`lod0RoofEdge` (footprint = roof outline incl. eaves), `lod1Solid`,
`lod2Solid` + `RoofSurface` / `WallSurface` / `GroundSurface`,
`BuildingInstallation` (1 957 in `0_0`: canopies, rooftop plant),
`uro:buildingID` (`13102-bldg-3711`), address, `uro:fireproofStructureType`
(1001 fire-resistant … 1003 other), floor-area / zoning / flood-risk
attributes, `uro:lodType` (`2.2`). **Not present**: roof type attribute,
facade/roof colour or material, building-part massing. Appearance: every
LOD2 surface has a JPEG (`ParameterizedTexture`; tile `0_0`'s 4 meshes:
19 921 JPEGs, 204 MB); the `X3DMaterial`s are only white `1 1 1` / grey
`0.5 0.5 0.5` placeholders — no usable colour without decoding JPEGs.

## Q4 — Mapping onto `Building`

Implemented in `map.mjs` `toBuilding` (all outputs pass `validateCity`):

| `Building` field | source |
|---|---|
| `id` | `uro:buildingID` `CCCCC-bldg-N` → `CCCCC × 10⁷ + N` (1.3·10¹¹ – 1.4·10¹¹; OSM way ids are ≈ 1.4·10⁹ — no collision); fallback FNV hash of `gml:id` + 2·10¹² |
| `poly` | largest `lod0FootPrint`/`lod0RoofEdge` ring → LOD1 bottom face → largest LOD2 ground surface; projected with `osm-convert` `project()`, 0.1 m rounding, collinear-vertex removal |
| `h` | `measuredHeight` (ground → highest point), else LOD1 top − base; clamp [3, 650] |
| `roof` | LOD2 roof classifier (below), only for schema shapes |
| `name` | OSM name of the IoU-matched OSM building (English), else PLATEAU `gml:name` (Japanese) |
| `minH` | never (PLATEAU buildings are grounded; no `BuildingPart`s in our cells) |
| `osmColor`/`roofColor`/`material` | none — see "colours" below |

**Height**: `measuredHeight` vs the LOD2 roof on the 1 495 flat-family roofs
of `0_0`: median −0.4 m below the top roof level, +0.4 m above the largest
level — it is the top of the building. Against OSM on matched pairs:
where OSM has a TAGGED height (252 pairs in `0_0`, 76 in `-4_-3`) the
median |Δ| is 3.3 m / 1.8 m; where OSM fell back to a default the median
PLATEAU − OSM is +5.6 m (offices taller than 14 m) / −4.0 m (houses lower).
Use `measuredHeight` everywhere.

**Roof classification** (`classifyRoof`, facets ≥ 0.5 m², ≤ 75°; sloped ≥
8°): flat / stepped / complex / skillion / gabled / hipped / pyramidal —
rules in the JSDoc. On `0_0`'s 2 001 LOD2 buildings:

| kind | count | emitted as |
|---|---:|---|
| flat | 905 | no `roof` |
| stepped (≥ 2 flat levels > 3 m apart, top < 70 %) | 590 (434 of them "penthouse-like": top level < 20 %) | no `roof` (h = top) |
| complex (25–75 % sloped, or off-axis slopes) | 367 | no `roof` |
| gabled | 98 | `gabled` (90; 8 dropped: rise < 0.5 m) |
| hipped | 21 | `hipped` (20; 1 dropped: rise < 0.5 m) |
| skillion | 19 | `skillion` |
| pyramidal | 1 | `pyramidal` |

`dir` follows `roofFrame` (ridge bearing; a skillion rises towards
`dir + 90`); every one of the 129 emitted sloped roofs has its `dir`
within 20° of the longest footprint edge's axis (85 along it, 44 across
it — none diagonal), which is the sanity check available without images. Visual check of the
roofs not done (no image viewing in this worker) — PM GPU review.

**Colours**: the only colour source is the photo textures. Mean colour per
building (walls → `osmColor`, roof → `roofColor`) needs a JPEG decoder;
with no deps that means a hand-written baseline decoder that keeps only DC
coefficients (1/8-scale image, mean = mean of DCs): ≈ 250 lines, plus
204 MB of JPEGs per 4 meshes to download (≈ 3 GB for the LOD2 area). Not
done here; optional ticket below. `material`: nothing maps reliably
(`fireproofStructureType` 1003 is often, not always, wood) → leave absent.

**What the current schema cannot represent**:
1. **Stepped towers / podium + tower / penthouses** (590 in `0_0`): one
   prism at `h` = top overstates the podium; at the main level it loses the
   tower.
2. **Complex LOD2 roofs** (367): mixed flat + sloped, sawtooth, curved.
3. Courtyard holes (we keep exterior rings only — true of OSM too).
4. `BuildingInstallation`s (canopies, rooftop plant) — ignore.

**Option A (no schema change, measured)** — `lod2Tiers`: cluster the roof
facets by top height (1.5 m), union each cluster by cancelling shared edges
(0 fallbacks on `0_0`), emit one grounded prism per ring (`id × 1000 + k`).
The facets partition the roof, so prisms never overlap in plan and the
internal walls are hidden inside the union. `0_0`: 2 001 buildings →
**4 066 entries, 240 → 530 KB (+120 %)**, valid. Downsides: every tier is a
separate building to the renderers — its own id-hash palette colour, its own
landmark/tag/neon/facade-detail placement (internal walls would get AC units
and signs), HUD counts inflate.

**Option B (recommended, PM decision — schema change)**: keep the building
as ONE entry whose `poly`/`h` is the LOD1 envelope (so every existing
consumer — collision, minimap, tags, palettes, validation — works unchanged)
and add optional massing tiers that tier-aware renderers draw INSTEAD of the
envelope:

```ts
// src/data/types.ts (PM-owned) — proposal
export interface BuildingTier {
  /** Height of this tier's flat top above ground (m), (0, Building.h]. */
  h: number;
  /** Plan ring of this tier, local metres, ≥ 3 points, first not repeated.
   *  Tiers of one building do not overlap in plan; their union ≈ `poly`. */
  poly: Vec2[];
}
export interface Building {
  // …
  /**
   * PLATEAU LOD2 massing (wave 22): grounded prisms that replace the
   * `poly`×`h` envelope in renderers that support it. Absent = envelope.
   * `roof` is ignored when `tiers` is present.
   */
  tiers?: BuildingTier[];
}
```

Validation: each tier `h` finite in `[1, Building.h]`, poly as `poly`;
≤ 64 tiers (cap; `0_0` averages 3.2 tiers per decomposed building). Size ≈ Option A minus the
per-tier `id` (≈ −20 B/tier).

## Q5 — Merge with OSM

Keep from OSM: roads, bridges, water, rivers, trees, woods, places,
landmarks, **names**. Replace from PLATEAU: building footprints + heights
(+ roofs/tiers). Matching: footprint IoU (`matchFootprints`: sampled
intersection, 50 m bucket grid), measured:

| | `0_0` | `-4_-3` |
|---|---:|---:|
| PLATEAU buildings with an OSM partner at IoU ≥ 0.5 | 1 579 / 2 001 (78.9 %) | 3 757 / 4 828 (77.8 %) |
| … at IoU ≥ 0.7 | 63.2 % | 53.4 % |
| median best IoU | 0.76 | 0.72 |
| split / merged differently (IoU < 0.5 but ≥ 50 % covered by OSM) | 179 | 578 |
| PLATEAU buildings OSM does not cover (< 20 %) | 212 | 418 |
| OSM tile buildings matched | 1 572 / 1 963 (80.1 %) | 3 751 / 4 472 (83.9 %) |
| **OSM buildings PLATEAU does not cover (< 20 %)** | 83 | 130 |
| OSM names transferred | 338 of 366 named | 52 of 54 |
| total footprint area PLATEAU / OSM | 414 776 / 427 322 m² | 431 717 / 421 008 m² |

Rules proposed for the production converter:
1. PLATEAU buildings are the building set.
2. Name: the OSM name of the best partner at IoU ≥ 0.5; else — so that the
   curated landmark tables still resolve — any named OSM building whose
   footprint is ≥ 50 % covered by this PLATEAU building (largest overlap
   wins); else PLATEAU `gml:name`. Measure the landmark hits (Tokyo Tower,
   Skytree, the wave-11 presets) in the ticket.
3. OSM buildings covered < 20 % by PLATEAU are kept as they are (station
   canopies, new builds, footbridges — 83 / 130 per tile, ≈ 3–4 %).
4. OSM `building:part` entries (510 in Tokyo, mostly towers such as Tokyo
   Tower / Skytree) are kept and SUPPRESS the PLATEAU building they overlap
   (PLATEAU has no part massing; OSM parts carry `minH`).

## Q6 — Size / performance

Today: `public/data/tokyo/` = **28.3 MB** (index 2.70 MB + 129 tiles
25.6 MB; buildings JSON 20.4 MB = 170 619 × 119 B).

Measured bytes per converted PLATEAU building: 120 B (`0_0`, 5.6 vertices)
and 147 B (`-4_-3`, 6.2 vertices — LOD1 footprints are more detailed than
OSM's 4.6).

| variant | buildings JSON | whole dataset |
|---|---:|---:|
| today (OSM) | 20.4 MB | 28.3 MB |
| PLATEAU LOD1 envelopes + simple roofs (≈ 195 k × ≈ 135 B, + kept OSM) | ≈ 27 MB | **≈ 35 MB** |
| + LOD2 tiers (Option A/B; `0_0` measured +145 B per LOD2 building × ≈ 73 k) | ≈ 37 MB | **≈ 45 MB** (upper bound — `0_0` is the densest LOD2 cell) |

All inside the 60 MB budget. Largest tile grows from 647 KB to ≈ 0.8–1 MB
(`-4_-3`: 568 KB → ≈ 765 KB). A 0.3 m Douglas–Peucker on LOD1 footprints
would claw back part of the vertex overhead (not measured). Recommendation:
ship LOD1 envelopes + simple roofs first; add tiers once the schema decision
is made and the renderers draw them.

## Recommendation and wave-22 ticket split

Go: PLATEAU buildings (FY2025 CityGML via the catalog API) replace OSM
buildings for Tokyo; OSM keeps everything else. Proposed tickets:

| # | ticket | size | deps |
|---|---|---|---|
| 1 | `scripts/plateau/` production converter: all 99 meshes, LOD1 envelope + simple roofs + ids, dedupe, OSM merge rules 1–4, tiling via `tileCity`, `npm run fetch-data:tokyo-plateau`; README/credits attribution; data-format.md "Tokyo from PLATEAU" section (PM) | C3 | — |
| 2 | Regenerate `public/data/tokyo/` with it; report sizes, landmark/preset hits, spawn sanity | C2 | 1 |
| 3 | e2e / preset check that Tokyo still boots, Skytree / Tokyo Tower / Midtown Yaesu (235 m) heights | C2 | 2 |
| 4 | Schema: `Building.tiers` (types.ts + validate.ts + data-format.md) — PM | PM | — |
| 5 | Converter emits `tiers` for stepped/complex LOD2 buildings (`lod2Tiers` → field) | C2 | 1, 4 |
| 6 | Renderers draw `tiers` (buildings.ts walls/caps per tier, shared colour; cyberpunk facades/detail/neon on exterior tier walls only) | C3 | 4 |
| 7 | (optional) Texture mean colours: DC-only baseline JPEG decoder (zero deps) → `osmColor` / `roofColor` for LOD2 buildings | C3 | 1 |
| 8 | (optional) Footprint simplification (Douglas–Peucker 0.3 m) with a before/after size report | C2 | 1 |

## Checked assumptions (PM's list)

- "LOD1 footprint + `measuredHeight` for all 23 wards" — **confirmed**
  (FY2025 per ward; 97–98 % of buildings have `measuredHeight`, the rest
  fall back to LOD1 top − base).
- "LOD2 roofs for central districts, some textured" — **confirmed and
  larger than expected**: 35 % of buildings in our bbox are LOD2; in the
  LOD2 area every building we saw is textured.
- "Derived 3D Tiles / MVT / other formats" — **partly**: FY2025 buildings
  are 3D Tiles only (no building MVT/GeoJSON); FBX/OBJ are discontinued.
- "Licence = PLATEAU site policy, compatible with CC BY 4.0" — **confirmed**
  (PDL 1.0; copyright with the local governments for the open data).
- The FY2020 single `13100` dataset the ticket context implies is
  superseded — use the FY2025 per-ward datasets.

## Not verified

- Visual quality of converted roofs / tiers (no image viewing here — PM GPU
  review of `.cache/plateau/out/0_0*.json` loaded as a tile).
- Meshes other than the 8 downloaded: whole-bbox numbers are catalog counts
  weighted by area, not parsed geometry.
- Whether any mesh in the bbox contains `BuildingPart`s (none in 14 583
  parsed buildings; the parser handles them, the mapper would need a rule).
- The JPEGs' encoding (baseline vs progressive) — matters for ticket 7.
