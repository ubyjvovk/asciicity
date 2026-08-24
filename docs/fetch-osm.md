# Fetching real data (`scripts/fetch-osm.mjs`)

The real City of London dataset is fetched once from Overpass and **committed**
as `public/data/city.json` — there is no runtime Overpass dependency. The
browser loads the committed file (or falls back to the synthetic city).

## How to run

```
npm run fetch-data                 # defaults → public/data/city.json
node scripts/fetch-osm.mjs --out /tmp/asciicity-test.json
```

CLI (all optional):

```
node scripts/fetch-osm.mjs \
  [--bbox minLon,minLat,maxLon,maxLat] \
  [--origin lon,lat] \
  [--out public/data/city.json]
```

Defaults are the City of London values from `docs/data-format.md`: bbox
`-0.130,51.497,-0.070,51.521` (Westminster to Aldgate) and origin Bank
junction (`lon -0.0887, lat 51.5133`).

Requires **node ≥ 22** (uses the global `fetch`); zero npm dependencies. The
real-bbox query takes ~1–3 minutes and Overpass is occasionally overloaded, so
the script retries each endpoint once on HTTP 429/504 (after 30 s) and then
falls back to the second endpoint. On success it prints exactly one summary
line and writes the file atomically (`<out>.tmp` → rename); on failure it
prints a one-line reason, exits non-zero, and never leaves a partial file.

## The summary line

```
city.json: N buildings, M roads, K places, W water, R rivers, S KB (skipped R relations, dropped D open water chains)
```

- **N / M / K / W / R** — building, road, place, water-ring, and river
  centre-line counts written to the file.
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
- **Roads** — `highway` → `cls` via the mapping table; `footway` and other
  unmapped values (e.g. `steps`) are dropped; ways with < 2 distinct points
  are dropped. A road whose way carries a `bridge` tag with a value other than
  `no` (`yes`, `viaduct`, `movable`, …) is emitted with `bridge: true`;
  otherwise the key is omitted (T-0030 — bridges are walkable corridors).
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

## Known limitations

- **Multipolygon ring assembly is not done.** A building that spans several
  `outer` ways (a single ring assembled from multiple way segments) is
  skipped and counted in `skipped R relations`. Only multipolygons whose
  footprint is a single closed `outer` member are emitted.
- **Inner rings (courtyards) are ignored.** A building's `inner` members do
  not cut a hole in the footprint; the polygon is emitted as the outer ring
  only. City of London has few such buildings, so the visual impact is
  minimal.
- The Overpass query matches no `note`/`leisure` selectors; only the eleven
  selectors in `docs/data-format.md` are fetched (buildings, highways, the
  three place selectors, the four water selectors, and river centre-lines).
- Data is a one-time snapshot; it refreshes only when someone re-runs
  `npm run fetch-data` and commits the result.
