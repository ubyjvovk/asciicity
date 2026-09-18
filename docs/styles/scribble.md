# scribble render style

Cell **3×3**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the coloured-ink scribble-sketch look from
`docs/architecture.md` §4.11 (wave 17, T-0134; reference `lines.jpg`, a
"scribble hatching" / continuous-line ink sketch of a neon street): white
paper, tone carried by stroke *density*, long wobbly pen strokes that follow
the surface (vertical on walls, horizontal on the ground, a loose tangle in
the sky), ink coloured by the object under it, one-sided pencil outlines,
far buildings sketched lighter.

## Algorithm (per pixel)

Strokes are drawn **per canvas pixel in continuous cell space**
(`p = vUv · grid`, NOT floored) — nothing is tiled — so a line runs unbroken
across many cells like a real pen. Only the scene sample, the depth taps and
the class are per cell (`cell = floor(p)`).

1. `p = vUv · grid`; `cell = floor(p)`.
2. `c = sampleSub(cell, 0, 0)`; `v = shaped(bright(c))`;
   `tone = 1 − v` (0 = paper, 1 = solid ink).
3. `tint = tintOf(c)`; `sat = max(tint) − min(tint)`;
   `satF = smoothstep(0.10, 0.45, sat)`.
4. **Depth taps** at texel centres, ONE CELL apart (exactly as `lowpoly`
   v2, NOT one sub-sample apart like `edges`):
   `texel = 1/sceneSize`, `centreUv = (cell·sub + 0.5)·texel`,
   `stepUv = sub·texel`, and `dC, dL, dR, dU, dD = linearDepth` at
   centre / ±x / ±y. `skyThr = 0.98 · cameraFar`.
5. **Class** (`surfaceClass(dC, dU, dD, far)` → 0 sky | 1 ground | 2 wall):
   sky if `dC ≥ skyThr`; else `slope = (dU − dD) / (2·dC)`; ground if
   `slope > SLOPE_K = 0.006`, wall otherwise.
6. **Fade** (non-sky): `tone *= depthFade(dC) = 1 − 0.45·smoothstep(120,
   900, dC)` — far blocks sketch lighter.
7. **Surface strokes** (`strokeInk(u, along, tone)`): wall `u = p.x`,
   `along = p.y` (vertical lines); ground `u = p.y`, `along = p.x`
   (horizontal lines). Three layers coarse→fine,
   `SCRIBBLE_LAYERS = [{8, 0.10}, {4, 0.40}, {2, 0.70}]`; each layer draws
   only where `tone > threshold`. A layer is a family of long wobbly lines:
   `idx = floor(u/S)`, `ph = hash2(idx, k)·2π`,
   `jit = (hash2(idx, k+7) − 0.5)·0.5·S`,
   `wob = 0.35·sin(along·0.16 + ph) + 0.25·sin(along·0.043 + 2·ph)`,
   `centre = (idx+0.5)·S + jit + wob`,
   `lift = hash2(idx, floor(along/24) + 3k + 40) < 0.12` → pen lifts,
   `hw = 0.28 + 0.22·tone`, `cov = 1 − smoothstep(hw−0.15, hw+0.15,
   |u − centre|)`, `ink = max(ink, cov)`.
8. **Sky tangle** (`tangleInk(px, py, density)`): three wavy families at
   fixed angles `θ = [0.12, 1.25, 2.30]`, `S = [3, 9, 7]`; per line
   `u = px·cosθ + py·sinθ`, `along = −px·sinθ + py·cosθ`,
   `idx = floor(u/S)`; line absent when `hash2(idx, 20+j) > density`
   (`skyDensity = mix(0.55, 0.22, daylight)` — night a denser tangle, noon
   sparse); `ph = hash2(idx, 30+j)·2π`,
   `wob = 2.0·sin(along·0.09 + ph) + 1.2·sin(along·0.31 + 2·ph)`,
   `cov = 1 − smoothstep(0.15, 0.45, |u − (idx+0.5)·S − wob|)`. Sky ink =
   `SKY_INK` at `coverage · 0.85`; sky wash = paper.
9. **Outline** (one-sided, with the one-CELL-apart samples): the cell is
   fully inked (`ink = 1`, `surfaceOutline`) when `isEdge(dC, [dL, dR, dU,
   dD], far)` (imported from `edges.ts`, term for term) AND `isNearSide(dC,
   dN, skyThr)` (imported from `quest.ts`) for at least one neighbour `dN`.
   Sky cells never carry an outline — the building side draws the skyline.
