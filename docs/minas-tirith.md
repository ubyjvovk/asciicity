# Minas Tirith generator (`scripts/gen-minas-tirith.mjs`)

The first synthesised city. There is no OSM for Gondor: this script builds a
monolithic `city.json` from the locked geometry in `docs/architecture.md`
§4.23 (seven walled tiers, the rock prow, zig-zag gates, ring roads and The
Climbing Way, houses, Citadel landmarks, Rath Dínen, the White Tree,
Pelennor, Mindolluin, named places, a `terrain` grid at step 10) and tiles
it the same way `scripts/fetch-osm.mjs` calls `scripts/tile-city.mjs`.
Houses, landmarks and trees live in `scripts/minas-tirith-buildings.mjs`
and are assembled by `buildCity`.

The generator is deterministic (mulberry32 seed 1). Rerunning it reproduces
the same city; `tests/minastirith.test.ts` and
`tests/minastirith-buildings.test.ts` import the pure functions.

## CLI

```
node scripts/gen-minas-tirith.mjs --out <dir>
npm run gen-data:minas-tirith
```

`--out` names a city **directory**. The script writes `index.json` +
`tiles/<i>_<j>.json` only (the monolithic object stays in memory). It does
not write `minas-tirith.city.json`.

`npm run gen-data:minas-tirith` targets `public/data/minas-tirith` (the
committed tiled dataset: `index.json` + `tiles/`).

## What it builds

- **Frame.** Origin `{ lat: 43.77, lon: 11.25 }` (Florence's latitude).
  City centre (the Citadel) at `(0, 0)`; extent ±1500 m; `bbox` is the
  unprojected extent corners (data-format equirectangular projection).
  The city faces east (`+x`); Mindolluin rises to the west.
- **Terrain.** `step` 10, `datum` 0, 302×302 nodes (extent + one margin
  cell, row 0 = north). Plateau / 25 m ramp per tier, eastern prow one
  tier proud with a 12 m-wide notch where the ring road crosses the east
  axis, Mindolluin west of `x = −520`, Pelennor ±1.5 m value-noise on a
  60 m lattice. Heights rounded to 0.1 m.
- **Walls.** 48-segment rings, 6 m thick; L1 black (`color` `0x2a2a30`),
  L2–L7 white stone (`0xd8d4c8`). Segments spanning the gate azimuth ±6°
  are omitted and replaced by two 10×10 m gate towers. The L1 pair is
  named `Great Gate` (`shape: 'tower'`).
- **Roads.** `The Climbing Way` (primary) from `(R_1 + 60, 0)` through
  the Great Gate, along each ring (`R_k − 14`) by the shorter arc (through
  the prow notch on tiers 2–6), and in to `(10, 0)`. Seven ring roads;
  radial `Lane k.n` on tiers 1–6; `East Road` / `North Road` / `South Road`
  on the Pelennor.
- **Places.** Great Gate, Rath Celerdain, Fen Hollen, Court of the
  Fountain, Houses of Healing, Rath Dínen, The Citadel, Pelennor Fields.
- **Houses.** Two tangential rows per tier on L1–L6 when the plateau band
  `R_k − R_{k+1} − 25 ≥ 50` (otherwise the outer row only, at
  `max(R_k − 27, R_{k+1} + 25.5)` so every centroid sits on `H_k`). Width
  `9+rand·5`, depth `7+rand·3`, gap 3 m, height `7+rand·8`. Skips the prow
  sector (`±(w+10)` m of east on L2–L6), ±10° around the tier's gate and
  the next gate, any footprint within 6 m of a radial lane, and AABB
  overlaps. Colour `[#D8D4C8, #CFCBC0, #E2DED2, #BFBAB0]` by `id % 4`.
  Ids `10000 + k·1000 + n`.
- **Landmarks.** Twelve named buildings (ids `20000 + n`). See the list
  below. Colour `#F2EFE6` unless noted.
- **Trees.** The White Tree `[0, 0, 8, 3]` plus six `h 7 r 3` trees in the
  Houses of Healing garden (azimuth 155°–165°, r 150–175).

## Tiers

| level | wall r (m) | plateau h (m) | wall h (m) | gate azimuth |
|------:|-----------:|--------------:|-----------:|-------------:|
| L1    | 420        | 0             | 20         | 90° (east)   |
| L2    | 355        | 32            | 14         | 135°         |
| L3    | 295        | 64            | 14         | 45°          |
| L4    | 240        | 96            | 14         | 135°         |
| L5    | 190        | 128           | 14         | 45°          |
| L6    | 145        | 160           | 14         | 135°         |
| L7    | 100        | 200           | 12         | 45°          |

Gate azimuths are degrees clockwise from north (`x = r·sin a`, `z = −r·cos a`).

## Landmarks

| name | size (m) | h (m) | shape | colour | where |
|------|----------|------:|-------|--------|-------|
| White Tower of Ecthelion | 22×22 | 90 | tower | `#F2EFE6` | `(−40, 0)` |
| Tower Hall | 44×18 | 22 | | `#F2EFE6` | `(6, 0)` |
| Merethrond | 40×16 | 16 | | `#F2EFE6` | `(−10, −40)` |
| The King's House | 30×16 | 14 | | `#F2EFE6` | `(−10, 40)` |
| Houses of Healing | 40×16 | 12 | | `#F2EFE6` | r 165, az 150° |
| House of the Stewards | 12×12 | 8 | dome | `#B8B4AA` | r 110, az 270° |
| Rath Dínen (×5) | 8×8 | 6 | dome | `#B8B4AA` | r 126…190, az 270°, 16 m spacing |
| The Old Guesthouse | 24×12 | 10 | | `#CFC3A8` | r 395, az 120° (L1) |

## Facade (wave 16b, T-0133)

Every city's building walls wear a texture; the registry key
`CityInfo.facade` picks which (architecture.md §4.23 "Facade"). Absent means
`'windows'` (the office-window map, `makeWindowTexture` in `src/world/textures.ts`).
Minas Tirith is the only city with `facade: 'stone'`: `makeStoneTexture()` —
a 256×256 running-bond masonry atlas, `#E6E2D8` fill with 1-px `#C9C4B8`
mortar lines every 32 px horizontally and vertical joints every 64 px
staggered by 32 px on alternate courses (the pure helpers
`stoneCourseAt`/`stoneJointOffset` are unit-tested in
`tests/textures.test.ts`). `main.ts` chooses the wall texture once
(`wallTex`) and passes it to every `makeBuildingsObject` call — both boot
paths and the streamed tile-group path — so houses, walls and the White
Tower all read as masonry. The e2e citadel test faces the White Tower and
asserts the near-black pixel fraction of the frame stays < 0.15 (the
office-window map's dark window squares would exceed it).

## Regenerating

```
npm run gen-data:minas-tirith
```

The committed dataset is `public/data/minas-tirith/` (`index.json` +
`tiles/`). Regenerating with seed 1 must reproduce it. Registry, spawn
presets and e2e boot are T-0128.
