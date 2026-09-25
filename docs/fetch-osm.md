# Fetching real data (`scripts/fetch-osm.mjs`)

The real datasets are fetched once from Overpass and **committed** — there is
no runtime Overpass dependency. The browser loads the committed file (or falls
back to the synthetic city). Two datasets are shipped today: `city.json`
(City of London to Westminster, flat) and `kyiv.json` (central Kyiv with SRTM
terrain and English names).

## How to run

```
npm run fetch-data                 # defaults → public/data/city.json
npm run fetch-data:kyiv            # central Kyiv → public/data/kyiv.json
node scripts/fetch-osm.mjs --out /tmp/asciicity-test.json
```

CLI (all optional):

```
node scripts/fetch-osm.mjs \
  [--bbox minLon,minLat,maxLon,maxLat] \
  [--origin lon,lat] \
  [--out public/data/city.json] \
  [--lang en] \
  [--dem 1] \
  [--dem-bare 1|true|ridge] \
  [--step 20] \
  [--tiles] \
  [--chunks NxM]
```

Defaults are the City of London values from `docs/data-format.md`: bbox
`-0.130,51.497,-0.070,51.521` (Westminster to Aldgate) and origin Bank
junction (`lon -0.0887, lat 51.5133`). `--lang`, `--dem` and `--step` are all
off by default; London is fetched without any of them.

Flags:

- `--lang <code>` — prefer `name:<code>` on buildings, roads and places, fall
  back to plain `name`. `--lang en` for Kyiv.
- `--dem 1` — build a `terrain` grid (and per-ring `waterLevels`) from SRTM
  1-arc-second tiles fetched from the AWS Terrain Tiles "skadi" mirror
  (cached under `.cache/dem/`). The Overpass timeout is bumped from 180 s to
  300 s to give the larger Kyiv box a chance to complete.
- `--dem-bare [1|true|ridge]` — apply a bare-earth filter to the DEM before the
  datum/height step (data-format.md §Terrain step 3b). SRTM is a radar
  surface model, so in dense cities (Tokyo) roof heights contaminate the
  street elevation. Two modes: the default **erode** mode (`--dem-bare`,
  `--dem-bare 1`, `--dem-bare true` — the wave-13 filter, byte-for-byte
  unchanged) erodes (second-smallest of a **9×9** window, T-0109) then smooths
  (mean of a 3×3 window applied **twice**, T-0109) the absolute-height grid;
  the **`ridge`** mode (`--dem-bare ridge`, wave 14b — what central Kyiv will
  use) replaces the erode with a directional opening that also tells roofs
  from ridges: a roof has lower ground in every direction and is cut, while a
  real bluff crest keeps a high ray along its plateau and is not shaved (the
  wave-13 erode measured −19 m on the Lavra crest, −12 m on the funicular
  bluff). Both then apply the same double 3×3 smooth. Off by default (existing
  datasets are unchanged); requires `--dem 1`. Any other value is rejected
  loudly.
- `--step <m>` — DEM grid spacing in metres (default 20).
- `--tiles` — ship the city as a **tiled dataset** (sector streaming, wave
  11): `--out` then names a city DIRECTORY holding `index.json` plus
  `tiles/<i>_<j>.json`. Format contract: docs/data-format.md "Tiled datasets".
  `--tiles` is orthogonal to every other flag (including `--chunks`).
  Bare `--tiles` (followed by another `--flag` or end of argv) and the value
  forms `--tiles 1` / `--tiles true` all enable tiling. Other flags still
  require a value — a valueless `--bbox` / `--out` / etc. errors with
  `unknown or valueless flag --<key>` instead of silently swallowing the
  next token.
- `--chunks <NxM>` — split the bbox into an N×M grid of sub-bboxes fetched
  sequentially (5 s pause between requests, same endpoint fallback as a
  single query) and concatenate the responses, deduplicating elements by
  `type` + `id` (a seam element is returned by every chunk) BEFORE
  conversion. Summary-line counts are post-dedupe. Use it for bboxes too
  large for one Overpass query (e.g. Tokyo). Orthogonal to every other flag.

