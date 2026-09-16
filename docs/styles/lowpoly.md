# lowpoly render style

Cell **6×6**, sub **2×2**, depth texture (`needsDepth: true`). Implements
the *Money for Nothing* '80s-CGI look from
`docs/architecture.md` §4.11: flat-shaded facets in eight saturated hues
plus a grey ramp, and thick black ink where polygons meet.

## Algorithm (per cell)

1. `c = clamp(cellMean(cell), 0, 1)` — the 2×2 mean averages the window
   texture away, so facets read as flat.
2. `v = shaped(bright(c))` (the perceptual density curve, `gamma` 0.45).
3. `level = min(3, floor(v · 4))` — one of **4 flat shading bands**;
   `lum = LOWPOLY_LUM[level]` with `LOWPOLY_LUM = [0.22, 0.50, 0.78, 1.0]`.
4. `t = tintOf(c)` (hue at full brightness); `sat = max(t) − min(t)`.
5. If `sat < 0.25` the cell is on the **grey ramp** (`hue = (1, 1, 1)`);
   otherwise `hue` = the nearest of the 8 `LOWPOLY_HUES` by **squared RGB
   distance** to `t` (ties → lower index).
6. `col = hue · lum`.
7. **Outline test** (term for term with `isEdge` from `styles/edges.ts`):
   `dC = linearDepth` at the cell centre and `dL/dR/dU/dD` one **cell**
   away in each cardinal. A cell is an edge when the centre and a
   neighbour disagree on `sky` (`d ≥ 0.98 · cameraFar`), or — all
   non-sky — when `|wL + wR − 2·wC| > k·wC` or `|wU + wD − 2·wC| > k·wC`
   with `w = 1/d` and `k = 0.02`. All-sky is never an edge.
8. Edge → `LOWPOLY_INK = (0.02, 0.02, 0.04)`; else `col`. Sky cells are
   not special-cased: a daytime sky posterises to a flat blue band, night
   to black — both period-correct.

The fragment shader mirrors these steps term for term.

## Shader notes

- **Palette** — `uniform vec3 lpHues[8]`, filled from `LOWPOLY_HUES` in
  `makeUniforms`. The 8-iteration nearest-hue scan is a constant-index
  `for (int i = 1; i < 8; i++)` loop (GLSL ES 1.0 allows uniform-array
  indexing by a constant-index expression); no `sampler2D`, no 8-bit
  round-tripping.
- **Cell-spaced edge samples** — the `edges` style samples one
  *sub-sample* apart (`stepUv = 1.0 / sceneSize`); here `stepUv =
  1.0 / grid`, i.e. one **cell** apart, which is the only difference in
  the edge test and makes the ink lines one cell (6 px) thick. The pure
  mirror is `isLowpolyEdge`, a delegation to `isEdge` (the sample spacing
  is a shader-side concern; the test is identical).

## Pure exports (unit-tested in node)

- `LOWPOLY_HUES: readonly [r, g, b][]` — the 8 §4.11 hues in order:
  `#FF3030 #FF7A20 #FFE040 #70E040 #30E0E0 #3060FF #9040FF #FF40C0`
  (red, orange, yellow, lime, cyan, blue, purple, magenta).
- `LOWPOLY_LUM: readonly [number, number, number, number]` — the
  4-band luminance ramp `[0.22, 0.50, 0.78, 1.0]`.
- `LOWPOLY_INK: readonly [r, g, b]` — the outline colour
  `(0.02, 0.02, 0.04)`.
- `posterLevel(v): number` — `min(3, floor(v · 4))`, the shading band for
  a shaped brightness `v`.
- `snapHue(tint): number` — index into `LOWPOLY_HUES` by squared-RGB
  distance (ties → lower index), or `-1` for the grey branch
  (`max(t) − min(t) < 0.25`).
- `lowpolyColour(exposed, gamma): [r, g, b]` — the whole non-edge path
  (steps 1–6) from an exposed RGB sample.
- `isLowpolyEdge(dC, neighbours, far): boolean` — the outline rule
  (`isEdge` from `styles/edges.ts`, imported, not edited).

## Uniforms owned by the style

| name     | shape                                   |
|----------|-----------------------------------------|
| `lpHues` | `uniform vec3 lpHues[8]` (8 `Vector3`)  |

Common uniforms (`tScene`, `grid`, `sub`, `sceneSize`, `exposure`,
`gamma`, `time`, `tDepth`, `cameraNear`, `cameraFar`) come from
`STYLE_PRELUDE`. No GPU textures are allocated, so `dispose` is not
needed.

## What the shader does per pixel

1. `cell = floor(vUv · grid)` — every pixel inside a 6×6 canvas tile maps
   to the same cell; `cellMean` takes the 2×2 sub-sample mean.
2. Apply steps 1–6 of the algorithm → `col`.
3. Run the cell-spaced outline test (steps 7–8).
4. Write ink or `col` as `gl_FragColor` (alpha = 1).

Because every cell is one of at most 9 × 4 = 36 colours (plus ink), the
frame reads as crude faceted CGI — the geometry's boxes stay boxes, the
banding does the '80s work.
