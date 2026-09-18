# scribble render style

Cell **3×3**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the coloured-ink scribble-sketch look from
`docs/architecture.md` §4.11 (wave 17, T-0134; v2 T-0136; v3 T-0137;
reference `lines.jpg`, a "scribble hatching" / continuous-line ink sketch
of a neon street): white paper, tone carried by stroke *density*, long
wobbly pen strokes that follow the surface (vertical world-lines on walls,
constant-depth on the ground, a loose tangle on the sky dome), ink coloured
by the object under it, one-sided pencil outlines, far buildings sketched
lighter.

## Algorithm (per pixel)

The scene sample, the depth taps, the class and the outline are **per
cell** (`cell = floor(vUv · grid)`). Strokes are **per canvas pixel**: the
world position is `P = viewPos(vUv, dC, …)` with the continuous `vUv` and
the cell's depth `dC`, then `W = (viewToWorld · vec4(P, 1)).xyz`. A nested
power-of-two LOD keeps the on-screen spacing constant as depth changes, so
the pen pattern walks with the world instead of sitting as a screen-space
grid.

1. `p = vUv · grid`; `cell = floor(p)`.
2. `c = sampleSub(cell, 0, 0)`; `v = shaped(bright(c))`;
   `tone = 1 − v` (0 = paper, 1 = solid ink).
3. `tint = tintOf(c)`; `sat = max(tint) − min(tint)`;
   `satF = smoothstep(0.10, 0.45, sat)`.
4. **Depth taps** at texel centres, ONE CELL apart (exactly as `lowpoly`
   v2, NOT one sub-sample apart like `edges`), **clamped** to
   `[0.5·texel, 1 − 0.5·texel]` so the bottom/edge rows get a real
   one-sided normal instead of an off-texture sample:
   `texel = 1/sceneSize`, `centreUv = (cell·sub + 0.5)·texel`,
   `stepUv = sub·texel`, `uvL/uvR/uvU/uvD = clamp(centreUv ± stepUv,
   0.5·texel, 1 − 0.5·texel)`, and `dC, dL, dR, dU, dD = linearDepth` at
   centre / ±x / ±y. `skyThr = 0.98 · cameraFar`.
5. **Class by view-space normal** (v2, `surfaceClass(dC, far, up)` → 0 sky
   | 1 ground | 2 wall): sky if `dC ≥ skyThr`; else the view-space position
   of each tap is `P(uv, d) = ((uv.x·2−1)·tanHalfFov·aspect·d,
   (uv.y·2−1)·tanHalfFov·d, −d)` with `aspect = sceneSize.x/sceneSize.y`;
   `n = normalize(cross(P(uvR,dR) − P(uvL,dL), P(uvU,dU) − P(uvD,dD)))`;
   `up = |dot(n, viewUp)|`; ground if `up > UP_K = 0.6`, wall otherwise
   (replaces the v1 vertical-slope rule, which flipped walls horizontal on
   an up-tilted camera and drew ticks on the bottom row).
6. **Fade** (non-sky): `tone *= depthFade(dC) = 1 − 0.45·smoothstep(120,
   900, dC)` — far blocks sketch lighter.
7. **World position + nested LOD** (v3):
   `P = viewPos(vUv, dC, tanHalfFov, aspect)` (per pixel, cell depth);
   `W = (viewToWorld · vec4(P, 1)).xyz`;
   `nW = normalize(mat3(viewToWorld) · n)`;
   `m = dC · 2 · tanHalfFov / sceneSize.y` (metres per cell at this depth).
   **Stroke coordinates** (`strokeCoords(W, nW, dC, up)` → `{ u, along }`,
   metres): wall (`up ≤ UP_K`) `t = normalize(cross((0,1,0), nW))`,
   `u = W·t`, `along = W.y` (vertical WORLD lines on the facade — they
   converge like a real perspective sketch when the camera pitches); ground
   (`up > UP_K`) `u = dPix`, `along = W.x + W.z` (lines of constant depth —
   horizontal on screen — that flow past as you walk). `dPix` is the cell
   depth `dC` reconstructed at the pixel from the one-cell taps
   (`dC + ½(dR−dL)·ox + ½(dU−dD)·oy`, gradient zeroed on a 35 % jump)
   because the scene target is 1 sample per cell — `linearDepth(vUv)`
   equals `dC` everywhere inside it.
   **Nested strokes** (`nestedStrokeInk(u, along, tone, m)`):
   `lod = log2(8·m)`, `L = floor(lod)`, `f = fract(lod)` (level `L` is 8
   cells apart on screen). Layer `k = 0..2` draws level `j = L − k` when
   `tone > t_k`, `t = [0.10, 0.40, 0.70]` (`SCRIBBLE_LAYERS` thresholds).
   At level `j`, `S = exp2(j)`:
   `i0 = floor(u/S + 0.5)` (nearest line of the family `i·2^j`); each
   level takes the max coverage over `i ∈ [i0−2, i0+2]` because stroke
   width + wobble can cover more than the nearest, and a faded odd line
   must fall back to the even neighbour (no-pop),
   `key = i·S` (the line's world coordinate — the same number at every
   level that contains it),
   `ph = hash2(key, 0)·6.2832`,
   `wob = m·(0.50·sin(along/m·0.16 + ph) + 0.25·sin(along/m·0.043 + 2·ph))`,
   `lift = hash2(key, floor(along/(24·m)) + 40) < 0.12` → pen lifts,
   `hw = m·(0.28 + 0.22·tone)`,
   `cov = 1 − smoothstep(hw − 0.15·m, hw + 0.15·m, |u − key − wob|)`,
   `weight = (mod(i, 2) == 1) ? (1 − f) : 1` (odd lines fade out as the LOD
   climbs; at `f → 1` they are gone and the even lines become the next
   level — no pop),
   `ink = max(ink, cov·weight)`.
   `strokeInk` of v1/v2 is deleted.
