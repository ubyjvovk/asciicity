# World geometry — buildings

How a building footprint becomes the merged, lit mesh that dominates the
view. Contract: `docs/architecture.md` §4.2–4.4. Implementation:
`src/world/buildings.ts`, `palette.ts`, `textures.ts`, on top of the
PM-owned `MeshBuilder` in `src/world/mesh.ts`.

## Footprint → geometry

Each `Building` is a ring of `[x, z]` metres (first point **not** repeated)
plus a roof height `h`. Winding in the file is unspecified.

1. **`normalizeRing`** copies the ring and, if
   `THREE.ShapeUtils.area(ring as Vector2[])` is negative, reverses it so
   the area is positive (counter-clockwise in `x`/`z`, with `Vector2.y = z`).
2. Rings with `|area| < 1` (square metres) are skipped entirely — no walls,
   no roof.
3. **Walls** (all buildings, in order): for each edge `a → b` of the
   normalised ring, emit one quad (two triangles, 6 vertices) from `y = 0`
   to `y = h`. Vertex order is bottom-`a`, top-`a`, top-`b`, then
   bottom-`a`, top-`b`, bottom-`b`, so the geometric normal
   `cross(b−a, c−a)` agrees with the stored outward normal
   `n = normalize(b.z − a.z, 0, −(b.x − a.x))`. Degenerate (zero-length)
   edges are omitted.
4. **Roofs** (all buildings, in order): `ShapeUtils.triangulateShape(ring, [])`
   at `y = h`. Stored normal is `(0, 1, 0)`. If a triangulated face would
   wind downward (`cross.y < 0`), its last two vertices are swapped so the
   roof faces up. Roof UVs are `(0, 0)`.

The result is one non-indexed triangle soup (`MeshData`).
`makeBuildingsObject` wraps it in a `THREE.Mesh` with two Lambert materials
(see Groups below). `buildings.ts` does **not** import `textures.ts`; the
window texture is passed in.

## UV scale

One window-texture tile is **24 m × 24 m** (8 × 8 windows of 3 m).

- Wall `u = cumulativeDistanceAlongRing / 24` (so a 10×10 square, perimeter
  40 m, runs `u = 0 → 40/24` around the ring).
- Wall `v = y / 24` (`0` at the base, `h/24` at the top; `h = 5` → `5/24`).
- UVs wrap (`RepeatWrapping` on the texture), so a long façade tiles.

## Groups and materials

| group | `start` / `count`     | `materialIndex` | material |
|-------|-----------------------|-----------------|----------|
| 0     | all wall vertices     | 0               | `MeshLambertMaterial({ vertexColors: true, map: windowTex })` |
| 1     | all roof vertices     | 1               | `MeshLambertMaterial({ vertexColors: true, color: 0x606060 })` |

For the 10×10 × `h=5` square used in tests: group 0 is `{start:0, count:24}`
(4 walls × 6 vertices), group 1 is `{start:24, count:6}` (2 triangles).
Empty input (or every ring skipped) yields no groups.

Vertex colour is the **linear** `r,g,b` of `new THREE.Color(colorFor(building))`,
written on every vertex of that building so the window map is tinted per façade
and roofs pick up the same hue under the grey material.

## Palette (`src/world/palette.ts`)

```
PALETTE          = [0x3a6fd8, 0x2ecc71, 0x1abc9c, 0xf1c40f,
                    0xe67e22, 0xc0392b, 0x9b59b6, 0x95a5a6]
LANDMARK_PALETTE = [0x5dade2, 0xf7dc6f, 0xff6b6b, 0xda70d6]
```

`colorFor(b)` returns `LANDMARK_PALETTE[id % 4]` when `b.name` is present,
otherwise `PALETTE[id % 8]`.

## Window texture (`src/world/textures.ts`)

`makeWindowTexture()` is browser-only (`document.createElement('canvas')`).
Importing the module in node is safe; calling the function is not.

- 64×64 canvas, 8×8 grid of 8-px cells.
- Fill `#585858` (wall), then each cell's inner **4×5** px (inset `2, 1`) is
  `#ffffff` with probability 0.7 else `#404040`.
- Lights come from a **mulberry32** PRNG seeded with **7**, cells in
  row-major order.
- `RepeatWrapping` both axes, `NearestFilter` min/mag,
  `colorSpace = SRGBColorSpace`.
