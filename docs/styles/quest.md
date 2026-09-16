# quest render style

Cell **3×3**, sub **1×1**, depth texture (`needsDepth: true`). Implements
the 1993–98 SVGA-era fantasy look from `docs/architecture.md` §4.11
(Heroes of Might & Magic II, Baldur's Gate, Diablo): 640-wide, 256-colour,
hand-painted. Every pixel lands on one of **12 painter's ramps of 20
hue-shifted shades** (cool dark end → warm light end), with a one-step
ordered dither, soft dark outlines at depth discontinuities, a subtle
vignette, and a banded painted sky driven by `StyleContext.daylight`.

## Algorithm (per cell)

1. `c = pow(clamp(sampleSub(cell, 0, 0), 0, 1), gamma)` — the exposed scene
   sample, gamma-shaped.
2. **Vignette**: `v = bright(c) · (1 − 0.25 · smoothstep(0.5, 1.0,
   length(p − 0.5) · 1.5))` with `p = vUv` — 1 dead centre, 0.75 in the
   corners (`questVignette`).
3. `t = tintOf(c)`; `sat = max(t) − min(t)`.
4. **Ramp selection**: `ramp = sat < 0.12 ? 0 (stone) : nearest r ∈ 1..11`
   by **squared RGB** distance between `t` and each ramp's **selection
   tint** (`rampFor`). The selection tint is `tintOf` of the ramp's **dark
   end** (shade 0) — the ramp's purest, coolest signature hue (see the
   Worker report note on the §4.11 "shade 14" prose).
5. **One-step dither**: `d = bayer8(cell.x, cell.y) − 0.5`;
   `i = clamp(floor(v · 20 + d), 0, 19)` (`shadeIndex`).
6. **Outline test** (term for term with `isEdge` from `styles/edges.ts`):
   `dC = linearDepth` at the cell centre and `dL/dR/dU/dD` one
   **sub-sample** apart (`stepUv = 1.0 / sceneSize`, exactly as `edges.ts`).
   A cell is an edge when the centre and a neighbour disagree on `sky`
   (`d ≥ 0.98 · cameraFar`), or — all non-sky — when `|wL + wR − 2·wC| >
   k·wC` or `|wU + wD − 2·wC| > k·wC` with `w = 1/d` and `k = 0.02`.
   All-sky is never an edge.
7. **Soft dark outline**: if edge, `i = max(0, i − 5)`.
8. **Sky cells** (`cSky` and not edge): `s = smoothstep(0.35, 0.95, p.y)`,
   then by daylight factor — `≥ 0.66`: sky ramp 8, `i = round(mix(17, 8,
   s))`; `≥ 0.33`: violet ramp 11, `i = round(mix(15, 6, s))`; else night
   ramp 9, `i = round(mix(9, 2, s))` — followed by the same dither
   `i = clamp(i + round(d), 0, 19)` (`questSky`).
9. `out = QUEST_RAMPS[ramp][i]`.

The fragment shader mirrors these steps term for term.

## Shader notes

- **Ramp texture** — `uniform sampler2D qRamps` is a 20×12 RGB
  `THREE.DataTexture` (`RGBAFormat`, `UnsignedByteType`, `NearestFilter`,
  `needsUpdate = true`) built in `makeUniforms` from `QUEST_RAMPS` — **no
  canvas**. Sampled at `((i + 0.5) / 20, (ramp + 0.5) / 12)`. Disposed in
  the style's `dispose` hook.
- **Selection tints** — `uniform vec3 rampTint[11]` holds the 11 ramp
  selection tints (`tintOf` of each ramp's dark end), filled from
  `rampTintOf` in `makeUniforms`. The nearest-ramp scan is a constant-index
  `for (int r = 1; r < 12; r++)` loop (as the PICO-8 palette scan).
- **Bayer8** — computed inline from the recursive `M2 = [[0, 2], [3, 1]]`
  construction (`M8[y][x] = M4[y>>1][x>>1] + 16·M2[y&1][x&1]`,
  `M4[y][x] = M2[y>>1][x>>1] + 4·M2[y&1][x&1]`), matching `bayer8` — 64
  distinct thresholds in `(0, 1)`.
- **Edge rule** — the `edges`/`lowpoly` depth test with neighbours one
  **sub-sample** apart (1 px ink), as `edges.ts` does (the pure mirror
  `isEdge` is imported from `styles/edges.ts`).
- **Sky** — `uniform float daylight` is seeded from `ctx.daylight` in
  `makeUniforms` and refreshed every frame by the style's `update` hook
  (main.ts pushes a fresh `daylightFactor` into the `StyleRenderer` every
  10 s).

## Pure exports (unit-tested in node)

- `QUEST_RAMP_ENDS` — 12 × `{ name, dark, light }`, the §4.11 ramp
  endpoints as `RRGGBB` hex in order: stone, marble, earth, wood, straw,
  forest, grass, sea, sky, night, crimson, violet.
- `buildQuestRamps(): [r, g, b][][]` — builds the 12 × 20 table:
  shade `i` = `mix(dark, light, (i / 19)^1.15)`.
- `QUEST_RAMPS` — the built 12 × 20 ramp table.
- `bayer8(x, y): number` — the 8×8 Bayer threshold, 64 distinct values in
  `(0, 1)`.
- `rampFor(tint): number` — ramp index by squared-RGB nearest to the ramp
  selection tints (ties → lower index), `0` (stone) below `sat < 0.12`.
- `shadeIndex(v, d): number` — `clamp(floor(v · 20 + d), 0, 19)`.
- `questSky(daylight, y01): { ramp, index }` — pre-dither sky ramp + shade.
- `questVignette(p): number` — the vignette multiplier.

## Uniforms owned by the style

| name       | shape                                         |
|------------|-----------------------------------------------|
| `qRamps`   | `uniform sampler2D qRamps` (20×12 `DataTexture`) |
| `rampTint` | `uniform vec3 rampTint[11]` (11 `Vector3`)    |
| `daylight` | `uniform float daylight` (from `ctx.daylight`) |

Common uniforms (`tScene`, `grid`, `sub`, `sceneSize`, `exposure`,
`gamma`, `time`, `tDepth`, `cameraNear`, `cameraFar`) come from
`STYLE_PRELUDE`. The ramp texture is disposed in `dispose`.

## What the shader does per pixel

1. `cell = floor(vUv · grid)` — every pixel inside a 3×3 canvas tile maps to
   the same cell; the single sub-sample (sub 1×1) is the cell colour.
2. Apply steps 1–7 of the algorithm (vignette, ramp, dither, outline).
3. Sky cells (not edges) take the banded painted sky (step 8).
4. Write `QUEST_RAMPS[ramp][i]` from the ramp texture as `gl_FragColor`
   (alpha = 1).

Because every cell snaps to one of 240 ramp colours via the one-step
dither, gradients band gently instead of posterising, and the soft dark
outlines + vignette give the hand-painted 640×360 SVGA look.