8. **Sky tangle** (v3, per pixel):
   `dirW = normalize(mat3(viewToWorld) · viewPos(vUv, 1, tanHalfFov, aspect))`;
   `K = sceneSize.y / (2 · atan(tanHalfFov))` (cells per radian);
   `ps = skyCoords(dirW, K) = (atan(dirW.x, −dirW.z)·K, asin(dirW.y)·K)`
   (dome coordinates in "cells"; the `atan` seam behind the camera is
   accepted). Then `tangleInk(ps.x, ps.y, density)` — three wavy families
   at fixed angles `θ = [0.12, 1.25, 2.30]`, `S = [2.5, 9, 7]` (family 0
   spacing 3 → 2.5 in v2, denser vertical hair); per line
   `u = px·cosθ + py·sinθ`, `along = −px·sinθ + py·cosθ`,
   `idx = floor(u/S)`; line absent when `hash2(idx, 20+j) > density`
   (`skyDensity = mix(0.60, 0.30, daylight)` — night a denser tangle, noon
   sparse); `ph = hash2(idx, 30+j)·2π`,
   `wob = 2.0·sin(along·0.09 + ph) + 1.2·sin(along·0.31 + 2·ph)`,
   `cov = 1 − smoothstep(0.15, 0.45, |u − (idx+0.5)·S − wob|)`. Sky ink =
   `SKY_INK` at `coverage · 0.85`; sky wash = paper. The tangle now sticks
   to the sky dome and pans with the camera.
9. **Outline** (one-sided, with the one-CELL-apart samples, still screen
   space / per cell): the cell is fully inked (`ink = 1`, `surfaceOutline`)
   when `isEdge(dC, [dL, dR, dU, dD], far)` (imported from `edges.ts`, term
   for term) AND `isNearSide(dC, dN, skyThr)` (imported from `quest.ts`)
   for at least one neighbour `dN`. Sky cells never carry an outline — the
   building side draws the skyline.
10. **Colour** (`inkColour(tint)`, `washColour(tint, tone)`):
    `inkCol = mix(INK, tint·0.50, 0.85·satF)` (darker ink, v2);
    `washCol = mix(PAPER, tint, 0.14·satF·min(1, tone·1.5))` (lighter
    wash, v2); `out = mix(washCol, inkCol, ink)`; sky = `mix(PAPER,
    SKY_INK, tangle·0.85)`.

Lit windows and neon read as bare paper with a coloured wash (tone ≈ 0),
which is the reference's look; the day-time window texture shows through as
stroke density.

## Shader notes

- **Per-pixel world strokes** — `P = viewPos(vUv, dC, …)` uses the
  continuous `vUv` and the cell's depth; `W` comes from the prelude
  `viewToWorld` (the camera's `matrixWorld`). A nested LOD (`lodOf(m)`,
  `nestedStrokeInk`) keeps spacing ~8/4/2 cells on screen at every depth.
- **Depth taps** are ONE CELL apart at texel centres (`stepUv = sub·texel`),
  exactly as `lowpoly` v2 — the ticket explicitly says NOT one sub-sample
  apart like `edges.ts`.
- **Unrolled layers** — GLSL ES 1.0 unrolls constant-bound loops, so the
  three nested-LOD layers and three tangle families are written out as
  literal blocks (`if (tone > …)` per layer), mirroring
  `nestedStrokeInk`/`tangleInk` value for value. `S = exp2(j)` with
  `j = L − k` as a float.
- **v3 hash** — `hash2` is the precision-safe hash (`fract` of a small
  multiply + a `dot` mix), not the matrix `sin` hash, so world-sized keys
  (`|a|, |b|` up to 1e5) stay in `[0, 1)`. Every caller (strokes, lifts,
  tangle) uses it.