Requires **node ≥ 22** (uses the global `fetch`); zero npm dependencies. The
real-bbox query takes ~1–3 minutes and Overpass is occasionally overloaded, so
the script retries each endpoint once on HTTP 429/504 (after 30 s) and then
falls back to the second endpoint. On success it prints exactly one summary
line and writes the file atomically (`<out>.tmp` → rename); on failure it
prints a one-line reason, exits non-zero, and never leaves a partial file.

## Central Kyiv (`kyiv.json`)

```
node scripts/fetch-osm.mjs \
  --bbox 30.495,50.422,30.585,50.470 \
  --origin 30.5234,50.4501 \
  --lang en --dem 1 \
  --out public/data/kyiv.json
```

(wired as `npm run fetch-data:kyiv`). Central-Kyiv bbox (Golden Gate / Sophia
/ Podil to Pechersk Lavra and the Trukhaniv/Hydropark strip of the left bank),
origin Maidan Nezalezhnosti. With `--dem 1` the converter samples SRTM into a
20 m grid (`terrain`) and flattens every water ring to its 10th-percentile bed
level (`waterLevels`), so buildings drape over the Pechersk hills and the
Dnipro reads as a flat sheet ~60 m below Maidan.

Wave 14b (T-0115): the committed `terrain` + `waterLevels` were regenerated in
place from the cached `N50E030` tile with the bare-earth `ridge` filter (the
alias carries `--dem-bare ridge`), which strips roof contamination from the
streets while preserving the real Dnipro bluff relief.

## Central Tokyo (`tokyo/`, wave 11; bbox v2 wave 12, T-0102)

The first streamed-only city ships as a **tiled** directory
(`public/data/tokyo/index.json` + `tiles/<i>_<j>.json`). Fetched command,
mirroring docs/data-format.md "Central Tokyo" (bare `--tiles` and
`--tiles 1` / `--tiles true` are equivalent; npm aliases use `--tiles 1`):

```
node scripts/fetch-osm.mjs --bbox 139.692,35.645,139.820,35.715 \
  --origin 139.7671,35.6812 --lang en --dem 1 --chunks 4x3 --tiles 1 \
  --out public/data/tokyo
```

- Bbox v2 ≈ 11.6 × 7.8 km — the v1 box plus the WEST strip covering
  Shibuya (the Scramble Crossing) and Shinjuku (station, Kabukicho).
  Origin Tokyo Station (verified: the fetched `railway=station` node
  11329319854 `name:en=Tokyo` at `139.7674549, 35.6811412` is ≈ 33 m from
  the specified origin, well within 100 m — no correction). The origin,
  tile grid and every v1 local coordinate are unchanged, so the v1 tiles
  keep their keys and the wave-11 presets stay valid; new tiles appear to
  the west.
- Shipped snapshot (fetched 2026-08-31, T-0102; terrain refreshed T-0108):
  170 619 buildings (max `h` 634 m — Tokyo Skytree, within the clamp),
  24 991 roads (+ splits across the 129 tile files), 1 087 places, 276
  water rings, 141 rivers, 39 547 trees (30 340 filled, 0 dropped),
  terrain 583×391 @ 20 m (datum 6.2 m ASL, 0 voids), 526 skipped
  relations, 0 dropped open water chains, 129 non-empty tiles, ≈ 27.0 MB
  on disk (index 2 697 648 B + tiles 25 628 014 B) — well under the
  60 MB budget.
- Terrain (T-0108) was regenerated in place from the cached `N35E139` DEM
  with the T-0109 bare-earth filter (9×9 erode + double 3×3 smooth,
  `--dem-bare 1`) during an Overpass outage; a future full
  `npm run fetch-data:tokyo` against the same cached tile reproduces the
  same `terrain` / `waterLevels` byte-for-byte, so nothing else drifts.

## Wave 21 regeneration (T-0160)

