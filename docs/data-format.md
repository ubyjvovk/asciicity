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

## The real dataset: City of London

- **bbox** (minLon, minLat, maxLon, maxLat): `-0.106, 51.506, -0.070, 51.521`
  — St Paul's to Aldgate, Barbican to the Thames (Tower of London included).
- **origin**: Bank junction, `lat 51.5133, lon -0.0887`. The player spawns at
  `(0, 0)` facing west (towards St Paul's).
- Size budget: the minified file must stay **under 6 MB**.

## Schema (v: 1)

```jsonc
{
  "v": 1,
  "origin": { "lat": 51.5133, "lon": -0.0887 },
  "bbox": [-0.106, 51.506, -0.070, 51.521],
  "buildings": [ { "id": 4521, "h": 24.5, "name": "Royal Exchange", "poly": [[x,z],[x,z],[x,z]] } ],
  "roads":     [ { "id": 77,  "name": "Cheapside", "cls": "primary", "pts": [[x,z],[x,z]] } ],
  "places":    [ { "name": "Bank", "x": 3.2, "z": -1.0 } ],
  "water":     [ [[x,z],[x,z],[x,z]] ]          // optional, rings (T-0023)
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

## OSM → JSON conversion rules (`scripts/osm-convert.mjs`)

Overpass QL (single request, `[out:json][timeout:180]`, `out geom;` so every
element carries its own coordinates):

```
[out:json][timeout:180];
(
  way["building"](51.506,-0.106,51.521,-0.070);
  relation["building"]["type"="multipolygon"](51.506,-0.106,51.521,-0.070);
  way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|primary_link|secondary_link|trunk_link)$"](51.506,-0.106,51.521,-0.070);
  node["place"](51.506,-0.106,51.521,-0.070);
  node["railway"="station"](51.506,-0.106,51.521,-0.070);
  node["tourism"="attraction"]["name"](51.506,-0.106,51.521,-0.070);
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
| footway                                            | `footway`     |

`name` copied when present. Ways with < 2 distinct points are dropped.

**Places** — every node from the `place`, `railway=station`, and
`tourism=attraction` selectors with a non-empty `name`. Deduplicate by
name (keep the first).

## Fetch script CLI (`scripts/fetch-osm.mjs`)

```
node scripts/fetch-osm.mjs [--bbox minLon,minLat,maxLon,maxLat] [--origin lon,lat] [--out public/data/city.json]
```

Node ≥ 22, zero dependencies (global `fetch`). Defaults are the City of
London values above. Prints exactly one summary line on success:
`city.json: N buildings, M roads, K places, S KB (skipped R relations)`.
Non-zero exit and a one-line reason on failure; never writes a partial file.
`npm run fetch-data` is the alias.

## Synthetic city (`src/data/synthetic.ts`)

`syntheticCity(seed = 1, blocks = 12)` — a deterministic Manhattan grid used
by unit tests, the e2e smoke test (`?synthetic=1`), and as the runtime
fallback when `city.json` fails to load. Blocks are 60 m squares separated by
14 m streets, centred on the origin; every block holds one rectangular
building inset 4 m with height from a seeded PRNG (mulberry32) in `[8, 120]`;
every 5th building is named `Block <i>`. Streets alternate `primary`
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
