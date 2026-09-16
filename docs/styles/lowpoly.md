# lowpoly render style

Cell **6×6**, sub **2×2**, depth texture (`needsDepth: true`). Implements
v2 of the *Money for Nothing* '80s-CGI look from
`docs/architecture.md` §4.11 (T-0129: "make it upbeat and shiny, early-3D")
— flat-shaded facets in eight **pastel** hues plus a cool-chrome grey
ramp, thick black ink where polygons meet, and a specular shine band on
the brightest cells. v2 also fixes a depth-sampling seam bug (below) that
inked full-width horizontal rows on the ground. Since **T-0132** the style
declares `groundGrid: false`, so the world's perspective floor grid is
swapped out under `lowpoly` and the ground reads as flat pastel facets
rather than bright white grid squares.

## Algorithm (per cell)

1. `c = clamp(cellMean(cell), 0, 1)` — the 2×2 mean averages the window
   texture away, so facets read as flat.
2. `v = shaped(bright(c))` (the perceptual density curve, `gamma` 0.45).
3. `level = min(3, floor(v · 4))` — one of **4 flat shading bands**;
   `lum = LOWPOLY_LUM[level]` with `LOWPOLY_LUM = [0.45, 0.65, 0.85, 1.0]`.
4. `t = tintOf(c)` (hue at full brightness); `sat = max(t) − min(t)`.
5. If `sat < 0.25` the cell is on the **cool-chrome grey ramp**
   (`hue = LOWPOLY_GREY = (0.88, 0.92, 0.97)`); otherwise `hue` = the
   nearest of the 8 `LOWPOLY_HUES` by **squared RGB distance** to `t`
   (ties → lower index), mixed toward white by `LOWPOLY_PASTEL = 0.12`
   to go **pastel**: `hue = mix(LOWPOLY_HUES[idx], (1, 1, 1), 0.12)`.
6. `col = hue · lum`; then the **specular shine**: if `v ≥ 0.92` (the
   brightest cells), `col = mix(col, (1, 1, 1), LOWPOLY_SHINE)` with
   `LOWPOLY_SHINE = 0.75`.
7. **Outline test** (term for term with `isEdge` from `styles/edges.ts`):
   `dC = linearDepth` at the cell's bottom-left **texel centre** and
   `dL/dR/dU/dD` one **cell** away in each cardinal. With sub 2×2 the v1
   centre `(cell + 0.5) / grid` sat exactly on the seam between two depth
   texels, so NearestFilter picked either side per row and the
   second-difference test fired in full-width horizontal bands on flat
   ground. v2 samples at texel centres: `texel = 1 / sceneSize`,
   `centreUv = (cell · sub + 0.5) · texel`, neighbours at
   `centreUv ± sub · texel` (still one cell apart). A cell is an edge when
   the centre and a neighbour disagree on `sky` (`d ≥ 0.98 · cameraFar`),
   or — all non-sky — when `|wL + wR − 2·wC| > k·wC` or
   `|wU + wD − 2·wC| > k·wC` with `w = 1/d` and `k = 0.02`. All-sky is
   never an edge.
8. Edge → `LOWPOLY_INK = (0.02, 0.02, 0.04)`. Otherwise, sky cells
   (`cSky`) paint the **flat period sky** (wave 15b, T-0122):
   `band = daylight < 0.33 ? 0 : (daylight < 0.66 ? 1 : 2)` where
   `daylight` is the `StyleContext.daylight` uniform (0 night … 1 day),
   and the cell takes `LOWPOLY_SKY[band]` — night navy, dusk/dawn pink or
   day blue. Sky cells that ARE edges keep the ink (silhouettes stay
   outlined). Everything else is `col`.

The fragment shader mirrors these steps term for term.

## Shader notes

- **Palette** — `uniform vec3 lpHues[8]`, filled from `LOWPOLY_HUES` in
  `makeUniforms`. The 8-iteration nearest-hue scan is a constant-index
  `for (int i = 1; i < 8; i++)` loop (GLSL ES 1.0 allows uniform-array
  indexing by a constant-index expression); no `sampler2D`, no 8-bit
  round-tripping.
- **Cell-spaced texel-centre edge samples** — the `edges` style samples one
  *sub-sample* apart (`stepUv = 1.0 / sceneSize`); here the samples sit one
  **cell** apart (`stepUv = sub / sceneSize`) at **texel centres**
  (`centreUv = (cell · sub + 0.5) · texel`), which both makes the ink lines
  one cell (6 px) thick and keeps the depth samples off the sub-2×2 texel
  seam (the v2 bug fix). The pure mirror is `isLowpolyEdge`, a delegation
  to `isEdge` (the sample spacing is a shader-side concern; the test is
  identical).