`public/data/london/` and `public/data/kyiv/` were re-fetched on 2026-09-25
with the unchanged aliases (`npm run fetch-data`, `npm run fetch-data:kyiv`),
so the tiles now carry the Simple-3D-Buildings keys (`roof`, `osmColor`,
`roofColor`, `material`). Same bbox, origin, flags and 1000 m tiling.

| | London before → after | Kyiv before → after |
|---|---|---|
| total bytes (index + tiles) | 3 434 093 → 4 425 852 | 3 604 059 → 3 862 281 |
| `index.json` (`cities.ts` `sizeBytes`) | 256 785 → 270 804 | 632 439 → 636 674 |
| largest tile | 322 774 → 421 355 | 201 204 → 248 342 |
| buildings | 9 061 → 13 865 | 8 183 → 9 129 |
| with `minH` (raised parts) | 0 → 1 757 | 0 → 403 |
| of those, 1.2 m slabs | — → 131 | — → 88 |
| `roof` (all non-flat) | — → 13.8 % | — → 9.9 % |
| `osmColor` | — → 28.6 % | — → 11.1 % |
| `roofColor` | — → 36.3 % | — → 8.2 % |
| `material` | — → 27.1 % | — → 5.3 % |

London roads 7 803 → 8 194 unique ids, water 31 → 63 rings, places 99.
The building growth is mostly `building:part` massing: both datasets were
last converted before T-0086's part support reached them (T-0096 migrated
the old monolithic files in place), so this is their first fetch with parts.
Thin raised parts (`h − minH < 1.2`) now keep their altitude as 1.2 m slabs
(data-format "Building parts" item 2) instead of being grounded into
full-height blocks. Nelson's Column is now OSM's own parts (the named shaft
is `minH 14, h 46`), so its landmark height fix and 52 m extra were removed.
Kyiv `terrain` keeps its 323×270 @ 20 m grid; 201 of 87 210 heights moved
(max 8.6 m) together with the water rings (51 → 57 `waterLevels`).
Overpass mirrors served slightly different snapshots on back-to-back runs
(London 8 099 vs 8 194 roads, and Nelson's Column's outline name was missing
from one run), so check the landmark names after any refetch.

## Wave 22 Tokyo from PLATEAU (T-0166)

`public/data/tokyo/` was rebuilt in place on 2026-09-25 from the pure OSM
build above with the T-0163 converter (`npm run fetch-data:tokyo-plateau`,
data-format "Tokyo from PLATEAU"); roads, trees, woods, water, places and
terrain are untouched, no OSM refetch was needed. Command used (the GML
cache is shared; `--cache` must be writable because the converter writes
`tokyo.stats.json` there, so a read-only cache needs a directory of
symlinks to its `raw/`, `catalog/`, `out/`):

```
node scripts/plateau/tokyo.mjs --data public/data/tokyo --cache <plateau cache>
```

99 meshes (132 ward copies, 8.88 GB GML), 225 989 unique `gml:id`s,
192 810 in the bbox; 192 644 kept (166 suppressed by OSM parts), 439 OSM
parts + 7 341 uncovered OSM buildings kept, 162 839 OSM replaced. Names:
IoU 13 854, cover 752, PLATEAU `gml:name` 688, fallback 3b 277 (241
unplaced). Validation 0 errors; wall time ≈ 2 min.

| | OSM (T-0102) → PLATEAU |
|---|---|
| total bytes (index + tiles) | 28 325 662 → 50 487 274 |
| `index.json` (`cities.ts` `sizeBytes`) | 2 697 648 → 2 768 132 |
| largest tile (`1_-3`) | 646 815 → 1 347 764 |
| tiles | 129 → 129 (none created / removed) |
| buildings | 170 619 → 200 424 |
| `roof` | 0 → 10 116 (gabled 6 855, hipped 2 114, skillion 869, pyramidal 278) |
| `tiers` | 0 → 23 540 buildings (92 900 tiers, max 63) |
| landmarks | → 16 133 |

