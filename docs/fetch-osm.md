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
`-0.106,51.506,-0.070,51.521` and origin Bank junction (`lon -0.0887,
lat 51.5133`).

Requires **node ≥ 22** (uses the global `fetch`); zero npm dependencies. The
real-bbox query takes ~1–3 minutes and Overpass is occasionally overloaded, so
the script retries each endpoint once on HTTP 429/504 (after 30 s) and then
falls back to the second endpoint. On success it prints exactly one summary
line and writes the file atomically (`<out>.tmp` → rename); on failure it
prints a one-line reason, exits non-zero, and never leaves a partial file.

## The summary line

```
city.json: N buildings, M roads, K places, S KB (skipped R relations)
```

- **N / M / K** — building, road, and place counts written to the file.
- **S KB** — minified file size in kibibytes.
- **R skipped relations** — multipolygon `building` relations that could not
  be emitted, i.e. whose building footprint is assembled from more than one
  `outer` way (see Limitations).

## Conversion behaviour

Handled by the pure module `scripts/osm-convert.mjs` (`convertOverpass`,
`heightOf`, `roadClassOf`, `project`), exactly per `docs/data-format.md`:

- **Buildings** — closed `way["building"]` rings (closing point dropped),
  `building=part`/`no` and open ways skipped, degenerate rings (< 1 m²)
  dropped, heights clamped to `[3, 320]`.
- **Roads** — `highway` → `cls` via the mapping table; unmapped values
  (e.g. `steps`) dropped; ways with < 2 distinct points dropped.
- **Places** — `place` nodes, `railway=station`, and named
  `tourism=attraction` nodes, deduplicated by name (first wins).
- Coordinates are projected to local metres and rounded to 0.1 m; the output
  is minified JSON.

## Known limitations

- **Multipolygon ring assembly is not done.** A building that spans several
  `outer` ways (a single ring assembled from multiple way segments) is
  skipped and counted in `skipped R relations`. Only multipolygons whose
  footprint is a single closed `outer` member are emitted.
- **Inner rings (courtyards) are ignored.** A building's `inner` members do
  not cut a hole in the footprint; the polygon is emitted as the outer ring
  only. City of London has few such buildings, so the visual impact is
  minimal.
- The Overpass query matches no `note`/`leisure` selectors; only the six
  selectors in `docs/data-format.md` are fetched.
- Data is a one-time snapshot; it refreshes only when someone re-runs
  `npm run fetch-data` and commits the result.
