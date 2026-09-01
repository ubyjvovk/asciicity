# City data format (`public/data/city.json`)

PM-owned design doc. The TypeScript shape is `src/data/types.ts` (authoritative
for field names and types); this file explains semantics, the OSM → JSON
conversion rules, and the fetch script. Producers: `scripts/fetch-osm.mjs`
(real data) and `src/data/synthetic.ts` (deterministic test city). Consumer:
`src/data/validate.ts` + every `src/world/*` builder.

## Coordinate system

- `origin` is a WGS84 point; every `x`/`z` in the file is metres relative to it.
- `x` = east (+) / west (−); `z` = **south (+) / north (−)** — so three.js's
  default "camera looks down −z" means "looks north". `y` (up) never appears
  in the file: the ground is `y = 0`, buildings extrude to `y = h`.
- Projection (equirectangular, fine for a 3 km box):
  `x = (lon − origin.lon) · cos(origin.lat°) · 111320`,
  `z = −(lat − origin.lat) · 110574`. Implemented once in `src/geo.ts`
  (`project`/`unproject`); the fetch script re-implements the same two
  formulas in JS (it cannot import TS).
- Numbers are rounded to 0.1 m (`Math.round(v * 10) / 10`) to keep the file
  small. The fetch output is minified JSON (no pretty print).

## Datasets (one tiled directory per city — wave 11, T-0095/96)

Every shipped city is TILED since wave 11: `public/data/<id>/index.json` +
`tiles/<i>_<j>.json` (see "Tiled datasets" below). The monolithic
`city.json`/`kyiv.json`/`sf.json`/`nyc.json` files are gone; the
monolithic schema survives as the tiler's input (a fetch without `--tiles`)
and the `?synthetic=1`/unit-test path.

| id (`?city=`) | origin | terrain | tiles | index.json B | dir total B |
|---|---|---|---|---|---|
| `london` | Bank junction | none (flat) | 22 | 256 785 | 3 434 093 |
| `kyiv` | Maidan Nezalezhnosti `50.4501, 30.5234` | SRTM 1″, step 20 m | 57 | 634 133 | 3 605 753 |
| `sf` | Union Square `-122.4075, 37.788` | SRTM 1″, step 20 m | 69 | 1 273 711 | 14 968 348 |
| `nyc` | Union Square `-73.9905, 40.7359` | SRTM 1″, step 20 m | 77 | 920 302 | 10 430 168 |
| `tokyo` | Tokyo Station `139.7671, 35.6812` | SRTM 1″, step 20 m | 99 | 1 979 748 | 18 629 801 |

Migration counts (tiler input → tiles, T-0096): london 9 061 buildings /
8 115 roads (381 bridge roads global) / 2 413 landmarks; kyiv 8 183 /
6 746 (87) / 936; nyc 41 140 / 10 482 (586) / 2 681; sf (T-0095) 44 181 /
11 267 (343) / 2 161. Zero `bridge: true` roads inside any tile file.
The registry the app uses is `src/data/cities.ts` (architecture.md
§4.10/§4.19); each entry's `sizeBytes` is the exact committed index size.

### Central Kyiv (`kyiv.json`, wave 5)

- **bbox**: `30.495, 50.422, 30.585, 50.470` — Golden Gate / Sophia / Podil
  (Kontraktova Square) in the west and north, Pechersk Lavra and the
  Motherland Monument in the south, Trukhaniv Island and the Hydropark strip
  of the left bank in the east. ≈ 6.4 km × 5.3 km.
- **origin**: Maidan Nezalezhnosti, `lat 50.4501, lon 30.5234` (DEM ≈ 156 m
  ASL; the Dnipro is ≈ 94 m, Pechersk/Sophia hills ≈ 190–200 m).
- Names: fetched with `--lang en` so `name:en` wins over the Cyrillic `name`
  when present (buildings, roads, places alike).
- Command: `node scripts/fetch-osm.mjs --bbox 30.495,50.422,30.585,50.470 --origin 30.5234,50.4501 --lang en --dem 1 --tiles --out public/data/kyiv`
  (`npm run fetch-data:kyiv`; tiled since wave 11).

### San Francisco (`sf.json`, wave 8)

`npm run fetch-data:sf` — bbox `-122.487,37.764,-122.383,37.835`
(Golden Gate Bridge to the Embarcadero, Marina/Russian Hill/Nob Hill/
downtown, Alamo Square, Alcatraz; Twin Peaks and the Bay Bridge east half
are out), origin Union Square `-122.4075,37.788`, `--lang en --dem 1`
(tile `N37W123`; Bay ≈ 0 m, Nob Hill ≈ 100 m). The Bay/Pacific come from
the coastline rules above; Alcatraz is an island ring (visible, not
walkable). **Size budget 15 MB** (raised from 12 at T-0076: the bbox is
2.5–6× London/Kyiv by area and holds 44 k footprints; coordinates are
already 0.1 m and footprints < 20 m² are 1 % of the file — the size is
fidelity, not waste). Counts/size (fetched 2026-08-28, T-0076): 44 181
buildings / 10 935 roads / 92 places / 45 water rings (43 `natural=water`
polygons + the Bay and the Pacific from the coastline closure, Alcatraz an
island ring) / 1 river / 34 466 trees (28 582 filled), terrain 461×396 @
20 m (0 voids, datum 23.6 m), 14 638 126 bytes (13.96 MB). Stitch summary
on the real data: 46 pieces → 5 closed + 3 open chains → 2 water rings.

### Manhattan (`nyc.json`, wave 10)