Landmark heights after the merge:

- Tokyo Skytree — OSM parts kept (rule 5): named outline `h 634`, plus
  unnamed parts `minH 290 h 350` and `minH 410 h 450`.
- Tokyo Tower — OSM parts kept (rule 5): the named `Tokyo Tower` way is the
  21 m base; the lattice is unnamed parts up to `h 311` (301, 274, 251,
  250) plus `Special Observatory` 246 m.
- Tallest PLATEAU building in the bbox: Azabudai Hills Mori JP Tower
  312.1 m (OSM had 325.2). Yaesu: Tokyo Midtown Yaesu 235.2 m, Tokiwabashi
  Tower 208.8 m (9 tiers). Torch Tower is under construction and is not
  in PLATEAU.

Spawn fallout: the `shinjuku` preset vertex now sits inside a 6.1 m
PLATEAU structure (18 × 6 m) on the East Exit pedestrian street, and the
`Shibuya` landmark anchor moved 77 m north (the OSM station outline was
replaced by PLATEAU pieces; the name landed on a 13.6 m piece), so the
`shibuya` preset is 183.9 m from it (bound 120 m). See T-0166's questions.

## Tiling and chunked fetch (wave 11 — sector streaming)

Past Manhattan-scale density a city ships **tiled**: `public/data/<city>/`
holding `index.json` (global data: origin, bbox, tileSize, terrain, water +
waterLevels, rivers, `bridgeRoads`, `landmarks`, `places`, per-tile stats)
plus one `tiles/<i>_<j>.json` per non-empty tile. The full format contract is
docs/data-format.md "Tiled datasets"; the runtime that loads it is
architecture.md §4.19.

**Fetch-time tiling (`--tiles`):**

```
node scripts/fetch-osm.mjs --bbox 139.692,35.645,139.820,35.715 \
  --origin 139.7671,35.6812 --lang en --dem 1 --chunks 4x3 --tiles \
  --out public/data/tokyo
```

`--out` names the city DIRECTORY (created with `index.json` + `tiles/`, each
written atomically via a `.tmp` rename). The summary line gains a trailing
`N tiles (S KB tiled total)`.

**Migration command (`node scripts/tile-city.mjs`)**: a standalone, pure,
zero-dependency tiler that turns an existing monolithic `city.json` into a
tiled directory without touching Overpass — deterministic, so it can be
re-run safely:

```
node scripts/tile-city.mjs public/data/city.json public/data/london-tiled
```

It validates its input with `validateCity` (rule 7) before tiling and prints
a one-line summary. Input validation imports the TS validator from
`src/data/validate.ts` via Node's built-in type stripping (node ≥ 22.18).
Same input → byte-identical `index.json` and tile files.

**Chunked fetch (`--chunks NxM`)** splits a bbox too large for one Overpass
query into an N×M grid of sub-bboxes, fetched sequentially (5 s pause,
endpoint fallback unchanged), and dedupes the concatenated `elements` by
`type` + `id` before conversion so seam elements count once.

## The summary line

```
<out>: N buildings, M roads, K places, W water, R rivers, T trees (F filled, D dropped)[, terrain CxR @ S m (V voids)], S KB (skipped R relations, dropped D open water chains)
```

- **N / M / K / W / R** — building, road, place, water-ring, and river
  centre-line counts written to the file.
- **T trees (F filled, D dropped)** — `T` is the number of `[x, z, h, r]`
  trees written (`natural=tree` nodes + `tree_row` samples + wood/park
  fills after the 40 000 cap). `F` is how many of those are seeded fills
  that survived the cap; `D` is how many fill trees the cap dropped
  (mapped nodes/rows are never dropped).
- **terrain CxR @ S m (V voids)** — present only with `--dem 1`: grid columns
  × rows at step `S` metres, and the number of void HGT corners substituted
  by their non-void neighbours during sampling (data-format.md §Terrain).
- **S KB** — minified file size in kibibytes.
- **R skipped relations** — multipolygon `building` relations that could not
  be emitted, i.e. whose building footprint is assembled from more than one
  `outer` way (see Limitations).