- **Outline reuses the shared rules** — the fragment replicates `isEdge`
  (sky disagreement / inverse-depth second difference, `k = 0.02`) and
  `isNearSide` term for term; the pure mirror composes the imported
  `isEdge` + `isNearSide` in `surfaceOutline`.
- **One uniform** — `uniform float daylight` is the only style uniform,
  seeded from `ctx.daylight` in `makeUniforms` and refreshed every frame by
  the `update` hook. `makeUniforms` creates no textures; no `dispose`.
  Prelude uniforms (`viewUp`, `tanHalfFov`, `viewToWorld`) are never
  redeclared.

## Pure exports (unit-tested in node)

- `SCRIBBLE_LAYERS` — the three `{ spacing, threshold }` stroke layers
  `[{8, 0.10}, {4, 0.40}, {2, 0.70}]`. v3 uses only the thresholds; world
  spacing is `2^(L−k)`.
- `UP_K` — `0.6`, the ground/wall cut on `up = |dot(n, viewUp)|` (v2;
  replaces `SLOPE_K`).
- `PAPER` — `[0.98, 0.97, 0.94]`, the white paper.
- `INK` — `[0.12, 0.10, 0.12]`, the neutral pen ink.
- `SKY_INK` — `[0.15, 0.14, 0.18]`, the dim violet-grey sky tangle ink.
- `hash2(a, b): number` — v3 precision-safe hash, in `[0, 1)`.
- `viewPos(uv, d, tanHalfFov, aspect): [x, y, z]` — view-space position
  of a texel at linear depth `d` (v2).
- `viewNormal(uvs, depths, tanHalfFov, aspect): [x, y, z]` — unit
  view-space surface normal from the four L/R/U/D taps (v2).
- `surfaceClass(dC, far, up): 0 | 1 | 2` — sky / ground / wall (v2).
- `skyDensity(daylight): number` — `mix(0.60, 0.30, daylight)` (v2).
- `depthFade(d): number` — `1 − 0.45·smoothstep(120, 900, d)`.
- `strokeCoords(W, nW, dC, up): { u, along }` — world stroke coordinates
  in metres (v3).
- `lodOf(m): { L, f }` — `L = floor(log2(8·m))`, `f = fract(lod)` (v3).
- `nestedStrokeInk(u, along, tone, m): number` — nested-LOD surface-stroke
  coverage in `[0, 1]` (v3). Replaces deleted `strokeInk`.
- `skyCoords(dirW, K): [x, y]` — dome coordinates in cells (v3).
- `tangleInk(px, py, density): number` — sky-tangle coverage in `[0, 1]`.
- `surfaceOutline(dC, neighbours, far): boolean` — the one-sided outline
  gate (`isEdge` AND `isNearSide` over the four neighbours).
- `inkColour(tint): [r, g, b]` — `mix(INK, tint·0.50, 0.85·satF)` (v2).
- `washColour(tint, tone): [r, g, b]` — `mix(PAPER, tint,
  0.14·satF·min(1, tone·1.5))` (v2).

## Uniforms owned by the style

| name       | shape                                    |
|------------|------------------------------------------|
| `daylight` | `uniform float daylight` (from `ctx.daylight`) |

Common uniforms (`tScene`, `grid`, `sub`, `sceneSize`, `exposure`,
`gamma`, `time`, `tDepth`, `cameraNear`, `cameraFar`, plus the v2
**`viewUp`** — world +Y in view space — **`tanHalfFov`** — tan of the
camera's vertical half-fov — and the v3 **`viewToWorld`** — `mat4`, the
scene camera's `matrixWorld`: world position of a texel =
`(viewToWorld · vec4(P, 1)).xyz`, world direction of a view vector =
`mat3(viewToWorld) · v`) come from `STYLE_PRELUDE`. The shader reads
`viewUp`, `tanHalfFov` and `viewToWorld`; it never redeclares them. No
textures are created, so there is no `dispose`.

## What the shader does per pixel

1. `p = vUv · grid`, `cell = floor(p)`; sample, tone, tint (steps 1–3).
2. Clamped depth taps one cell apart; classify sky / ground / wall by the
   view-space normal (steps 4–5).
3. Sky cells paint the dome tangle on paper (step 8); return.
4. Non-sky: fade, world `W` / nested-LOD strokes, one-sided outline
   (steps 6–7, 9).
5. Write `mix(washCol, inkCol, ink)` as `gl_FragColor` (alpha = 1).

Because strokes are anchored in world metres with a nested LOD and the
paper reads through as a coloured wash, the result is a hand-drawn ink
sketch whose tone comes from stroke density rather than shading, and whose
pen lines walk with the city instead of sitting as a screen overlay.
