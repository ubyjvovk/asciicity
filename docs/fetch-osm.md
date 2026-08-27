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
  [--step 20]
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
- `--step <m>` — DEM grid spacing in metres (default 20).

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
`heightOf`, `roadClassOf`, `project`, `assembleRings`, `clipRingToBox`),
exactly per `docs/data-format.md`:

- **Buildings** — closed `way["building"]` rings (closing point dropped),
  `building=part`/`no` and open ways skipped, degenerate rings (< 1 m²)
  dropped, heights clamped to `[3, 320]`.
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
