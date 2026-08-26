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
  "buildings": [ { "id": 4521, "h": 24.5, "name": "Royal Exchange", "poly": [[x,z],[x,z],[x,z]] } ],
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
- `buildings[].h`: finite, clamped to `[3, 320]`.
- `roads[].pts`: ≥ 2 points. `cls` ∈ `RoadClass`.
- `places[]`: finite `x`/`z`, non-empty `name`.
- `id` unique within each array.
- `water` (optional): array of rings obeying the `poly` rules; may be absent or empty.
- `rivers` (optional): array of polylines (≥ 2 finite points each); may be absent or empty.
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
  Clamp to `[3, 320]`.
- `name` copied when present (trimmed).

**Roads** — `highway` mapping to `cls`:

| OSM `highway`                                     | `cls`         |
|---------------------------------------------------|---------------|
| trunk, trunk_link, primary, primary_link           | `primary`     |
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
   pokes through. Rings are processed in array order.
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
- `buildings`: `h` finite and in `[3, 320]` (`buildings[i].h`); optional
  `name` is a string (`buildings[i].name`); `poly` is a closed ring with
  ≥ 3 finite `[x, z]` points and first point not repeated last
  (`buildings[i].poly`); `id` finite and unique per array (`buildings[i].id`).
- `roads`: `cls` is a valid `RoadClass` (`roads[i].cls`); optional `name` is a
  string (`roads[i].name`); `pts` is a polyline with ≥ 2 finite `[x, z]`
  points (`roads[i].pts`); `id` finite and unique per array (`roads[i].id`).
- `places`: non-empty string `name` (`places[i].name`); finite `x`/`z`
  (`places[i].x`, `places[i].z`).
