# Terrain (`src/world/terrain.ts`)

Runtime half of the height grid: a triangle-interpolating sampler that is
exactly the surface the heightfield mesh draws, slope shading, straight
bridge decks between abutments, and the walkable `HeightFn`. Contract:
`docs/architecture.md` §4.9. Types: `TerrainData`, `HeightFn`, `FLAT_HEIGHT`,
`Road`, `Vec2` from `src/data/types.ts`.

Everything except `makeTerrainObject` is pure (no `document` / WebGL) and
unit-tested in node. `THREE.BufferGeometry` is fine in node (§8).

## Exports

- `class Terrain { constructor(data); data; min; max; heightAt(x, z) }`
- `terrainHeightAt(t, x, z): number`
- `buildTerrainGeometry(t): THREE.BufferGeometry`
- `makeTerrainObject(t): THREE.Mesh` — browser-only
- `bridgeProfile(pts, heightAt): number[]`
- `class BridgeDecks { constructor(roads, heightAt, cell = 25); deckAt(p) }`
- `makeGroundAt(terrain, decks): HeightFn`

## Sampling

`u = (x − x0) / step`, `v = (z − z0) / step`, each clamped to
`[0, cols − 1]` / `[0, rows − 1]` (a query outside the grid returns the
edge value). Then `c = min(floor(u), cols − 2)`, `r = min(floor(v), rows − 2)`,
`fu = u − c`, `fv = v − r`, and `h(cc, rr) = heights[rr · cols + cc]`.

The cell is split along the diagonal `(c, r) → (c + 1, r + 1)`:

- `fu ≥ fv` ⇒ `h00 + fu · (h10 − h00) + fv · (h11 − h10)`
  (triangle `(c,r)`, `(c+1,r)`, `(c+1,r+1)`)
- else ⇒ `h00 + fv · (h01 − h00) + fu · (h11 − h01)`
  (triangle `(c,r)`, `(c,r+1)`, `(c+1,r+1)`)

On the diagonal (`fu = fv`) both formulae agree: `(1 − fu) · h00 + fu · h11`.
The midpoint of that diagonal is therefore `(h00 + h11) / 2`.

### Worked example

A 2×2 grid, `x0 = 0`, `z0 = 0`, `step = 10`:

```
h00 = 0     h10 = 10
h01 = 4     h11 = 6
```

Query `(7, 2)`: `u = 0.7`, `v = 0.2`, `c = 0`, `r = 0`, `fu = 0.7`,
`fv = 0.2`. `fu > fv`, so

```
0 + 0.7 · (10 − 0) + 0.2 · (6 − 10) = 7 − 0.8 = 6.2
```

The other triangle would have used `h01 = 4` and given a different number;
that is the point of the `fu ≷ fv` split. A query at `(5, 5)` sits on the
diagonal and returns `(0 + 6) / 2 = 3`.

Because interpolation is linear on each triangle, the sampler at a triangle
centroid equals the average of that triangle's three vertex heights — the
same value the mesh would report there. Draped geometry therefore neither
floats nor sinks at sample points.

## Geometry

`buildTerrainGeometry` returns an **indexed** `THREE.BufferGeometry`
(`setIndex`, `position`, `uv`, `color`; then `computeVertexNormals` and
`computeBoundingSphere`). Not `MeshData`.

- `cols · rows` vertices. Vertex `(c, r)` sits at
  `(x0 + c·step, h(c, r), z0 + r·step)`.
- `uv = (x / 40, z / 40)` — one grid-texture tile is 40 m, as the flat
  ground in `src/world/ground.ts`. Texture `repeat` is left at 1.
- Per cell, two index triangles sharing the sampler's diagonal, wound so
  `cross(b − a, c − a).y > 0` (normals point `+y`):

  ```
  i00 = r·cols + c
  i10 = r·cols + (c + 1)
  i01 = (r + 1)·cols + c
  i11 = (r + 1)·cols + (c + 1)

  (i00, i01, i11)   // fu ≤ fv side
  (i00, i11, i10)   // fu ≥ fv side
  ```

  Index count is `6 · (cols − 1) · (rows − 1)`.
- After `computeVertexNormals()`, a `color` attribute holds the slope shade
  `s = min(1, 0.6 + 0.5 · max(0, n · L))` with
  `L = normalize(1, 2, 0.5)`. Flat ground has `n = (0, 1, 0)` so
  `n · L = L_y > 0.8` and `s` clamps to `1.0` — identical to London's unlit
  floor. A plane whose normal points away from `L` gets `s < 1`.

`makeTerrainObject(t)` is

```
Mesh(buildTerrainGeometry(t), MeshBasicMaterial({ map: makeGridTexture(), vertexColors: true }))
```

`makeGridTexture` is called only here so node can import the rest of the
module.

## Bridges

`bridgeProfile(pts, heightAt)`:

- `ya = heightAt(pts[0])`, `yb = heightAt(pts[last])`
- `t_i` = cumulative centre-line length / total length (`0` when the
  polyline has zero length)
- `ys[i] = max(ya + (yb − ya) · t_i, heightAt(pts[i]))`

A straight deck between the abutments that never dips below the ground at a
polyline vertex. Over a flattened river bed the middle is the lerp; over a
bump the middle is the terrain. A 2-point polyline is `[ya, yb]`.

`BridgeDecks` keeps only `bridge === true` roads. Every consecutive segment
is bucketed into a 25 m spatial hash (same cells as `CollisionGrid.corridorCells`)
with half-width `ROAD_WIDTH[cls] / 2 + 1` — the road ribbon plus a 1 m body
margin, the same corridor collision uses. Insertion expands each segment's
AABB by that half-width and writes the segment into every cell the box
touches.

`deckAt(p)` visits the 3×3 neighbourhood of `p`'s cell and, for every
segment whose corridor contains `p` (`distToSegment(p, a, b) ≤ halfWidth`),
takes `lerp(ys[i], ys[i+1], t)` with `t` the clamped projection of `p` onto
the segment. The result is the **maximum** of those heights, or `undefined`
when no corridor contains `p`.

## Walkable height

```
makeGroundAt(terrain, decks)(x, z)
  = max(terrain?.heightAt(x, z) ?? 0, decks?.deckAt([x, z]) ?? −Infinity)
```

The player, the buses and the sky ride on this. Boats ride on
`terrain.heightAt` alone (the river bed is flattened to the water level, so
a boat's `y = level + 1` falls out for free). With both arguments missing
this is `0`.

## Composition in `main.ts` (architecture.md §5)

Quoted from §5 step 2 and the frame loop:

> With `city.terrain`: `terrain = new Terrain(city.terrain)`,
> `decks = new BridgeDecks(city.roads, terrain.heightAt)`,
> `groundAt = makeGroundAt(terrain, decks)`; `makeTerrainObject` is added
> and the flat ground plane is lowered to `terrain.min − 0.5`; every builder
> and fleet receives `groundAt` (boats: `terrain.heightAt`). Without
> terrain `groundAt = FLAT_HEIGHT` and nothing changes. Camera at the
> spawn (`(x, groundAt(x, z) + 1.7, z)`); …

> Loop: … `stepPlayer` → camera position/rotation (`camera.rotation.order = 'YXZ'`,
> `position.y = groundAt(x, z) + 1.7`, `rotation.y = −yaw`, `rotation.x = pitch`;
> the sky group is moved to the same point) → …

This module does not call into `main.ts`; T-0043/44/45 wire it up.
