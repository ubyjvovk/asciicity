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

`colorFor(b)` returns `LANDMARK_COLORS[b.name]` when the OSM name is a key
of that table, otherwise `LANDMARK_PALETTE[id % 4]` when `b.name` is present,
otherwise `PALETTE[id % 8]`. `landmarkColor(name)` looks up the table and
returns `undefined` when `name` is missing or unknown. Lookup is exact and
case-sensitive.

| OSM `name` | hex |
|---|---|
| Elizabeth Tower | `0xf7dc6f` |
| Palace of Westminster | `0xd4a017` |
| Westminster Abbey | `0xe8e0c8` |
| St Paul's Cathedral | `0xe8e0c8` |
| Nelson's Column | `0xe8e0c8` |
| National Gallery | `0xe8e0c8` |
| Somerset House | `0xe8e0c8` |
| London Eye | `0xffffff` |
| 30 St Mary Axe | `0x1abc9c` |
| 20 Fenchurch Street | `0x95a5a6` |
| Lloyd's of London | `0x95a5a6` |
| Tower 42 | `0x3a6fd8` |
| Heron Tower | `0x3a6fd8` |
| Tower Bridge | `0x5dade2` |
| Tower of London | `0xc0392b` |
| The Monument | `0xf7dc6f` |
| Monument | `0xf7dc6f` |
| Bank of England | `0xe8e0c8` |
| Royal Exchange | `0xe8e0c8` |
| Mansion House | `0xe8e0c8` |

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

## Water (`src/world/water.ts`)

`city.water` is an optional list of rings with the same rules as
`Building.poly` (≥ 3 points, first not repeated; winding unspecified).
Each ring becomes a flat dark-blue polygon just above the ground.

1. Rings with fewer than 3 points are skipped.
2. **Normalise** a copy of the ring so `THREE.ShapeUtils.area(ring as
   Vector2[])` is positive (reverse when negative) — the same winding
   rule as building footprints.
3. Rings with `|area| < 1` m² are skipped.
4. **Triangulate** with `ShapeUtils.triangulateShape(ring, [])` at
   `y = 0.02`. Stored normal is `(0, 1, 0)`. UVs are `(0, 0)`. If a
   triangulated face would wind downward (`cross.y < 0`), its last two
   vertices are swapped so the surface faces up.

The result is one non-indexed triangle soup (`MeshData`) in a single
group `{start: 0, count: N, materialIndex: 0}`. Empty input (or every
ring skipped) yields no groups. Vertex colour is the **linear** `r,g,b`
of `new THREE.Color(0x163a6b)` on every vertex.

`makeWaterObject` wraps the soup in a `THREE.Mesh` with
`MeshBasicMaterial({ vertexColors: true })`. Collision is **not**
applied in this module — `main.ts` feeds water rings into
`CollisionGrid` as fake footprints so the player stays on land.

## Sky (`src/world/sky.ts`)

`sunPosition` / `moonPosition` are pure NOOA low-precision positional
astronomy (accuracy ≈ ±2°) implemented exactly as given in the ticket
(solar: `n`, `L`, `g`, `λ`, `ε`, `δ`, `α`, GMST → hour angle → altitude /
azimuth; lunar: `Lm`, `Mm`, `F`, `λm`, `βm` → equatorial → same
altitude/azimuth). Azimuth is degrees clockwise from north, `[0, 360)`;
altitude in degrees. `moonPosition.fraction = (1 − cos(λm − λsun)) / 2` is
the illuminated fraction, `[0, 1]`.

A direction from `(azimuthDeg A, altitudeDeg h)` is
`dir = (sin A·cos h, sin h, −cos A·cos h)` (architecture.md §3: `x` east,
`z` south, `y` up).

`makeSky(date, origin, seed = 5)` builds a `THREE.Group` with three
children:

| child | geometry | material | placement / rule |
|-------|----------|----------|------------------|
| sun   | `CircleGeometry(45, 24)` | `MeshBasicMaterial({ color: 0xfff2b0, fog: false })` | at `dir·1200`, `lookAt(0,0,0)`; visible when `alt > −2°` |
| moon  | `CircleGeometry(32, 24)` | `MeshBasicMaterial({ color: 0xd9dbe4, transparent: true, fog: false })` | at `dir·1200`; `opacity = 0.25 + 0.75·fraction`; visible when `alt > −2°` |
| stars | `THREE.Points`, 300 mulberry32-seeded (seed 5) directions, altitude 5°–85°, radius 1300 | `PointsMaterial({ size: 3, color: 0x9fb4c8, fog: false, sizeAttenuation: false })` | visible only when sun `alt < −6°` |

`updateSky(group, date, origin)` moves/toggles the existing children —
position + `lookAt` + visibility for sun/moon, opacity for moon, visibility
for stars — with **no per-call allocation** (the discs are only ever
repositioned). The stars are static (fixed celestial sphere); only their
visibility changes. `makeSky` stores its three children in `group.userData`
so `updateSky` can reach them without rebuilding.
