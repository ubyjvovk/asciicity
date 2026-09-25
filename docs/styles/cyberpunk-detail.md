# cyberpunk facade detail geometry (wave 20b, T-0154)

Extra silhouette clutter on OSM footprints: ledges, window-grid AC units,
balconies, downpipes, rooftop tanks / boxes / masts. Pure builder
`src/render/punk/detailmesh.ts` (`buildDetailMesh`); browser layer
`src/render/punk/detail.ts` (`createDetailLayer`, id `'detail'`). Contract:
`docs/architecture.md` §4.11 "`cyberpunk` v2" → "Facade detail geometry".

## Seating

Same as walls. `normalizeRing` then `ringHeights`:

- wall base = `ringHeights.base + (minH ?? 0)`
- roof = `ringHeights.top + h`
- outward normal of a CCW edge `a→b` = `(dz, −dx) / len`

Per-building RNG is `mulberry32(id)` (copy of the PRNG in `textures.ts`).

A building is skipped (zero triangles) unless `h ≥ 6` **and** some edge is
`≥ 4 m`.

## Geometry

| piece | rule |
|---|---|
| ledges | `h ≥ 15` only; 0.25 m slab, 0.35 m out, every 12 m of wall height (12, 24, …) |
| AC units | 0.9 × 0.6 × 0.5 m on the 3 m window grid, ~1 per **45 m²** of wall below 40 m, at floor + 0.4 m, 0.5 m out |
| pipes | 0.2 × 0.2 m, full wall height; 1 per edge ≥ 10 m, 2 if ≥ 25 m |
| balconies | 30 % of buildings; every other floor (6 m) up to 30 m; every 6 m of edge; slab 2.4 × 0.15 × 1.1 m + 0.05 m rail at +1.0 m |
| rooftop | 1–4 items, inset ≥ 2 m, point-in-polygon of base corners: water tank (8-gon r 1.2 h 2.5), AC box 2 × 1.2 × 1 m, mast 0.1 × 6 m |

Vertex colours are greys in `[0.16, 0.30]`. Ledge and balcony **top** faces
(slab and rail) add `+0.06` so the lip catches the rain sheen.

## Layer

`CellStreamer` with buildRadius 450 m, disposeRadius 600 m,
`maxBuildsPerFrame` 1. One `Mesh` per cell (or `null`), **one** shared
`MeshStandardNodeMaterial` (`vertexColors`, roughness 0.45, metalness 0.4,
`normalNode = rippleNormal(u, 4.8, float(0.6))` with the layer's own
`uTime` / `uRain`). `update` streams around the camera and advances
`uTime`; `detach` calls `streamer.clear(root)`; `dispose` frees the
material. Stats: `cells`, `pending`, `buildMs`, `triangles`.

`triangles` is the real triangle count of the non-indexed soup
(`positions.length / 9`), summed over built cells.

## Budgets (london tile `0_0`)

Unit-tested via `bucketSources`: mean real triangles per 250 m cell ≤ 60 000,
max ≤ 150 000; whole-tile `buildDetailMesh` ≤ 400 ms in node.