- **Period sky** — `uniform vec3 lpSky[3]` is filled from `LOWPOLY_SKY`
  in `makeUniforms`, like `lpHues`. `uniform float daylight` is seeded
  from `ctx.daylight` in `makeUniforms` and refreshed every frame by the
  style's `update` hook (main.ts pushes a fresh `daylightFactor` into the
  `StyleRenderer` every 10 s). The band select is the §4.11 ternary,
  term for term with `skyBand`.

## Pure exports (unit-tested in node)

- `LOWPOLY_HUES: readonly [r, g, b][]` — the 8 §4.11 hues in order:
  `#FF3030 #FF7A20 #FFE040 #70E040 #30E0E0 #3060FF #9040FF #FF40C0`
  (red, orange, yellow, lime, cyan, blue, purple, magenta).
- `LOWPOLY_LUM: readonly [number, number, number, number]` — the
  4-band luminance ramp `[0.45, 0.65, 0.85, 1.0]` (v2).
- `LOWPOLY_INK: readonly [r, g, b]` — the outline colour
  `(0.02, 0.02, 0.04)`.
- `LOWPOLY_SHINE: number` — the specular shine factor `0.75` applied to
  cells with `v ≥ 0.92` (v2).
- `LOWPOLY_GREY: readonly [r, g, b]` — the cool-chrome grey
  `(0.88, 0.92, 0.97)` used by the low-chroma branch (v2).
- `LOWPOLY_PASTEL: number` — how much each saturated hue is mixed toward
  white, `0.12` (v2).
- `posterLevel(v): number` — `min(3, floor(v · 4))`, the shading band for
  a shaped brightness `v`.
- `snapHue(tint): number` — index into `LOWPOLY_HUES` by squared-RGB
  distance (ties → lower index), or `-1` for the grey branch
  (`max(t) − min(t) < 0.25`).
- `lowpolyColour(exposed, gamma): [r, g, b]` — the whole non-edge path
  (steps 1–6) from an exposed RGB sample, including the shine mix.
- `lowpolyPaletteSet(): [r, g, b][]` — the full discrete output set for
  non-sky pixels: `lowpolyColour` over the 9 tints × 4 bands plus the 9
  shine variants, then `LOWPOLY_SKY`, `LOWPOLY_INK` and black. Built from
  the pure exports, never by hand; the e2e purity check and the unit
  random-grid test use it.
- `isLowpolyEdge(dC, neighbours, far): boolean` — the outline rule
  (`isEdge` from `styles/edges.ts`, imported, not edited).
- `LOWPOLY_SKY: readonly [r, g, b][]` — the three flat period-sky
  colours in §4.11 "Sky cells" order: `#1A2060` (night navy),
  `#FF6FA8` (dusk/dawn pink), `#4FA8FF` (day blue) — v2 brighter values.
- `skyBand(daylight): number` — `0` night / `1` dusk-dawn / `2` day for a
  daylight factor in `[0, 1]` (thresholds `< 0.33` / `< 0.66`).

## Uniforms owned by the style

| name       | shape                                        |
|------------|----------------------------------------------|
| `lpHues`   | `uniform vec3 lpHues[8]` (8 `Vector3`)       |
| `lpSky`    | `uniform vec3 lpSky[3]` (3 `Vector3`)        |
| `daylight` | `uniform float daylight` (from `ctx.daylight`) |

Common uniforms (`tScene`, `grid`, `sub`, `sceneSize`, `exposure`,
`gamma`, `time`, `tDepth`, `cameraNear`, `cameraFar`) come from
`STYLE_PRELUDE`. No GPU textures are allocated, so `dispose` is not
needed.

## What the shader does per pixel

1. `cell = floor(vUv · grid)` — every pixel inside a 6×6 canvas tile maps
   to the same cell; `cellMean` takes the 2×2 sub-sample mean.
2. Apply steps 1–6 of the algorithm → `col` (pastel/chrome × band, then
   the shine mix when `v ≥ 0.92`).
3. Run the texel-centre, cell-spaced outline test (step 7).
4. Write the ink (edges), `lpSky[skyBand(daylight)]` (non-edge sky cells)
   or `col` as `gl_FragColor` (alpha = 1).

Because every cell is one of at most 9 × 4 = 36 colours (plus the 9 shine
variants, ink and the three flat sky bands), the frame reads as crude
faceted CGI — the geometry's boxes stay boxes, the banding does the '80s
work, and the shine makes the brightest facets pop like early 3D renders.
