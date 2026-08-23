# Collision (`src/world/collision.ts`)

Keeps the player out of building footprints. Pure module (no three.js, no
DOM); contract in `docs/architecture.md` §4.6.

## Exports

- `pointInPolygon(p, poly): boolean`
- `distToSegment(p, a, b): number`
- `class CollisionGrid { constructor(buildings, cell = 25); blocked(p, r = 0.6); resolve(from, to, r = 0.6) }`

All positions are the local `[x, z]` metres used by the rest of the world
builders (§3 of the architecture doc).

## Algorithm

### `pointInPolygon`

Standard even-odd ray casting: for each edge `(poly[j], poly[i])` we test
whether a horizontal ray from `p` in `+x` crosses it and toggle `inside`. The
parity result is independent of ring winding, so callers may pass either
orientation (buildings are unwound at ingest time).

### `distToSegment`

Projects `p` onto the segment `a→b` and clamps the parameter to `[0, 1]`, then
returns the Euclidean distance to the resulting foot. Zero-length segments
degenerate to the distance from `p` to `a`.

### `CollisionGrid`

A uniform spatial hash keyed by `${cx},${cz}` with `cx = floor(x / cell)`,
`cz = floor(z / cell)` and a default `cell = 25` metres.

- **Insertion.** Each footprint's axis-aligned bounding box is expanded by
  1 m (to catch the query radius) and inserted into every cell that box
  touches. Footprints spanning several cells appear in each one.
- **`blocked(p, r = 0.6)`.** Visits the 3×3 block of cells centred on `p`'s
  cell, deduplicates candidates through a `Set`, does an AABB reject
  (expanded by `r`), then returns `true` on the first candidate whose polygon
  contains `p` or whose nearest edge is closer than `r`. The player's
  effective body radius is 0.6 m.
- **`resolve(from, to, r = 0.6)`.** Wall-sliding fallback chain, per §4.6:
  1. return `to` if `blocked(to)` is false;
  2. else try `[to.x, from.z]` (x-only step);
  3. else try `[from.x, to.z]` (z-only step);
  4. else return `from` (cornered — no legal move).

  Only the axis-aligned partial steps are tried, so a diagonal move into an
  obtuse corner still slides along whichever wall is compatible.

## Complexity

Let `B` = total buildings and `k` = candidates in the visited 3×3 cell block.

| Operation      | Cost         | Notes                                              |
|----------------|--------------|----------------------------------------------------|
| Construction   | `O(B · c)`   | `c` = cells each footprint straddles (small)       |
| `blocked(p)`   | `O(k · v)`   | `v` = vertices in a footprint (typically 4–20)     |
| `resolve(f,t)` | up to 3 × `blocked` | early-exits on the first free candidate     |

At the target city scale (a few thousand buildings, cell = 25 m) `k` is a
small constant, and the perf test (`tests/collision.test.ts`) runs 10 000
`blocked` queries against 5 000 rectangles in well under 200 ms in node.

## Tuning

- `cell = 25` m matches typical block spacing so most footprints live in a
  handful of cells. Smaller cells cost more memory and more insertions;
  larger cells fatten `k` and slow queries.
- `r = 0.6` m is the player capsule radius used by `stepPlayer` (T-0008); it
  keeps the camera off wall textures without letting the player squeeze
  through the 3 m window-tile gaps.