- **D dropped open water chains** — open water ways that could not be chained
  into a closed ring (their endpoints matched nothing), so they were dropped.

## Conversion behaviour

Handled by the pure module `scripts/osm-convert.mjs` (`convertOverpass`,
`heightOf`, `roofOf`, `parseColour`, `materialOf`, `compassToDeg`, `roadClassOf`, `project`, `assembleRings`, `clipRingToBox`),
exactly per `docs/data-format.md`:

- **Buildings** — closed `way["building"]` rings (closing point dropped),
  `building=part`/`no` and open ways skipped, degenerate rings (< 1 m²)
  dropped, heights clamped to `[3, 650]`.
- **Simple 3D Buildings (wave 21, T-0158)** — per data-format.md "Simple 3D
  Buildings" items 1–7, every outline and `building:part` may carry four
  OPTIONAL keys, emitted only when their tags parse (untagged buildings
  convert byte-identically to before):
  - `roof` = `roofOf(tags, ring, h, minH)`: `roof:shape` (lower-cased, first
    `;` item) mapped to `gabled` / `hipped` / `pyramidal` / `skillion` /
    `dome` / `onion` / `round` (`flat` and unknown → no roof). `roof.h` from
    `roof:height` (ft-aware), else `roof:levels × 3`, else 3 m (4 m
    `pyramidal`, 0.5·R `dome`, 1.2·R `onion`, R = √(area/π)); rounded to
    0.1 m and clamped to `[0.5, h − minH − 1]` — no roof when that range is
    empty. `roof.dir` from `roof:direction` (degrees or 16-point compass
    letters via `compassToDeg`, `WSW` → 247.5 → 248), else for
    `roof:orientation=across` the longest-edge bearing + 90 reported axially
    in `[0, 180)` (an east-west block → 0); rounded to 1°, `360` → `0`.
    Bearings are clockwise from north = −z.
  - `osmColor` / `roofColor` = `parseColour(building:colour ?? colour)` /
    `parseColour(roof:colour)`: `#rgb`, `#rrggbb`, 6 bare hex digits, or one
    of the 148 CSS names (`_`, space, `-` ignored; `grey`/`gray`) → 24-bit
    int; anything else is omitted. `colour` is only consulted when
    `building:colour` is absent/empty.
  - `material` = `materialOf(tags)`: `building:material` → brick / stone /
    concrete / glass / metal / wood / plaster (item-5 table), else omitted.
  - A part's roof clamp uses its emitted `minH` (0 when grounded). Outlines
    replaced by parts still transfer only their `name` — never roof, colours
    or material. `validateCity` rejects out-of-range values (item 7).
- **Roads** — `highway` → `cls` via the mapping table; `footway`, `cycleway`
  and other unmapped values (e.g. `steps`) are dropped; ways with < 2
  distinct points are dropped. A road whose way carries a `bridge` tag with a
  value other than `no` (`yes`, `viaduct`, `movable`, …) is emitted with
  `bridge: true`; otherwise the key is omitted (T-0030 — bridges are walkable
  corridors). **Wave-5 exception (T-0040, extended T-0047):** a `footway` or
  `cycleway` with a `bridge` tag ≠ `no` is emitted as `cls: 'pedestrian'` +
  `bridge: true` (Kyiv's Parkovyi and Klitschko bridges are
  `highway=cycleway` + `bridge=yes`) — plain footways and cycleways stay
  dropped.
- **Names** — the display name of a building, road or place is the OSM `name`
  tag by default; with `--lang <code>` the converter prefers `name:<code>` and
  falls back to `name` (both trimmed). London is fetched without `--lang`;
  Kyiv with `--lang en`.
- **Places** — `place` nodes, `railway=station`, and named
  `tourism=attraction` nodes, deduplicated by name (first wins).
