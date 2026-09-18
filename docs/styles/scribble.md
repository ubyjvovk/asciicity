# scribble render style

Cell **3×3**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the coloured-ink scribble-sketch look from
`docs/architecture.md` §4.11 (wave 17, T-0134; v2 T-0136; v3 T-0137; v4
T-0138; reference `lines.jpg`, a "scribble hatching" / continuous-line ink
sketch of a neon street): white paper, tone carried by stroke *density*,
long wobbly pen strokes that follow the surface (vertical world-lines on
walls, constant-depth on the ground, short hair strokes on the sky dome),
ink coloured by the object under it, one-sided pencil outlines, far
buildings sketched lighter.

## Algorithm (per pixel)

The scene sample, the depth taps, the class and the outline are **per
cell** (`cell = floor(vUv · grid)`). Strokes are **per canvas pixel**: the
world position is `P = viewPos(vUv, dPix, …)` with the continuous `vUv` and
the reconstructed per-pixel depth `dPix`, then `W = (viewToWorld ·
vec4(P, 1)).xyz`. A nested power-of-two LOD keeps the on-screen spacing
constant as depth changes, so the pen pattern walks with the world instead
of sitting as a screen-space grid.

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
7. **World position + nested LOD** (v3, v4 depth/wobble):
   Reconstruct a per-pixel depth from the one-cell taps (`dPix = dC +
   ½(dR−dL)·ox + ½(dU−dD)·oy`, gradient zeroed on a 35 % jump) because the
   scene target is 1 sample per cell — `linearDepth(vUv)` equals `dC`
   everywhere inside it. v4 feeds `dPix` into **every** surface, not just
   the ground: `P = viewPos(vUv, dPix, tanHalfFov, aspect)`;
   `W = (viewToWorld · vec4(P, 1)).xyz`;
   `nW = normalize(mat3(viewToWorld) · n)`.
   **Stroke coordinates** (`strokeCoords(W, nW, d, up)` → `{ u, along }`,
   metres): wall (`up ≤ UP_K`) `t = normalize(cross((0,1,0), nW))`,
   `u = W·t`, `along = W.y` (vertical WORLD lines on the facade — they
   converge like a real perspective sketch when the camera pitches); ground
   (`up > UP_K`) `u = d`, `along = W.x + W.z` (lines of constant depth —
   horizontal on screen — that flow past as you walk). For the pixel,
   `d` is `dPix`.
   **Stroke scale** (`strokeScale(uN, alongN, up)` → `{ mu, ma }`) is the
   screen gradient of the stroke coordinate, not a facing-camera
   `m = dC·2·tanHalfFov/sceneSize.y` (that under-scales the ground and
   oblique facades so the lines fall below a pixel). Per cell, from the
   same five taps: `W_N = (viewToWorld · vec4(viewPos(uv_N, d_N), 1)).xyz`
   for `N ∈ {L, R, U, D}`; `u_N, along_N = strokeCoords(W_N, nW, d_N, up)`
   (ground: `u_N = d_N`);
   wall: `mu = max(|u_R − u_L|/2, 1e−4)`, `ma = max(|along_U − along_D|/2, 1e−4)`;
   ground: `mu = max(|u_U − u_D|/2, 1e−4)`, `ma = max(|along_R − along_L|/2, 1e−4)`.
   `mu` is metres of `u` per screen cell across the strokes; `ma` is metres
   of `along` per screen cell along them.
   **Wobble and lifts** live in WORLD metres; `ma` never enters a phase or
   a segment index (`wobble(along, ph, mu, ma, key)`,
   `lifted(key, along, ma)`). Hand tremor is per-line **value noise**, not
   a sine (sines at a fixed world period corrugate every stroke the same
   way and adjacent ground lines wave in step):
   `vis(P) = smoothstep(3, 8, P / ma)` (an octave shows once its period
   spans ≥ 3 cells),
   `vnoise1(x, key) = mix(hash2(floor(x), key), hash2(floor(x)+1, key),
   smoothstep(0, 1, fract(x)))`,
   `wob = mu · Σ_{k=0..2} A_k · (2 · vnoise1(along / P_k + 3·ph, key + 11·k) − 1) · vis(P_k)`
   with `P = [0.9, 3.5, 14]` m, `A = [0.60, 0.40, 0.40]`,
   `lifted` if any `k = 0..2` has `vis(G_k) > 0.5` and
   `hash2(key, floor(along / G_k) + 40 + k) < 0.06` with `G = [1.5, 6, 24]` m.
   For fixed `(along, ph, mu, key)`, `wobble` is identical for every
   `ma ≤ 0.9/8` (all octaves fully visible) — walking closer never changes
   a stroke's shape.
   **Nested strokes** (`nestedStrokeInk(u, along, tone, mu, ma)`):
   `lod = log2(8·mu)`, `L = floor(lod)`, `f = fract(lod)` (level `L` is 8
   cells apart on screen). Layer `k = 0..2` draws level `j = L − k` with
   **soft** weight `smoothstep(t_k − 0.08, t_k + 0.08, tone)`,
   `t = [0.10, 0.40, 0.70]` (`SCRIBBLE_LAYERS` thresholds) — per-cell tone
   flips no longer pop a whole layer.
   At level `j`, `S = exp2(j)`:
   `i0 = floor(u/S + 0.5)` (nearest line of the family `i·2^j`); each
   level takes the max coverage over `i ∈ [i0−2, i0+2]` because stroke
   width + wobble can cover more than the nearest, and a faded odd line
   must fall back to the even neighbour (no-pop),
   `key = i·S` (the line's world coordinate — the same number at every
   level that contains it),
   `ph = hash2(key, 0)·6.2832`,
   `wob = wobble(along, ph, mu, ma, key)`,
   skip the line when `lifted(key, along, ma)`,
   `hw = mu·(0.30 + 0.20·tone)` (the v3 core — wider cores went grey),
   `cov = 1 − smoothstep(hw − 0.15·mu, hw + 0.15·mu, |u − key − wob|)`,
   `weight = (mod(i, 2) == 1) ? (1 − f) : 1` (odd lines fade out as the LOD
   climbs; at `f → 1` they are gone and the even lines become the next
   level — no pop),
   `ink = max(ink, cov·weight·layerWeight)`.
   `strokeInk` of v1/v2 is deleted.
