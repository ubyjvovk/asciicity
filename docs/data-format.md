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

## Datasets (one file per city)

| id (`?city=`) | file                      | origin                         | terrain |
|---------------|---------------------------|--------------------------------|---------|
| `london`      | `public/data/city.json`   | Bank junction                  | none (flat) |
| `kyiv`        | `public/data/kyiv.json`   | Maidan Nezalezhnosti `lat 50.4501, lon 30.5234` | SRTM 1″ grid, step 20 m |

Every file obeys the same schema; `terrain`/`waterLevels` are simply absent
for London. The registry the app uses is `src/data/cities.ts`
(architecture.md §4.10). Size budget per file: **under 10 MB** minified.

### Central Kyiv (`kyiv.json`, wave 5)

- **bbox**: `30.495, 50.422, 30.585, 50.470` — Golden Gate / Sophia / Podil
  (Kontraktova Square) in the west and north, Pechersk Lavra and the
  Motherland Monument in the south, Trukhaniv Island and the Hydropark strip
  of the left bank in the east. ≈ 6.4 km × 5.3 km.
- **origin**: Maidan Nezalezhnosti, `lat 50.4501, lon 30.5234` (DEM ≈ 156 m
  ASL; the Dnipro is ≈ 94 m, Pechersk/Sophia hills ≈ 190–200 m).
- Names: fetched with `--lang en` so `name:en` wins over the Cyrillic `name`
  when present (buildings, roads, places alike).
- Command: `node scripts/fetch-osm.mjs --bbox 30.495,50.422,30.585,50.470 --origin 30.5234,50.4501 --lang en --dem 1 --out public/data/kyiv.json`
  (`npm run fetch-data:kyiv`).

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
download). Counts/size: recorded here by the PM at accept.

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
4. **Heights**: the clamp is now `[3, 600]` (converter and validator; One
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
- `buildings[].h`: finite, clamped to `[3, 600]`.
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
- `relation` multipolygon: emit one building per member with `role=outer`
  whose own geometry is a closed ring (ring assembly across several outer
  ways is NOT done — document the count of skipped relations in the
  script's summary line). Inner rings (courtyards) are ignored.
- Height, first rule that applies:
  1. `height` tag: parse leading number; if the string ends in `ft` multiply
     by 0.3048.
  2. `building:levels` (number `L`): `h = L * 3.3 + 2` (+ `roof:levels * 3`
     when present).
  3. default by `building` value: `cathedral|church` 30, `office|commercial`
     20, `apartments|residential` 15, `retail` 10, anything else 14.
  Clamp to `[3, 600]`.
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
- `buildings`: `h` finite and in `[3, 600]` (`buildings[i].h`); optional
  `name` is a string (`buildings[i].name`); `poly` is a closed ring with
  ≥ 3 finite `[x, z]` points and first point not repeated last
  (`buildings[i].poly`); `id` finite and unique per array (`buildings[i].id`).
- `roads`: `cls` is a valid `RoadClass` (`roads[i].cls`); optional `name` is a
  string (`roads[i].name`); `pts` is a polyline with ≥ 2 finite `[x, z]`
  points (`roads[i].pts`); `id` finite and unique per array (`roads[i].id`).
- `places`: non-empty string `name` (`places[i].name`); finite `x`/`z`
  (`places[i].x`, `places[i].z`).