10. **Colour** (`inkColour(tint)`, `washColour(tint, tone)`):
    `inkCol = mix(INK, tint·0.55, satF)`;
    `washCol = mix(PAPER, tint, 0.30·satF·min(1, tone·1.5))`;
    `out = mix(washCol, inkCol, ink)`; sky = `mix(PAPER, SKY_INK,
    tangle·0.85)`.

Lit windows and neon read as bare paper with a coloured wash (tone ≈ 0),
which is the reference's look; the day-time window texture shows through as
stroke density.

## Shader notes

- **Per-pixel, not per-cell** — the strokes sample `p = vUv · grid`
  directly, so a pen line runs unbroken across cells; only the scene sample,
  the depth taps and the class use `cell = floor(p)`.
- **Depth taps** are ONE CELL apart at texel centres (`stepUv = sub·texel`),
  exactly as `lowpoly` v2 — the ticket explicitly says NOT one sub-sample
  apart like `edges.ts`.
- **Unrolled layers** — GLSL ES 1.0 unrolls constant-bound loops, so the
  three stroke layers and three tangle families are written out as literal
  blocks (`if (tone > …)` per layer), mirroring `strokeInk`/`tangleInk`
  value for value.
- **Outline reuses the shared rules** — the fragment replicates `isEdge`
  (sky disagreement / inverse-depth second difference, `k = 0.02`) and
  `isNearSide` term for term; the pure mirror composes the imported
  `isEdge` + `isNearSide` in `surfaceOutline`.
- **One uniform** — `uniform float daylight` is the only style uniform,
  seeded from `ctx.daylight` in `makeUniforms` and refreshed every frame by
  the `update` hook. `makeUniforms` creates no textures; no `dispose`.

## Pure exports (unit-tested in node)

- `SCRIBBLE_LAYERS` — the three `{ spacing, threshold }` stroke layers
  `[{8, 0.10}, {4, 0.40}, {2, 0.70}]`.
- `SLOPE_K` — `0.006`, the ground/wall depth-slope cut.
- `PAPER` — `[0.98, 0.97, 0.94]`, the white paper.
- `INK` — `[0.12, 0.10, 0.12]`, the neutral pen ink.
- `SKY_INK` — `[0.15, 0.14, 0.18]`, the dim violet-grey sky tangle ink.
- `hash2(a, b): number` — the matrix hash (`c = 0`), in `[0, 1)`.
- `surfaceClass(dC, dU, dD, far): 0 | 1 | 2` — sky / ground / wall.
- `depthFade(d): number` — `1 − 0.45·smoothstep(120, 900, d)`.
- `strokeInk(u, along, tone): number` — surface-stroke coverage in `[0, 1]`.
- `tangleInk(px, py, density): number` — sky-tangle coverage in `[0, 1]`.
- `surfaceOutline(dC, neighbours, far): boolean` — the one-sided outline
  gate (`isEdge` AND `isNearSide` over the four neighbours).
- `inkColour(tint): [r, g, b]` — `mix(INK, tint·0.55, satF)`.
- `washColour(tint, tone): [r, g, b]` — `mix(PAPER, tint,
  0.30·satF·min(1, tone·1.5))`.

## Uniforms owned by the style

| name       | shape                                    |
|------------|------------------------------------------|
| `daylight` | `uniform float daylight` (from `ctx.daylight`) |

Common uniforms (`tScene`, `grid`, `sub`, `sceneSize`, `exposure`,
`gamma`, `time`, `tDepth`, `cameraNear`, `cameraFar`) come from
`STYLE_PRELUDE`. No textures are created, so there is no `dispose`.

## What the shader does per pixel

1. `p = vUv · grid`, `cell = floor(p)`; sample, tone, tint (steps 1–3).
2. Depth taps one cell apart; classify sky / ground / wall (steps 4–5).
3. Sky cells paint the loose tangle on paper (step 8); return.
4. Non-sky: fade, surface strokes, one-sided outline (steps 6–7, 9).
5. Write `mix(washCol, inkCol, ink)` as `gl_FragColor` (alpha = 1).

Because strokes are drawn in continuous cell space and the paper reads
through as a coloured wash, the result is a hand-drawn ink sketch whose
tone comes from stroke density rather than shading.