`npm run fetch-data:nyc` — bbox `-74.025,40.698,-73.958,40.775` (Battery
Park to 59th Street: all of Downtown and Midtown, the Brooklyn, Manhattan and
Williamsburg bridges, DUMBO / Brooklyn Heights and a sliver of Long Island
City on the far banks; Central Park's south end), origin Union Square
`-73.9905,40.7359`, `--lang en --dem 1` (tiles `N40W074` + `N40W075` — the
DEM loader mosaics every tile the bbox touches; the island is 0–25 m ASL).
The Hudson and East rivers are `natural=coastline` (88 ways in the bbox)
and close through the coastline rules; Governors Island is an island ring.
Overpass counts at boarding: 52 126 `building` ways (33 025 with `height`),
15 494 `building:part` ways (the setback geometry of the towers — see
"Building parts" below), 8 `natural=water` relations. **Size budget 22 MB**
(it is the densest bbox so far; the loading indicator of §4.18 covers the
download). Counts/size (re-fetched 2026-08-29, T-0089 — below-grade rule
3b): 41 140 buildings (≈ 3 160 of them `building:part` entries with `minH`;
11 k outlines were replaced by their parts; 20 relations skipped incl. the
underground station outlines) / 10 482 roads (586 bridge roads) / 187
places / 97 water rings / 2 rivers / 27 424 trees (8 961 filled), terrain
287×430 @ 20 m (0 voids, tiles N40W074 + N40W075), max h 541 (One WTC
spire), 10 102 343 bytes (9.63 MB).

## Tiled datasets (wave 11 — sector streaming)

Central Tokyo holds 112 k building ways (counted 2026-08-30) — 2.7× the
Manhattan dataset, an estimated 30–50 MB of JSON. Past that scale a city
ships **tiled**: a directory `public/data/<city>/` holding

- `index.json` — everything global: `origin`, `bbox`, `tileSize`,
  `terrain`, `water` + `waterLevels`, `rivers`, `bridgeRoads`, `landmarks`,
  `places`, and a `tiles` directory of per-tile stats;
- `tiles/<i>_<j>.json` — one file per non-empty tile: `buildings`, `roads`,
  `trees`, `woods`, element schemas identical to the monolithic ones.

TypeScript shapes: `TileIndexData` / `TileData` / `TileStat` /
`LandmarkEntry` in `src/data/types.ts` (PM-owned). Runtime behaviour
(TileManager, load radii, HUD/bus rebuilds): architecture.md §4.19.

**Tile grid.** `tileSize` is 1000 m for shipped datasets. Tile `(i, j)`
covers `x ∈ [i·S, (i+1)·S)`, `z ∈ [j·S, (j+1)·S)` in local metres; `i =
floor(x/S)`, `j = floor(z/S)`; negative indices are allowed and keep their
minus sign in the key (`"-3_2"`). Empty tiles are neither written nor
listed.

**The tiler** is a pure function `tileCity(city, tileSize)` in
`scripts/tile-city.mjs` (zero deps, unit-tested), with two entry points:
`node scripts/tile-city.mjs <city.json> <outdir>` retiles an existing
monolithic file (the migration path — deterministic, no Overpass), and
`fetch-osm.mjs --tiles` tiles at fetch time (`--out` then names the city
DIRECTORY). Same input → byte-identical output. Rules:

1. **Exclusive assignment by anchor** — every element lands in exactly one
   tile; the union of all tiles equals the monolithic arrays (input order
   preserved within a tile). Anchors: building → arithmetic mean of its
   `poly` vertices (computed on the unrounded ring); tree → its `(x, z)`;
   `woods` ring → vertex mean. No margins, no duplication: the runtime's
   2 km load radius (§4.19) exceeds fog visibility, so edge pop-in is not
   reachable on foot.
2. **Roads split at tile boundaries** — except bridges (rule 3). Each
   polyline is clipped geometrically against every tile rect it crosses
   (a segment may cross a tile that contains none of its vertices); the
   crossing point is computed once and appended to BOTH pieces, so the
   pieces' endpoints coincide exactly and the road graph reconnects when
   both tiles are loaded — independent of vertex order or travel
   direction. Pieces keep the original `id`, `name`, `cls`; consumers must
   not assume road ids are unique across tiles or even within one tile (a
   road can leave and re-enter it around a corner). Degenerate pieces (a
   single point) are dropped.
3. **Bridge roads are global.** Every road whose `bridge` is truthy goes to
   `index.bridgeRoads` verbatim — whole polylines, never split. Bridge
   chaining (§4.9), `BridgeDecks` and `groundAt` need whole chains; a
   boundary-split bridge would resurrect the wave-9 per-piece deck-lerp
   bug.
4. **`landmarks`** — for every building with a `name` (as present in the
   input `CityData`), append `{ name, x, z }` using the same centroid
   anchor. Order = tile scan order (`j` ascending, then `i`, then input
   order); consumers take the first entry per name.
5. **`places` are global** (they are small — 187 in Manhattan — and zone
   naming/spawn need them at boot). Tiles carry no places.
6. **`tiles[key].bytes`** = the byte length of the tile file as written —
   the loading bar's denominator. `buildings`/`roads`/`trees` are element
   counts.
7. **Validation**: the tiler validates its INPUT with `validateCity` (the
   monolithic rules below, road-id uniqueness included); `validate.ts`
   gains `validateTileIndex(raw): TileIndexData` (shape, finiteness, tile
   keys matching `/-?\d+_-?\d+/`, `tileSize > 0`). Tile FILES get a light
   shape check at load time only (`v === 1`, arrays present) — they are
   machine-generated from already-validated input, and fully re-validating
   25 tiles on the main thread would stall the frame loop. The monolithic
   road-id uniqueness rule does not apply inside tile files (rule 2).

**Chunked fetch (`--chunks NxM`)** — for bboxes too large for one Overpass
query, `fetch-osm.mjs --chunks NxM` splits the bbox into an N×M grid of
sub-bboxes fetched sequentially (5 s pause between requests, same
endpoint fallback as today) and concatenates the responses, deduplicating
elements by `type` + `id` before conversion (an element on a seam is
returned by both chunks). Summary-line counts are post-dedupe. Chunking
changes fetching only — conversion sees one merged element list.

**Height clamp raised to [3, 650]** (was 600) — converter, validator and
`types.ts` alike. Tokyo Skytree is 634 m; no existing dataset has a
building over 600, so London/Kyiv/SF/NYC stay byte-identical.

### Central Tokyo (`data/tokyo/`, wave 11; bbox v2 wave 12) — the first streamed-only city

- **bbox v2 (wave 12, T-0102)**: `139.692, 35.645, 139.820, 35.715` —
  ≈ 11.6 km × 7.8 km: the v1 box plus the WEST strip covering Shibuya
  (the Scramble Crossing, ≈ `139.7016, 35.6595`) and Shinjuku (station
  ≈ `139.7005, 35.690`; Kabukicho). West-strip Overpass counts at
  boarding (2026-08-31): 57 539 buildings, 17 230 highways → v2 total
  ≈ 170 k buildings expected. Origin, tile grid and every existing local
  coordinate are UNCHANGED (the origin stays Tokyo Station), so v1 tiles
  keep their keys and the wave-11 presets stay valid; new tiles appear at
  `i ≤ −6`-ish west. Fetch with `--chunks 4x3`.
- **bbox v1 (wave 11)**: `139.730, 35.645, 139.820, 35.715` — ≈ 8.1 km ×
  7.8 km: Imperial Palace, Tokyo Station, Ginza, Akihabara, Tokyo Tower
  (verified in OSM at ≈ `139.747, 35.658`) and Tokyo Skytree (≈ `139.808,
  35.710`), plus the Sumida riverfront between them.
- **origin**: Tokyo Station, `lon 139.7671, lat 35.6812` — verify against
  the fetched `railway=station` node and correct if > 100 m off.
- Overpass counts at boarding (2026-08-30): **112 184 `building` ways**,
  510 `building:part` ways, 46 594 highway ways.
- Names: `--lang en` (same rule as Kyiv — `name:en` wins, else Japanese;
  never transliterate).
- Terrain: `--dem 1`, single SRTM tile `N35E139`; the bay/rivers come from
  the coastline + water rules above.
- Command (v2): `node scripts/fetch-osm.mjs --bbox 139.692,35.645,139.820,35.715
  --origin 139.7671,35.6812 --lang en --dem 1 --chunks 4x3 --tiles 1 --out
  public/data/tokyo` (`npm run fetch-data:tokyo`). (Bare `--tiles` also
  works since T-0100; the aliases keep the value form.)
- **Size budget: 60 MB** for `index.json` + all tiles combined. Shipped
  (fetched 2026-08-31, T-0097): **112 743 buildings** (max h 634 = Tokyo
  Skytree, clamp 650) / 16 902 roads (1 712 bridge roads global — Sumida
  crossings) / 847 places / 214 water rings / 111 rivers / 25 426 trees
  (19 004 filled) / 11 528 landmarks (incl. exact `name:en` "Tokyo
  Skytree", "Tokyo Tower"), terrain 411×391 @ 20 m (datum 9.5 m ASL, 0
  voids, tile N35E139), **99 tiles**, index 1 979 748 B + tiles
  16 650 053 B ≈ 17.8 MB (largest tile 646 790 B), zero bridge leaks into
  tiles; origin confirmed 33 m from OSM's Tokyo Station node.

### Sydney (`data/sydney/`, wave 14) — the first southern-hemisphere city

- **bbox**: `151.183, -33.895, 151.245, -33.833` ≈ 5.7 km × 6.9 km: the
  CBD, Circular Quay, the Opera House, the Harbour Bridge, The Rocks,
  Darling Harbour, Barangaroo (Crown Sydney 271 m), the Royal Botanic
  Garden, Mrs Macquarie's Point, Woolloomooloo, Kings Cross, Central
  Station, and across the water Luna Park, Kirribilli and the North Sydney
  CBD. Fort Denison and Goat Island are coastline islands (odd-parity
  land, wave 9 rules).
- **origin**: Circular Quay, `lon 151.2110, lat -33.8613` — verify within
  100 m of the OSM Circular Quay railway station / ferry wharf and correct
  if further.
- Overpass counts at boarding (2026-08-31): **19 815 `building` ways**,
  934 `building:part` ways (Sydney Tower is a part, `height=270`),
  27 485 highway ways.
- **Southern hemisphere**: the DEM tile is **`S34E151`** — the first
  `S`-prefixed tile this project fetches. `hgtTileName`, `fetchDemTiles`'s
  tile loop and `elevationAt`'s row math were sign-verified against the
  live skadi mirror by a PM probe (2026-08-31: Observatory Hill 24.5 m,
  North Sydney ridge 78.4 m, Mrs Macquarie's Point 4.8 m, 0 voids). No
  code change is expected; a dataset transect must confirm it end-to-end.
- **`--dem-bare 1` is required** (step 3b): the raw tile reads ~79 m at
  the Sydney Tower block (real street ≈ 20–30 m) — CBD roofs contaminate
  the surface model exactly as in Tokyo.
- Water: the harbour, Darling Harbour and the Parramatta River arm are
  `natural=coastline` ways → the wave-8 clip → stitch → clockwise-closure
  rules; expect several independent chains (south shore, north shore) plus
  island rings.
- Names: `--lang en`.
- Command: `node scripts/fetch-osm.mjs --bbox 151.183,-33.895,151.245,-33.833
  --origin 151.2110,-33.8613 --lang en --dem 1 --dem-bare 1 --chunks 2x2
  --tiles 1 --out public/data/sydney` (`npm run fetch-data:sydney`).
- **Size budget: 12 MB** for `index.json` + all tiles combined (counts are
  ~half of SF's building total; blocked question if over).
- Shipped counts (refetched 2026-09-01, T-0116 — multi-way building
  relations assembled; water path now runs the composite DEM contour, see
  "Water relations" below): **20 322 buildings** (incl. the Sydney Opera
  House as its own relation footprint, id 9596872, h 18.5 from
  `building:levels=5`, ~180 m long — its `building:part=roof` sheets are
  skipped as parts so the real outline survives; max h 309 = Westfield Sydney)
  / 9 818 roads (804 bridge roads global — the Harbour Bridge deck,
  Brisbane/Waterloo overpasses) / 106 places / **138 water rings** (one
  DEM-contoured harbour ring 9.45 km² + inner-member island rings incl. Fort
  Denison / Goat Island / Garden Island + smaller ponds and inlets) /
  1 river / 29 131 trees (17 501 filled) / 2 278 landmarks, terrain
  291×347 @ 20 m (datum 3.9 m ASL, 0 voids, tile S34E151, bare-earth),
  **57 tiles**, index 1 203 530 B + tiles 5 883 773 B ≈ 6.8 MB, zero bridge
  leaks into tiles; Circular Quay origin confirmed ≈ 27 m from the OSM
  Circular Quay place node (railway/ferry wharf, within the 100 m check).
  Fetched with `--water-full 1 --water-dem 1` (see "Water relations" §4);
  the sydney alias will flip to those flags at accept.

## Building parts (`building:part`, wave 10 — Manhattan)

Tall buildings are mapped as an outline (`building=*`) plus `building:part`
ways carrying the real 3D massing (`height` / `min_height`, or
`building:levels` / `building:min_level`). Without them the Empire State
Building is one flat 380 m slab. Rules:

1. **Fetch**: the Overpass query also asks for `way["building:part"]` (and
   `relation["building:part"]["type"="multipolygon"]`) in the bbox.
2. **Convert**: a part becomes a `buildings[]` entry with `h` from `height`
   (ft honoured) else `building:levels × 3.3 + 2`, and `minH` from
   `min_height` else `building:min_level × 3.3` (absent → 0; `minH` is
   omitted when 0 and must satisfy `0 <= minH < h − 1`).
3. **Outline replacement**: an outline that CONTAINS the centroid of at least
   one part is dropped — the parts represent it. A part BELONGS to the
   SMALLEST (by area) outline containing its centroid (T-0089: a large
   station/complex outline must not claim the parts of a tower that has its
   own outline). An outline's `name` (and only its name) is transferred to
   the tallest part that belongs to it and has no `name` of its own; an
   outline whose parts all belong to smaller outlines is simply dropped (its
   named building, if any, exists as a separate way). This keeps landmark
   fixes, presets and floating tags resolving by OSM name without
   mislabelling neighbours (Grand Central Terminal's name landed on One
   Vanderbilt's 423 m part in the first Manhattan fetch). Outlines with no
   parts are unchanged. Parts whose centroid lies in no outline are kept as
   ordinary buildings.
3b. **Below-grade structures are not buildings** (T-0089): an outline or
   part tagged `layer` < 0, `location=underground` or `underground=yes`
   (subway-station footprints, the underground Grand Central platform
   relation) is skipped entirely — not emitted, and never a part-holder.
   In the first Manhattan fetch the underground terminal relation was the
   only outline containing an unrelated 209 m tower and would have named
   it "Grand Central Terminal".
4. **Heights**: the clamp is now `[3, 650]` (converter and validator; One
   WTC's roof is 417 m, its spire 541 m). `minH` is validated as a finite
   number in `[0, h − 1)`.
5. **Consumers**: walls run from `minH` to `h` and a bottom cap is emitted
   when `minH > 0` (§4.4); the collision grid ignores footprints with
   `minH >= 2.5` (§4.6); tags use `roofY = ground + h` unchanged; the
   minimap ignores `minH`.
6. London / Kyiv / SF files are NOT re-fetched by this rule (no `minH` in
   them → byte-identical behaviour). A later `fetch-data:sf` picks up SF's
   parts automatically.

## The real dataset: City of London to Westminster

- **bbox** (minLon, minLat, maxLon, maxLat): `-0.130, 51.497, -0.070, 51.521`
  — Westminster (Parliament/Trafalgar Square) to Aldgate, Camden-town-ish
  north edge to the Thames (Westminster Bridge to Tower Bridge included).
  The player can now walk from Big Ben west of Bank to the City in one world.
- **origin**: Bank junction, `lat 51.5133, lon -0.0887` (unchanged — every
  existing local coordinate, preset and test stays valid). The player spawns
  at `(0, 0)`.
- Size budget: the minified file must stay **under 10 MB**.

## Schema (v: 1)

```jsonc
{
  "v": 1,
  "origin": { "lat": 51.5133, "lon": -0.0887 },
  "bbox": [-0.13, 51.497, -0.07, 51.521],
  "buildings": [ { "id": 4521, "h": 24.5, "name": "Royal Exchange", "poly": [[x,z],[x,z],[x,z]] } ],   // + optional "minH" (building parts, wave 10)
  "roads":     [ { "id": 77,  "name": "Cheapside", "cls": "primary", "pts": [[x,z],[x,z]], "bridge": true } ],   // bridge optional (T-0030)
  "places":    [ { "name": "Bank", "x": 3.2, "z": -1.0 } ],
  "water":     [ [[x,z],[x,z],[x,z]] ],         // optional, rings (T-0023)
  "rivers":    [ [[x,z],[x,z]] ],               // optional, centre-line polylines (T-0036)
  "terrain":   { "x0": -3260, "z0": -2740, "step": 20, "cols": 323, "rows": 268,
                 "datum": 156, "heights": [ -62.1, -61.8, ... ] },   // optional, wave 5
  "waterLevels": [ -62.0 ]                      // optional, one per water ring, wave 5
}
```

Rules every producer must follow and `validateCity` must enforce:

- `buildings[].poly`: ≥ 3 points, first point not repeated last, no NaN.
  Degenerate rings (|area| < 1 m²) are dropped by producers.
- `buildings[].h`: finite, clamped to `[3, 650]`.
- `roads[].pts`: ≥ 2 points. `cls` ∈ `RoadClass`.
- `places[]`: finite `x`/`z`, non-empty `name`.
- `id` unique within each array.
- `water` (optional): array of rings obeying the `poly` rules; may be absent or empty.
- `rivers` (optional): array of polylines (≥ 2 finite points each); may be absent or empty.
- `trees` (optional): array of `[x, z, h, r]` with finite numbers, `3 ≤ h ≤ 40`,
  `1 ≤ r ≤ 15` (error paths `trees`, `trees[i]`). May be absent or empty.
- `woods` (optional): rings obeying the `poly` rules (error path `woods[i]`).
- `terrain` (optional): `x0`, `z0`, `datum` finite; `step > 0`; `cols ≥ 2`,
  `rows ≥ 2` integers; `heights` is an array of exactly `cols * rows` finite
  numbers (row-major, row 0 = north edge). Metres relative to `datum`,
  rounded to 0.1 m. Absent ⇒ flat world.
- `waterLevels` (optional): finite numbers, **same length as `water`**
  (error path `waterLevels` when the lengths differ, `waterLevels[i]` for a
  bad entry). Metres relative to `terrain.datum`. Absent ⇒ every ring at 0.

## OSM → JSON conversion rules (`scripts/osm-convert.mjs`)

Overpass QL (single request, `[out:json][timeout:180]`, `out geom;` so every
element carries its own coordinates):

```
[out:json][timeout:180];
(
  way["building"](51.497,-0.130,51.521,-0.070);
  relation["building"]["type"="multipolygon"](51.497,-0.130,51.521,-0.070);
  way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|cycleway|primary_link|secondary_link|trunk_link)$"](51.497,-0.130,51.521,-0.070);
  node["place"](51.497,-0.130,51.521,-0.070);
  node["railway"="station"](51.497,-0.130,51.521,-0.070);
  node["tourism"="attraction"]["name"](51.497,-0.130,51.521,-0.070);
);
out geom;
```

Endpoint: `https://overpass-api.de/api/interpreter` (POST, body `data=<query>`),
fallback `https://overpass.kumi.systems/api/interpreter`. Retry each once on
429/504 after 30 s.

**Buildings**

- `way` with `building` tag and a closed geometry (first == last node) → one
  building; drop the repeated closing point. Skip `building=no` and
  `building:part` ways.
- `relation` multipolygon: assemble the `role=outer` members into closed
  rings exactly like the water/woods paths (rings end-to-start on
  coinciding endpoints, either orientation, order-independent). A member
  that is itself a closed way becomes a ring directly; several open ways
  are stitched (T-0116 — the Sydney Opera House's outer boundary is 16
  separate ways). Each assembled ring becomes one building; the first ring
  keeps the relation id, later rings get `id*1000+1`, `+2`, … so ids stay
  unique. An open (unstitchable) outer boundary stays skipped and counted;
  a partial ring is never emitted. Tags (name, height, …) come from the
  relation. Inner rings (courtyards) are ignored. `building:part=roof`
  sheets are skipped as parts (a horizontal roof is not volumetric massing)
  so they cannot replace the authoritative multipolygon outline.
- Height, first rule that applies:
  1. `height` tag: parse leading number; if the string ends in `ft` multiply
     by 0.3048.
  2. `building:levels` (number `L`): `h = L * 3.3 + 2` (+ `roof:levels * 3`
     when present).
  3. default by `building` value: `cathedral|church` 30, `office|commercial`
     20, `apartments|residential` 15, `retail` 10, anything else 14.
  Clamp to `[3, 650]`.
- `name` copied when present (trimmed).

**Roads** — `highway` mapping to `cls` (wave 9: `motorway`/`motorway_link`
added — the Golden Gate Bridge roadway is `highway=motorway` and was dropped,
leaving only the two sidewalks; the Overpass regex in `scripts/fetch-osm.mjs`
carries the same two values. London/Kyiv were NOT re-fetched: their bboxes
hold no motorways, so their committed files are unchanged):

| OSM `highway`                                     | `cls`         |
|---------------------------------------------------|---------------|
| motorway, motorway_link, trunk, trunk_link, primary, primary_link | `primary` |
| secondary, secondary_link                          | `secondary`   |
| tertiary, unclassified                             | `tertiary`    |
| residential, living_street                         | `residential` |
| service                                            | `service`     |
| pedestrian                                         | `pedestrian`  |
| footway, cycleway                                  | **dropped** (→ `null`; never emitted) — except a footway/cycleway with a `bridge` tag ≠ `no`, emitted as `pedestrian` + `bridge: true` (wave 5: Kyiv's Parkovyi and Klitschko bridges are `highway=cycleway` + `bridge=yes`) |

`name` copied when present. Ways with < 2 distinct points are dropped.
`bridge: true` is emitted when the way has a `bridge` tag whose value is not `no` (bridges are walkable corridors over water; T-0030).

**Places** — every node from the `place`, `railway=station`, and
`tourism=attraction` selectors with a non-empty `name`. Deduplicate by
name (keep the first).

**Names and `--lang`** — by default the display name of a building, road or
place is the OSM `name` tag. With `--lang <code>` the converter prefers
`name:<code>` and falls back to `name` (both trimmed). London is fetched
without `--lang`; Kyiv with `--lang en`.

## Coastline water (`scripts/osm-convert.mjs`, wave 8 — San Francisco)

Rivers and docks arrive as closed `natural=water` polygons, but seas and
bays are mapped as `natural=coastline` WAYS with no polygon at all. OSM
convention: walking a coastline way in its direction, LAND is on the LEFT,
WATER on the RIGHT. The converter turns the coastline crossing the bbox
into ordinary `water` rings so everything downstream (water mesh,
collision, flattening, minimap) is unchanged:

1. **Fetch**: the Overpass query gains a `way["natural"="coastline"]`
   clause (same bbox, `out geom`).
2. **Clip** each coastline way's polyline to the bbox segment-by-segment
   (reuse the existing clipping helpers where possible); keep the pieces
   in way order.
3. **Stitch** pieces end-to-start on coinciding coordinates (the same
   tolerance `assembleRings` uses), **independent of array order**: a
   piece may attach AFTER a chain (chain end = piece start) or BEFORE it
   (piece end = chain start); repeat until no two chains share an
   endpoint. Never reverse a piece — way direction carries the land/water
   side. (Wave-8 field bug: the SF Embarcadero and Marina ways meet at an
   interior node; append-only stitching orphaned the upstream piece and
   `closeCoastline` threw "not on the bbox perimeter".) Results: open
   chains whose two endpoints both lie on the bbox boundary, plus
   fully-closed rings.
4. **Boundary closure**: treat lon as x (east+) and lat as y (north+).
   From an open chain's END point, walk the bbox perimeter CLOCKWISE
   (down the east edge, west along the south edge, up the west edge, east
   along the north edge), inserting bbox corners as passed, until the
   START point of an open chain is reached (the same chain or another —
   several chains may close into one ring); follow that chain and repeat
   until the walk returns to the first chain's start. Each closed walk is
   one water ring; consume every open chain exactly once. This clockwise
   closure is what keeps water (right of the way direction) inside the
   ring. No coastline intersecting the bbox → nothing emitted (an all-sea
   bbox is not supported).
5. **Islands**: a fully-closed ring (step 3) encloses land — with land on
   the left the traversal is counterclockwise; warn (do not fail) if the
   signed area says otherwise. Emit island rings as `water` rings too:
   consumers distinguish them by parity (next rule). Islands inside
   islands are out of scope.
6. **Flattening parity** (amends Terrain step 4): a grid node is flattened
   only when it lies inside an ODD number of water rings; its level comes
   from the last odd-making ring in array order. Existing datasets have no
   nested rings, so London/Kyiv terrain output is byte-identical
   (regression fixture required).
7. **Runtime stays "inside any ring = water"** for collision: an island
   (Alcatraz) renders with its terrain and buildings but is not walkable —
   you cannot walk to an island anyway. Intentional; documented here.

Unit fixtures (`tests/coastline.test.ts`) pin the geometry: a single
west→east coast (water south) → one ring covering the southern band; a
strait (west→east coast at the top, east→west at the bottom) → one middle
band ring; a CCW closed square → island ring emitted, and a parity check
shows a point inside it is NOT flattened while a point between island and
outer ring is; a bbox with no coastline → no rings.

## Water relations: overlapping bodies + inner islands (`scripts/osm-convert.mjs`, T-0116)

Rivers, docks, harbours and bays arrive as `natural=water` /
`waterway=riverbank` multipolygon RELATIONS as well as standalone closed
ways. OSM often maps a single body as several **overlapping** relations
(Port Jackson ⊇ Sydney Harbour in the Sydney bbox) whose assembled outer
rings overlap. Under the odd-parity water rule (above, wave 8/9) two
overlapping outer rings count as LAND in their overlap — the player could
walk on the harbour — and an island inside both (count 2) reads as land only
by accident. The water-relation path therefore:

1. **Assemble outer rings per body**: the standalone `natural=water` ways
   form one group, each relation another, so every ring stays attributed to
   the body it came from. (Stitching itself is unchanged —
   `assembleRingsInternal`, the same helper the building-relation and woods
   paths use.)
2. **Dedup overlapping large bodies**: only outer rings with |area| ≥
   0.1 km² are candidates (small ponds skip the O(n²) work). Sort by |area|
   descending and walk down; for each candidate compute `coverage` = the
   fraction of 50 m-grid cell centres over the candidate's bbox that lie
   inside the candidate AND inside any already-KEPT ring. Drop the
   candidate iff `coverage ≥ 0.85`, else keep it. Deterministic, no polygon
   booleans. (Sydney: one harbour ring survives and the overlapping Sydney
   Harbour duplicate drops; the eastern shoreline behaviour is under review
   — see T-0116 block.) Do not tune the 0.85 / 50 m constants.
3. **Inner members become island rings**: a relation's `role=inner` members
   are assembled with the same stitcher and emitted as bare water rings
   (islands — no names/landmarks) so an island reads as land via odd parity
   (harbour(1) + island(1) = 2). Inners are emitted ONLY from relations at
   least one of whose outer rings was KEPT — a dropped duplicate contributes
   no islands, which kills most cross-relation island duplicates for free.
   An open (unstitchable) inner chain is skipped and counted, never emitted
   partially. Residual island duplicates are dropped when an inner ring's
   centroid lies inside an already-emitted island ring. Islands ride the
   existing wave-8/9 odd-parity conventions in collision and DEM flattening
   unchanged.
4. **`--water-full` (Answers 4, T-0116) — full-relation geometry, no bbox
   clip for relation rings.** Rationale: for a coastline-hugging harbour
   relation whose outer boundary closes in the open ocean OUTSIDE the query
   bbox (Port Jackson east of Sydney's Heads), bbox-clipping the outer
   introduces a spurious closure segment along the bbox edge and encloses
   the eastern peninsulas as "inside water" by parity. Under `--water-full`
   `scripts/fetch-osm.mjs` issues ONE follow-up Overpass request
   (`rel(id …); (._; way(r); >;); out geom;`) for the complete member
   geometry of every water/riverbank relation, splices that full geometry
   back over each relation's members, and passes `waterFull: true` to
   `convertOverpass`. The water path then assembles those relation rings
   from full geometry and skips `clipRingToBox` for them (steps 1–3 above
   are otherwise identical). Standalone `natural=water` /
   `waterway=riverbank` WAYS keep today's clipped path (a way is a whole
   OSM object within the bbox, not a partial member of a bigger polygon).
   Datasets fetched WITHOUT `--water-full` are byte-stable on refetch
   (London's Thames stays clipped). DEM tiles: `waterLevels` samples ring
   vertices, and full rings may carry vertices outside the query bbox —
   `fetchDemTiles` covers the query bbox and `dem.elevationAt` throws
   loudly if a water-vertex tile is not loaded (Sydney's harbour spans
   only S34E151, so no new tiles are needed there).
4. **`--water-dem` (Answers 5-6, T-0116) — composite DEM-contoured shoreline
   for sloppy giants.** OSM's harbour polygons can be label-grade: the Port
   Jackson outer boundary contains long straight segments that cut across
   peninsula bases, so even the full simple polygon encloses whole peninsulas
   (Overpass's own `is_in` confirms Mrs Macquarie's Point inside it). No OSM
   layer carves the shore out. `--water-dem 1` (fetch flag → `convertOverpass`
   `waterDem: true`) therefore re-derives the shoreline from the bare-earth
   terrain grid, which already carries most of the truth (peninsulas 5–20 m
   ASL, water ~0), combined with the pipeline's own built-up-area layers to
   rescue small harbour features the 20 m bare-earth filter has erased
   (Fort Denison, Bennelong Point, Garden Island). For each kept OUTER ring
   with |area| ≥ 1 km² (the giants — smaller rings are trusted accurate and
   pass through untouched) the mask is built as a **composite** of five
   ordered rules:
   1. **Base threshold** `bare-earth ≤ level + 3.0 m`, where `level` is the
      giant ring's 10th-percentile DEM value (Circular Quay cove reads
      ~2.0 m ASL after the T-0108/T-0109 smooth — the +3.0 m margin puts it
      in the water with real slack rather than a knife-edge).
   2. **3×3 majority vote** on the raw mask (as before).
   3. **Force-LAND override**: any node whose cell (node ± half a step) contains
      a BUILDING centroid or a NON-BRIDGE road vertex is forced to LAND after
      the majority vote so it cannot be eroded. This mechanically rescues
      Bennelong Point (the Opera House itself), Garden Island (naval buildings
      + roads), Mrs Macquarie's tip (Mrs Macquarie's Road), Woolloomooloo, and
      the Botanic paths, and makes the wharf strips walkable — the protection
      is generative, not just preservative.
   4. **Speck/puddle cleanup** (flip 4-connected LAND components ≤ 8 nodes with
      no protection to water; drop WATER components < 6 nodes).
   5. **Relation-inner island rescue**: an inner ring belonging to a kept giant
      is emitted iff its centroid reads WATER in the final mask (the contour
      missed it — Fort Denison's 3 030 m² OSM inner comes back with its exact
      geometry, parity giant(1) + island(1) = LAND). An inner already carved
      by a contour hole reads LAND in the mask and stays dropped (no double
      ring).

   Marching squares at node resolution extracts the shoreline + island holes
   (planar face-tracing with the angular-successor rule, so ambiguous saddle
   corners resolve deterministically and mask fractality never produces an
   unbounded ring); one Chaikin corner-cut pass follows. These rings REPLACE
   the giant ring and its previously emitted inner-island rings (the contour's
   own hole rings take over — no double-counting); each emitted ring's
   `waterLevels` entry is its source body's level. Everything downstream
   (flattening, collision parity, render, minimap) consumes rings exactly as
   today — zero `src/` changes. The mask rules and marching-squares tracer are
   pure and unit-tested with synthetic grids (threshold, majority vote, force-
   LAND override, speck/puddle flips, hole emission, saddle-heavy mask
   closure, elevated-island parity, inner rescue), no fetch. Sydney parity
   after the composite (assertions in `tests/sydney.test.ts`): the six PM
   WATER probes (mid-harbour, CQ cove, under-bridge, west-of-Goat, mid-Farm-
   Cove, mid-Woolloomooloo-Bay) and the nine LAND probes (CBD, Fort Denison,
   Goat Island, Mrs Macquarie's Point, Sydney Opera House / Bennelong Point,
   Woolloomooloo Finger Wharf, Garden Island naval yard, Kirribilli, Blues
   Point) all pass; the global non-bridge wet-road-vertex rate drops from
   ~195/53 555 (0.36 %, attempt-4 baseline) to 14/53 555 (0.026 %) — the
   remainder is the Sydney Harbour Tunnel (a genuine under-harbour tunnel,
   surface points must read water) and a handful of unnamed wharf-approach
   segments OSM maps as roads over water.

## Trees (`scripts/osm-convert.mjs`, wave 7)

Overpass union gains `node["natural"="tree"]`, `way["natural"="tree_row"]`,
`way["natural"="wood"]`, `way["landuse"="forest"]`, `way["leisure"="park"]`
and the `relation[...]` forms of the last three (outer members assembled and
clipped like water). Emitted as:

- `woods`: the assembled, bbox-clipped wood/forest/park rings (for the minimap).
- `trees`: one entry per `natural=tree` node; one every 8 m along each
  `tree_row`; plus a **seeded jittered-grid fill** of every wood/forest ring
  (one tree per 150 m²: grid step `√150 ≈ 12.2 m`, each point jittered
  ±0.45·step) and of every park ring (one per 400 m², step 20 m). Fill points
  inside any building footprint, within 6 m of any road centre-line, or
  inside any water ring are dropped (bucket buildings/roads into a 50 m grid
  first — the brute-force product is too slow). PRNG: `mulberry32(42)`
  (copy the function; scripts cannot import TS), consumed in ring order then
  grid order, so the output is byte-stable. Per tree: `h` from the node's
  `height` tag when present, else `6 + rand·8` (6–14 m); `r = 0.35·h`.
  Hard cap **40 000 trees per file**: above it, keep every k-th fill tree
  (`k = ceil(n / 40000)`), never drop mapped nodes; the summary line reports
  `T trees (F filled, D dropped)`.

## Terrain (`scripts/dem.mjs`, wave 5)

Elevation comes from the public AWS Terrain Tiles "skadi" mirror of SRTM
1-arc-second: `https://s3.amazonaws.com/elevation-tiles-prod/skadi/<NS><lat>/<NS><lat><EW><lon>.hgt.gz`
— e.g. `skadi/N50/N50E030.hgt.gz` covers lat 50–51, lon 30–31 (≈ 4.7 MB
gzipped; no key, no rate limit worth mentioning). Tile name rule: lat/lon of
the tile's **south-west** corner, `N`/`S` + 2 digits, `E`/`W` + 3 digits
(`Math.floor` of the coordinate, so London is `N51W001`).

HGT format: gunzip → big-endian `int16` samples, `side × side` square
(`side = sqrt(bytes / 2)` = 3601 for 1″), row 0 = the tile's **north** edge
(lat + 1), column 0 = the west edge; `-32768` = void. Sample `(lat, lon)`
→ `row = (tileLat + 1 − lat) · (side − 1)`, `col = (lon − tileLon) · (side − 1)`,
bilinear over the four surrounding samples; a void corner is replaced by the
mean of the non-void corners (all four void → 0; count voids in the summary).

The converter (`--dem 1`, default off) builds `terrain` as follows:

1. Project the four bbox corners; `minX/maxX/minZ/maxZ` over them.
2. `step = 20` (override `--step`); `x0 = floor(minX / step) · step − step`,
   `z0 = floor(minZ / step) · step − step`; `cols = ceil((maxX − x0) / step) + 2`,
   `rows = ceil((maxZ − z0) / step) + 2` (one cell of margin all round).
3. `datum = round1(dem(origin))`. For every node: `heights[r·cols + c] =
   round1(dem(unproject(x0 + c·step, z0 + r·step)) − datum)`.

3b. **Bare-earth filter (wave 13, `--dem-bare`, default off).** SRTM is a
   radar SURFACE model: in dense cities (Japan — the AWS mosaic uses
   bare-earth lidar only for the US) roofs contaminate street elevation,
   so Tokyo's flat Shibuya valley read as a ±10 m lumpy hill at ~2× its
   real height. With `--dem-bare` (boolean flag like `--tiles`), the
   ABSOLUTE height grid (datum not yet subtracted) is filtered between
   steps 3 and 4, in exactly this order:
   - **Erode**: `H1(n)` = the SECOND-SMALLEST value in the (up to) **9×9**
     node window centred on `n` (windows clip at grid borders; with < 2
     values use the minimum). Second-smallest, not min, so one anomalous
     low node cannot dig a crater; roofs (which bias HIGH) are floored.
     (Wave-13 T-0109: widened from 5×5 — dense Shibuya has NO bare-earth
     SRTM sample inside 100 m, so the 180 m window is needed to find the
     lowest available proxy. Even so, block-decked districts bottom out
     ~8–10 m above true ground — the filter buys FLATNESS, not absolute
     accuracy; only the HUD ALT row can tell.)
   - **Smooth**: `H2(n)` = the arithmetic mean of the (up to) 3×3 window
     of `H1` centred on `n`, applied TWICE (two sequential passes —
     T-0109; one pass left ≤ 5.6 m node-to-node steps at erode edges).
   - `datum` is then `round1(H2(origin node))` and per-node heights are
     `round1(H2 − datum)` — grid dims, step and rounding unchanged.
   Both passes are pure array→array functions over `(heights, cols,
   rows)` — deterministic, order-independent (each output node reads only
   the INPUT grid), unit-tested. Water levels (step 4) are computed AFTER
   filtering, from the filtered grid, so shorelines stay consistent.
   Genuine relief survives: any hill wider than the 100 m window keeps
   its height minus ≤ smoothing loss; single-node spikes vanish. Existing
   datasets are untouched (flag default off; only Tokyo refetches with
   it — wave-13 T-0107/T-0108).
4. **Water flattening**: for each (clipped) water ring `i`, sample the raw
   DEM (minus datum) at every ring vertex, sort ascending, take the 10th
   percentile (`sorted[floor(0.1 · (n − 1))]`) → `waterLevels[i]`
   (rounded 0.1). Then every grid node whose `(x, z)` is inside ring `i`
   (ray-casting point-in-polygon) gets `heights = waterLevels[i]` — so the
   river bed is a flat plane the water mesh sits 0.3 m above and nothing
   pokes through. Rings are processed in array order. Wave 8: a node is
   flattened only when inside an ODD number of rings (island parity — see
   "Coastline water" rule 6); with no nested rings this is the old rule.
5. Tiles are cached under `.cache/dem/` (gitignored); the fetch fails
   loudly (non-zero exit) when a needed tile cannot be downloaded — never a
   partial file.

Summary line with `--dem 1`: `<out>: N buildings, M roads, K places, W water, R rivers, terrain CxR @ S m (V voids), S KB (skipped …)`.

## Fetch script CLI (`scripts/fetch-osm.mjs`)

```
node scripts/fetch-osm.mjs [--bbox minLon,minLat,maxLon,maxLat] [--origin lon,lat] [--out public/data/city.json] [--lang en] [--dem 1] [--step 20]
```

Node ≥ 22, zero dependencies (global `fetch`). Defaults are the City of
London values above. Prints exactly one summary line on success:
`city.json: N buildings, M roads, K places, S KB (skipped R relations)`.
Non-zero exit and a one-line reason on failure; never writes a partial file.
`npm run fetch-data` is the alias (London); `npm run fetch-data:kyiv` runs
the Kyiv command from the table above.

## Synthetic city (`src/data/synthetic.ts`)

`syntheticCity(seed = 1, blocks = 12)` — a deterministic Manhattan grid used
by unit tests, the e2e smoke test (`?synthetic=1`), and as the runtime
fallback when `city.json` fails to load. Blocks are 60 m squares separated by
14 m streets, centred on the origin; every block holds one rectangular
building inset 4 m with height from a seeded PRNG (mulberry32) in `[8, 120]`;
every 5th building is named `Block <i>`.
`syntheticCity(seed, blocks, hills = true)` additionally emits a `terrain`
grid (step 20, covering the blocks plus one cell of margin, `datum` 0) with
`h(x, z) = 30 · exp(−((x − 200)² + (z + 150)²) / (2 · 220²)) + z / 200`
rounded to 0.1 — one 30 m hill north-east of the origin on a gentle
north-up tilt — so hills can be exercised without real data
(`?synthetic=1&hills=1`). Streets alternate `primary`
(every 4th) and `residential`, named `Avenue <n>` (north–south) / `Street <n>`
(east–west). Places: one, `{ name: 'Centre', x: 0, z: 0 }`. Same seed ⇒
byte-identical output.

## Validation errors

`validateCity(raw: unknown): CityData` (`src/data/validate.ts`) validates an
unknown value against the Schema (v: 1) rules above. On the **first** problem
it throws an `Error` whose message names the JSON-ish path of the offending
field, e.g. `buildings[3].poly`, `roads[0].cls`. Checks performed, in order:

- Top level is an object with `v === 1` (else `v`).
- `origin.lat`/`origin.lon` are finite numbers (`origin.lat`, `origin.lon`).
- `bbox` is a length-4 array of finite numbers (`bbox`, `bbox[i]`).
- `buildings`: `h` finite and in `[3, 650]` (`buildings[i].h`); optional
  `name` is a string (`buildings[i].name`); `poly` is a closed ring with
  ≥ 3 finite `[x, z]` points and first point not repeated last
  (`buildings[i].poly`); `id` finite and unique per array (`buildings[i].id`).
- `roads`: `cls` is a valid `RoadClass` (`roads[i].cls`); optional `name` is a
  string (`roads[i].name`); `pts` is a polyline with ≥ 2 finite `[x, z]`
  points (`roads[i].pts`); `id` finite and unique per array (`roads[i].id`).
- `places`: non-empty string `name` (`places[i].name`); finite `x`/`z`
  (`places[i].x`, `places[i].z`).