8. **Sky hair** (v4, per pixel; `tangleInk` is deleted):
   `dirW = normalize(mat3(viewToWorld) · viewPos(vUv, 1, tanHalfFov, aspect))`;
   `K = sceneSize.y / (2 · atan(tanHalfFov))` (cells per radian);
   `ps = skyCoords(dirW, K) = K · (dirW.x, dirW.z) / (1 + dirW.y)`
   (stereographic from the **nadir**: the only pole is straight down,
   never in the sky, and there is no azimuthal seam). Then
   `hairInk(ps, density)` — hair cells of `H = 8`; for each of the 3 × 3
   cells `c` around `floor(ps / H)` and each of 3 strokes `s = 0..2`, with
   `cid = c.x·7 + c.y·131 + s·17`:
   `r_n = hash2(cid, n)` for `n = 1..6`;
   absent if `r_1 > density`
   (`skyDensity = mix(0.75, 0.45, daylight)` — night a denser hair, noon
   sparse);
   `centre = (c + (r_2, r_3)) · H`;
   `radial = |centre| < 1 ? (0, 1) : normalize(−centre)` (toward the zenith
   = "up" everywhere);
   `dir = radial` rotated by `(r_4 − 0.5)·0.6` rad (±17° off vertical);
   `len = H · (0.9 + 2.0 · r_5)` (7–23 cells);
   `q = ps − centre`; `t = dot(q, dir)`; `s⊥ = dot(q, perp(dir))` with
   `perp(dir) = (−dir.y, dir.x)`;
   `bend = (r_6 − 0.5)·0.25·H·sin(π·(clamp(t/len, −0.5, 0.5) + 0.5))`;
   `endF = 1 − smoothstep(len/2 − 2, len/2, |t|)`;
   `cov = (1 − smoothstep(0.15, 0.40, |s⊥ − bend|)) · endF`;
   `ink = max` over the 27 strokes.
   Sky ink = `SKY_INK` at `coverage · 0.85`; sky wash = paper. Expect ≈
   10–15 % stroke coverage in open sky. The hair sticks to the sky dome
   and pans with the camera without reading as a wire cage.
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
    SKY_INK, hair·0.85)`.

Lit windows and neon read as bare paper with a coloured wash (tone ≈ 0),
which is the reference's look; the day-time window texture shows through as
stroke density.

## Shader notes

- **Per-pixel world strokes** — `P = viewPos(vUv, dPix, …)` uses the
  continuous `vUv` and the reconstructed per-pixel depth (walls and
  ground); `W` comes from the prelude `viewToWorld` (the camera's
  `matrixWorld`). Stroke scale is the screen gradient of `u`
  (`strokeScale` → `mu`/`ma` from the four neighbour taps), not a
  facing-camera metres-per-cell, so the ground and oblique facades keep
  the same on-screen spacing as a frontal wall. A nested LOD (`lodOf(mu)`,
  `nestedStrokeInk`) keeps spacing ~8/4/2 cells on screen. Wobble is
  per-line value noise (`vnoise1`) over world-metre octaves faded by
  `vis(P) = smoothstep(3, 8, P/ma)` so walking closer never changes a
  stroke's shape and adjacent lines do not corrugate in step.
- **Depth taps** are ONE CELL apart at texel centres (`stepUv = sub·texel`),
  exactly as `lowpoly` v2 — the ticket explicitly says NOT one sub-sample
  apart like `edges.ts`.
- **Unrolled layers** — GLSL ES 1.0 unrolls constant-bound loops, so the
  three nested-LOD layers are written out as an `if` ladder (`w_k =
  smoothstep(t_k−0.08, t_k+0.08, tone)` per layer). The sky-hair loop is
  3 × 3 cells × 3 strokes (27 segment evaluations), constant-bound, paid
  only on sky pixels. `S = exp2(j)` with `j = L − k` as a float.
- **v3 hash** — `hash2` is the precision-safe hash (`fract` of a small
  multiply + a `dot` mix), not the matrix `sin` hash, so world-sized keys
  (`|a|, |b|` up to 1e5) stay in `[0, 1)`. Every caller (strokes, lifts,
  hair) uses it.
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
  spacing is `2^(L−k)`. v4 soft-switches each layer with
  `smoothstep(t−0.08, t+0.08, tone)`.
- `UP_K` — `0.6`, the ground/wall cut on `up = |dot(n, viewUp)|` (v2;
  replaces `SLOPE_K`).
- `PAPER` — `[0.98, 0.97, 0.94]`, the white paper.
- `INK` — `[0.12, 0.10, 0.12]`, the neutral pen ink.
- `SKY_INK` — `[0.15, 0.14, 0.18]`, the dim violet-grey sky hair ink.
- `hash2(a, b): number` — v3 precision-safe hash, in `[0, 1)`.
- `viewPos(uv, d, tanHalfFov, aspect): [x, y, z]` — view-space position
  of a texel at linear depth `d` (v2).
- `viewNormal(uvs, depths, tanHalfFov, aspect): [x, y, z]` — unit
  view-space surface normal from the four L/R/U/D taps (v2).
- `surfaceClass(dC, far, up): 0 | 1 | 2` — sky / ground / wall (v2).
- `skyDensity(daylight): number` — `mix(0.75, 0.45, daylight)` (v4).
- `depthFade(d): number` — `1 − 0.45·smoothstep(120, 900, d)`.
- `strokeCoords(W, nW, d, up): { u, along }` — world stroke coordinates
  in metres (v3).
- `strokeScale(uN, alongN, up): { mu, ma }` — metres of `u` / `along` per
  screen cell from the four neighbour taps (v3.1).
- `lodOf(mu): { L, f }` — `L = floor(log2(8·mu))`, `f = fract(lod)` (v3).
- `vnoise1(x, key): number` — 1-D value noise in `[0, 1]` (v4 hand tremor).
- `wobble(along, ph, mu, ma, key): number` — world-metre three-octave
  value-noise wobble with screen-size fades (v4). `key` is the line's
  world coordinate so adjacent strokes do not wave in step.
- `lifted(key, along, ma): boolean` — world-metre pen-lift gate (v4).
- `nestedStrokeInk(u, along, tone, mu, ma): number` — nested-LOD
  surface-stroke coverage in `[0, 1]` (v3/v4). Replaces deleted `strokeInk`.
- `skyCoords(dirW, K): [x, y]` — stereographic-from-nadir dome coordinates
  in cells (v3.1).
- `hairInk(ps, density): number` — sky-hair coverage in `[0, 1]` (v4;
  length `H·(0.9+2.0·r_5)`, thinner `smoothstep(0.15, 0.40, …)`).
  Replaces deleted `tangleInk`.
- `hairDir(c, s): [x, y]` — unit direction of hair stroke `s` in cell `c`
  (v4 test helper).
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
3. Sky cells paint the stereographic dome hair on paper (step 8); return.
4. Non-sky: fade, reconstruct `dPix`, world `W` / screen-gradient scale /
   nested-LOD strokes with world-metre wobble and lifts, one-sided outline
   (steps 6–7, 9).
5. Write `mix(washCol, inkCol, ink)` as `gl_FragColor` (alpha = 1).

Because strokes are anchored in world metres with a nested LOD, per-line
value-noise wobble that does not writhe while walking, and the paper
reads through as a coloured wash, the result is a hand-drawn ink sketch
whose tone comes from stroke density rather than shading, and whose pen
lines walk with the city instead of sitting as a screen overlay.
