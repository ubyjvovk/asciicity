# Minas Tirith generator (`scripts/gen-minas-tirith.mjs`)

The first synthesised city. There is no OSM for Gondor: this script builds a
monolithic `city.json` from the locked geometry in `docs/architecture.md`
§4.23 (seven walled tiers, the rock prow, zig-zag gates, ring roads and The
Climbing Way, Pelennor, Mindolluin, named places, a `terrain` grid at step
10) and tiles it the same way `scripts/fetch-osm.mjs` calls
`scripts/tile-city.mjs`. Houses, landmark buildings and the White Tree are
T-0127 — this ticket's output is walls + gate towers only, `trees: []`.

The generator is deterministic (mulberry32 seed 1). Rerunning it reproduces
the same city; `tests/minastirith.test.ts` imports the pure functions.

## CLI

```
node scripts/gen-minas-tirith.mjs --out <dir>
npm run gen-data:minas-tirith
```

`--out` names a city **directory**. The script writes `index.json` +
`tiles/<i>_<j>.json` only (the monolithic object stays in memory). It does
not write `minas-tirith.city.json`.

`npm run gen-data:minas-tirith` targets `public/data/minas-tirith`. **Do not
commit that directory from this ticket** — T-0127 adds houses and landmarks,
then commits the dataset.

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

## Regenerating

```
npm run gen-data:minas-tirith
```

The committed `public/data/minas-tirith/` dataset is produced by T-0127
(after houses and landmarks land). This generator is the geometry source;
T-0127 will rerun it (or extend it) and check the tiles in.
