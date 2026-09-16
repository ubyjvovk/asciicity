# quest render style

Cell **3×3**, sub **1×1**, depth texture (`needsDepth: true`). Implements
the 1993–98 SVGA-era fantasy look from `docs/architecture.md` §4.11
(Heroes of Might & Magic II, Baldur's Gate, Diablo): 640-wide, 256-colour,
hand-painted. Every pixel lands on one of **12 painter's ramps of 20
hue-shifted shades** (cool dark end → warm light end) at one of **six flat
shades per ramp** (`QUEST_LEVELS`), with **one-sided thin pencil outlines**
at depth discontinuities, a subtle vignette, and a **banded painted sky**.
Since **T-0130** ("more like a drawing: flatter, thinner lines, without
squares on the ground everywhere") the shading is **flat — no dither** — and
the outlines are **one-sided** (ink lands on the near object only, 2 shades
down), which is what removes the "squares" and the fat marker lines of v1.
Since **T-0132** the style also declares `groundGrid: false`, so the
world's perspective floor grid (`world/ground.ts`) is swapped out under
`quest` and the ground reads as a flat painted floor instead of bright
white squares.

## Algorithm (per cell)

1. `c = pow(clamp(sampleSub(cell, 0, 0), 0, 1), gamma)` — the exposed scene
   sample, gamma-shaped.
2. **Vignette**: `v = bright(c) · (1 − 0.15 · smoothstep(0.5, 1.0,
   length(p − 0.5) · 1.5))` with `p = vUv` — 1 dead centre, 0.85 in the
   corners (`questVignette`; the corner drop is 0.15, was 0.25 in v1).
3. `t = tintOf(c)`; `sat = max(t) − min(t)`.
4. **Ramp selection**: `ramp = sat < 0.12 ? 0 (stone) : nearest r ∈ 1..11`
   by **squared RGB** distance between `t` and each ramp's **selection
   tint** (`rampFor`). The selection tint is `tintOf` of the ramp's **dark
   end** (shade 0) — the ramp's purest, coolest signature hue (see the
   Worker report note on the §4.11 "shade 14" prose).
5. **Six flat shades per ramp, NO dither**:
   `level = min(5, floor(v · 6))`, `i = QUEST_LEVELS[level] = [2, 5, 9, 12,
   16, 19]` (`shadeIndex`). Quantising to six flat shades folds the ground
   grid texture (only a few percent brighter than the road) away — the v2
   "no squares" fix.
6. **One-sided outline** (silhouette/crease, term for term with the v1
   depth test but ink on the nearer side only): read `dC = linearDepth` at
   the cell centre and `dL/dR/dU/dD` one **sub-sample** apart
   (`stepUv = 1.0 / sceneSize`, exactly as `edges.ts`). Detect a
   discontinuity "as before" — `jump` (centre/neighbour disagree on `sky`,
   `d ≥ 0.98 · cameraFar`) or, all non-sky, the inverse-depth second
   difference `|wL + wR − 2·wC| > k·wC` or `|wU + wD − 2·wC| > k·wC`
   (`w = 1/d`, `k = 0.02`). Then gate it one-sided: the cell is inked only
   when it is the **nearer side** — some neighbour has `isNearSide(dC, dN,
   skyThr)` true, i.e. `dN > dC`, or the neighbour is sky while the centre
   is not. A depth jump therefore draws a single 1-cell line on the near
   object instead of a 2-cell line, and flat receding ground (second
   difference ≈ 0) is never banded.
7. **Thin pencil line**: if edge, `i = max(0, i − 2)` (2 shades down, not
   5 — a pencil line, not a marker).
8. **Sky cells** (`cSky` and not edge): banded, no dither —
   `s = smoothstep(0.35, 0.95, p.y)`, `b = min(3, floor(s · 4))`; by
   daylight factor — `≥ 0.66`: sky ramp 8, `i = 17 − 3·b` ({17,14,11,8});
   `≥ 0.33`: violet ramp 11, `i = 15 − 3·b` ({15,12,9,6}); else night ramp
   9, `i = 9 − 2·b` ({9,7,5,3}) (`questSky`).
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
- **Flat shades** — the shader computes `level = min(5, int(floor(v·6)))`
  and maps it to `[2,5,9,12,16,19]` via a GLSL if-chain `questLevel(int)`
  (GLSL ES 1.00 cannot dynamically index a `const` array; the if-chain
  mirrors `shadeIndex`/`QUEST_LEVELS` value for value). There is **no
  dither** — the v1 `bayer8`/`bayer2` shader helpers are gone.
- **One-sided outline** — `isNearSide(dC, dN, skyThr)` mirrors the pure
  gate term for term: `edge = (jump || crease) && (isNearSide over the 4
  neighbours)`. This is the "a neighbour counts only when dN > dC" rule of
  §4.11 "quest v2": ink on the near side of a jump, never a 2-cell line,
  never a flat-ground band.
- **Sky** — `uniform float daylight` is seeded from `ctx.daylight` in
  `makeUniforms` and refreshed every frame by the style's `update` hook
  (main.ts pushes a fresh `daylightFactor` into the `StyleRenderer` every
  10 s). Banded (no dither) per the three formulas above.

## Pure exports (unit-tested in node)

- `QUEST_RAMP_ENDS` — 12 × `{ name, dark, light }`, the §4.11 ramp
  endpoints as `RRGGBB` hex in order: stone, marble, earth, wood, straw,
  forest, grass, sea, sky, night, crimson, violet.
- `buildQuestRamps(): [r, g, b][][]` — builds the 12 × 20 table:
  shade `i` = `mix(dark, light, (i / 19)^1.15)`.
- `QUEST_RAMPS` — the built 12 × 20 ramp table.
- `bayer8(x, y): number` — the 8×8 Bayer threshold, 64 distinct values in
  `(0, 1)` (kept for the pico8-style mirror test; unused by the v2 shader).
- `rampFor(tint): number` — ramp index by squared-RGB nearest to the ramp
  selection tints (ties → lower index), `0` (stone) below `sat < 0.12`.
- `QUEST_LEVELS` — the six flat shades `[2, 5, 9, 12, 16, 19]`.
- `shadeIndex(v): number` — `QUEST_LEVELS[min(5, floor(v · 6))]` (no
  dither argument in v2).
- `isNearSide(dC, dN, skyThr): boolean` — the one-sided outline gate:
  `dN > dC` or (`dN ≥ skyThr` and `dC < skyThr`).
- `questSky(daylight, y01): { ramp, index }` — the banded (no-dither) sky
  ramp + shade.
- `questVignette(p): number` — the vignette multiplier (corner drop 0.15).

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
2. Apply steps 1–7 of the algorithm (vignette, ramp, six flat shades,
   one-sided outline).
3. Sky cells (not edges) take the banded painted sky (step 8).
4. Write `QUEST_RAMPS[ramp][i]` from the ramp texture as `gl_FragColor`
   (alpha = 1).

Because every cell snaps to one of 12 × 6 flat ramp shades, gradients are
flat and even (no dither speckle), and the one-sided pencil outlines keep
the hand-painted 640×360 SVGA look without fat 2-cell marker lines.