- **Water** — standalone `natural=water` / `waterway=riverbank` ways plus the
  `outer` members of their relations are assembled into rings, projected to
  local metres, clipped to the bbox expanded by 300 m, and cleaned/dropped
  like building rings (but with a 25 m² area floor).
- **Rivers** — `way["waterway"="river"]` ways become `rivers: Vec2[][]`, the
  River Thames centre-line(s) used as boat paths (T-0036). Each way is
  projected to local metres, rounded to 0.1 m, and passed through the same
  consecutive-duplicate cleanup as road polylines; polylines left with < 2
  distinct points are dropped. `rivers` is omitted from the file when empty.
- **Trees** — see [Trees](#trees) below. `trees` / `woods` are omitted when
  empty.
- Coordinates are projected to local metres and rounded to 0.1 m; the output
  is minified JSON.

## Water

Water (the Thames on the bbox's south edge, plus docks) is emitted as flat
blue `water: Vec2[][]` rings (`water` is omitted when empty). The Thames
relation extends far beyond the bbox, so rings are clipped down to it:

1. `assembleRings` — closed ways become rings directly; open ways are chained
   greedily by matching endpoints (equal lon/lat within `1e-7`) until they
   close; open chains that cannot close are dropped and counted as
   `dropped open water chains`.
2. Each ring is projected to local metres and rounded to 0.1 m (same cleaning
   as buildings: consecutive duplicates and a repeated closing point are
   dropped).
3. `clipRingToBox` Sutherland–Hodgman-clips the ring to the source bbox
   expanded by 300 m in local metres (so rivers just off the box are kept).
4. Rings with < 3 points or |area| < 25 m² after clipping are dropped.

Inner rings (islands) are ignored — the outer ring is emitted whole.

## Trees

Wave 7: OSM trees, tree rows, and wood/forest/park polygons become
`trees: [x, z, h, r][]` and `woods: Vec2[][]` (data-format.md §Trees). The
Overpass union adds:

```
node["natural"="tree"]
way["natural"="tree_row"]
way["natural"="wood"]
way["landuse"="forest"]
way["leisure"="park"]
relation["natural"="wood"]
relation["landuse"="forest"]
relation["leisure"="park"]
```

Conversion (`scripts/osm-convert.mjs`):

- **woods** — wood/forest and park ways plus the `outer` members of their
  relations are assembled and bbox-clipped exactly like water (25 m² area
  floor). Parks and woods share the `woods` array (minimap fill).
- **mapped trees** — one entry per `natural=tree` node; one every 8 m along
  each `tree_row` polyline (starting at 0).
- **fills** — a seeded jittered-grid of every wood/forest ring (one tree per
  150 m², step `√150 ≈ 12.2 m`) and every park ring (one per 400 m², step
  20 m). Each grid point is jittered ±0.45·step. Points inside a building
  footprint, within 6 m of a road centre-line, or inside a water ring are
  dropped (buildings/roads are bucketed into a 50 m grid first).
- **PRNG** — `mulberry32(42)` (copied into the script; same function as
  `src/data/synthetic.ts`), consumed in ring order then grid order so the
  output is byte-stable.
- **h / r** — `h` from the node's `height` tag when present, else
  `6 + rand·8` (6–14 m); `r = 0.35·h`. Both clamped to the validator
  ranges and rounded to 0.1 m.
- **cap** — 40 000 trees per file. Above it, keep every k-th fill tree
  (`k = ceil(n / 40000)`), never drop mapped nodes. The summary line
  reports `T trees (F filled, D dropped)`. Tests can pass a tiny
  `treeCap` into `convertOverpass`.

## Ring cleaning

Rounding WGS84 points to 0.1 m can collapse distinct source points onto the
same cell, which would otherwise leave rings that fail `validateCity` (a
building whose first point repeats its last, or self-intersecting
consecutive duplicates). Before a closed building ring is emitted, the
converter (`toRing`):

1. drops any point equal to the previous point (consecutive duplicates);
2. keeps dropping the last point while it equals the first;
3. drops the ring entirely if fewer than 3 points remain or `|area| < 1` m².

The same consecutive-duplicate removal is applied to road polylines, and
roads left with fewer than 2 points are dropped. A `building` multipolygon
relation that emits several disjunct outer rings gets a unique id per ring
(the first keeps the relation id; later ones are `el.id*1000+n`), so every
emitted ring passes the validator's per-array id-uniqueness rule.

## Terrain (`scripts/dem.mjs`)

Central Kyiv is hilly (wave 5). Its height grid is built from public SRTM
1-arc-second elevation, served from the AWS Terrain Tiles **skadi** mirror:
`https://s3.amazonaws.com/elevation-tiles-prod/skadi/<NS><lat>/<NS><lat><EW><lon>.hgt.gz`
(e.g. `skadi/N50/N50E030.hgt.gz` covers lat 50–51, lon 30–31; no key, no
meaningful rate limit). Tiles are cached under `.cache/dem/` (gitignored) so a
warm run never hits the network.

The module `scripts/dem.mjs` (pure, zero-dependency, node ≥ 22) exposes
`hgtTileName`, `hgtUrl`, `decodeHgt`, `Dem`, `fetchDemTiles`, `buildTerrain`
and `unproject` — every formula is documented in
`docs/data-format.md` §Coordinate system and §Terrain and implemented exactly
there, so this section only cross-references them:

- **Tile naming / URL** — `hgtTileName`/`hgtUrl` (floor of lat/lon, `N`/`S` +
  2 digits, `E`/`W` + 3 digits), see data-format.md §Terrain.
- **HGT format** — `decodeHgt` reads big-endian `int16` samples (`-32768` =
  void), `side = sqrt(bytes / 2)`; `Dem.elevationAt` does that tile's
  bilinear lookup with the void-corner rule (data-format.md §Terrain).
- **Projection inverse** — `unproject(x, z, origin)` mirrors `project` from
  `osm-convert.mjs` (data-format.md §Coordinate system), so grid nodes can be
  turned back into `(lon, lat)` for sampling.
- **Grid build** — `buildTerrain({bbox, origin, dem, step, waterRings})`
  follows data-format.md §Terrain steps 1–4: project + margin the bbox,
  sample every node relative to `datum`, then flatten nodes inside each water
  ring to that ring's 10th-percentile level.
- **Fetch** — `fetchDemTiles(bbox, {cacheDir, fetchImpl})` downloads every
  tile touching the bbox, gunzips, caches the `.hgt.gz` body, and returns a
  `Dem`; it fails loudly (throws) when a tile cannot be fetched — never a
  partial file. T-0040 wires this into `fetch-osm.mjs` (`--dem 1`).

Run the module's tests (requires node ≥ 22 and, for the single cached-tile
case, no network):

```
bash .tigerteam/scripts/run-tests.sh tests/dem.test.ts
```

The tests cover `hgtTileName`/`hgtUrl`, `decodeHgt` (including the void and
non-square-throw paths), `Dem.elevationAt` (exact/bilinear/north-edge/
void/missing-tile), `unproject`, `buildTerrain` (grid formula for the Kyiv
bbox, rounding/row ordering, water flattening) and `fetchDemTiles` caching.

## Known limitations

- **Multipolygon ring assembly is not done.** A building that spans several
  `outer` ways (a single ring assembled from multiple way segments) is
  skipped and counted in `skipped R relations`. Only multipolygons whose
  footprint is a single closed `outer` member are emitted.
- **Inner rings (courtyards) are ignored.** A building's `inner` members do
  not cut a hole in the footprint; the polygon is emitted as the outer ring
  only. City of London has few such buildings, so the visual impact is
  minimal.
- The Overpass query matches the selectors in `docs/data-format.md` (buildings,
  highways, the three place selectors, the four water selectors, river
  centre-lines, plus the eight tree/wood/park selectors in §Trees). Other
  `leisure`/`note` values are not fetched.
- Data is a one-time snapshot; it refreshes only when someone re-runs
  `npm run fetch-data` and commits the result.
