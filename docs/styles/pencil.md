# pencil render style

Cell **2×2**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the graphite **rough-smudged sketch**
look from `docs/architecture.md` §4.11 (wave 18d, T-0148 "Pencil /
crayon v3"): mostly white paper, sparse smudged sky patches (heavier
at the horizon), contrasting edges, rough uneven shading on
horizontals (the opposite of even thatch), hatch only in dark facades,
one stroke direction per facade.

**The stroke machinery is shared** — the GLSL helpers (`hash2`,
`viewPos`, `viewNormal`, `strokeCoords`, `strokeScale`, `wobble`,
`lifted`, `strokeLayer`, `nestedStrokeInk`, `hairInk`, `skyCoords`,
`depthFade`), the `Surf` struct and `surfaceAt(vec2 uv)`, `outlineAt`,
`toothOf`, `vnoiseA`, `anchoredNoise`, and their TS mirrors live in
`src/render/styles/strokes.ts` (`STROKE_GLSL`); see
**`docs/styles/strokes.md`**. This file documents only what is
pencil-specific: the colours (`PAPER_P`, `G`), `pencilWash`,
`crossCoords`, `roughSmudge`, `smearGate`, `wallWashRough`,
`skyShadeOf`, `hatchGate`, `facadeDir` and the fragment `main()`. The
stroke / shading GLSL block (the RULES markers) is byte-identical in
`crayon.ts`.

## The six rules (per pixel)

`p = vUv · grid`; `cell = floor(p)`; `Surf s = surfaceAt(vUv)`;
`g = toothOf(s)`.

**1. Sky = paper + a few smudged patches** (heavier toward the
horizon). Dome-anchored on `s.ps` (scale 1); no hair:

    n1s      = vnoiseA(ps.x, ps.y, 1, 1, 30, 12)                 // big patches, 30 cells
    n2s      = vnoiseA(ps.x, ps.y / 6, 1, 1 / 6, 6, 13)           // sideways smear
    horiz    = 1 − smoothstep(0.05, 0.45, clamp(s.dirW.y, 0, 1)) // 1 at the horizon, 0 high up
    skyShade = 0.22 · smoothstep(0.58, 0.85, n1s) · (0.55 + 0.45 · n2s) · (0.35 + 0.65 · horiz) · g
    out      = mix(PAPER_P, skyCol, skyShade)                    // skyCol = G

**2. Horizontal surfaces** (`s.cls == 1`: ground, roofs, bus tops) =
paper + rough smudge (no hatch). Uneven patches, a sideways smear,
soft wide strokes, grain:

    sm     = smoothstep(0.35, 0.95, toneS)
    n1     = vnoiseA(u, along, mu, ma, 14, 8)                 // big uneven patches (14 cells)
    n2     = vnoiseA(u, along / 7, mu, ma / 7, 5, 9)          // smear: 5 cells across, 35 along
    skip   = smoothstep(0.55, 0.75, n1)                       // patches the thumb missed
    smudge = 0.60 · sm · (0.20 + 0.65 · n1) · (0.55 + 0.45 · n2) · (1 − skip) · g
    smear  = nestedStrokeInk(s.u, s.along, toneS · 0.8, mu, ma, 1.0, 0.5, 1.5)
             · 0.12 · smoothstep(0.5, 0.8, n1)                                      // faint, patchy
    grain  = 0.12 · sm · anchoredNoise(u, along, mu, ma, 1.0, 10)
    shade  = clamp(smudge + smear + grain, 0, 0.55)            // never solid
    out    = mix(PAPER_P, groundCol, shade)                   // groundCol = G

**3. Smoothed tone.** The per-cell sample is used nowhere. `toneS` is
the 3×3 neighbourhood mean of `sampleSub` (9 taps), then:

    toneS = (1 − shaped(bright(meanC))) · depthFade(s.dC)

Window-grid noise averages away.

**4. Walls** (`s.cls == 2`) = white + roughened wash + hatch only in
the dark.

    n1w   = vnoiseA(u, along, mu, ma, 10, 11)
    wash  = 0.35 · g · smoothstep(0.20, 0.90, toneS) · (0.55 + 0.45 · n1w)
    hatch = nestedStrokeInk(u1, along1, toneS, mu1, ma1, 0.45, 0.25, 0.60)
            · smoothstep(0.50, 0.75, toneS)                                // strokes only where dark
            · (1 − smoothstep(150, 400, dC))                               // far walls: outline only
    ONE direction per facade:
      sel = hash2(floor(nW.x·4) + floor(nW.z·4)·9, floor((W.x + W.z) / 40))
      sel < 0.5 → vertical family (u1, along1, mu1, ma1) = (s.u, s.along, s.mu, s.ma)
      else      → 45° family     (u1, along1) = crossCoords(s.u, s.along)
                                  mu1 = ma1 = (s.mu + s.ma) / 2
    no second family anywhere (cross-hatch deleted)
    ink = hatch · (0.60 + 0.30 · toneS)
    out = mix(mix(PAPER_P, G, wash), G, ink)

**5. Contrasting edges.** `e = max` of `outlineAt` over the cell and
its 4 neighbours (2-cell line). Neighbour-is-sky is `linearDepth` at
the four neighbour cell centres (one cell apart, as `surfaceAt` does)
compared with `0.98 · cameraFar`. Silhouette against sky → strength
1.0, crease → 0.7:

    out = mix(out, G, strength · e)

Ground cells also draw their outline (building bases, kerbs) —
outlines are the one thing horizontal surfaces keep on top of the
smudge.

**6. Everything else** unchanged: grain `g = toothOf(s)`, `depthFade`,
outline colour `G`. Pencil hatch widths stay `0.45, 0.25, 0.60`.

## Shader notes

- **Shared chunk** — `fragment: STROKE_GLSL + PENCIL_FRAGMENT`: the
  shared machinery plus pencil's constants (`PAPER_P`, `G`), the
  `daylight` uniform and `main()`. Nothing in the fragment redeclares
  a prelude uniform. The `daylight` uniform is kept (seeded /
  refreshed) but unused in v3 — the sky is paper + graphite patches.
- **RULES markers** — the stroke / shading GLSL between the RULES
  markers is byte-identical in `crayon.ts`. Colour-side variables the
  block reads: `skyCol = G` (before the markers). After it, pencil:
  `groundCol = G`, `washCol = G`, `strokeCol = G`.
- **9-tap tone** — `meanC` is the mean of `sampleSub` over the 3×3 cell
  neighbourhood (`ox, oy ∈ {−1, 0, 1}`).
- **Anisotropic smear** — `n2` passes `along / 7` and `ma / 7` so the
  thumb-rub is 5 cells across and 35 along (constant-depth direction).
- **One direction** — `crossCoords` is inlined on the 45° branch:
  `1/√2` is the literal `0.70710678`. There is no second family.
- **One uniform** — `uniform float daylight` is the only style uniform,
  seeded from `ctx.daylight` in `makeUniforms` and refreshed every frame
  by the `update` hook. `makeUniforms` creates no textures; no `dispose`.

## Pure exports (unit-tested in node)

- `PAPER_P` — `[0.97, 0.96, 0.93]`, the warm white paper.
- `G` — `[0.22, 0.22, 0.25]`, the graphite.
- `pencilWash(tone, g): number` — `tone · 0.55 · g` (kept; v1 wash).
- `crossCoords(u, along, mu, ma): { u, along, mu, ma }` — the 45°-rotated
  stroke space: `u2 = (u + along)/√2`, `along2 = (along − u)/√2`,
  `mu2 = ma2 = (mu + ma)/2`. Orthogonal, so `u2² + along2² = u² + along²`.
- `roughSmudge(toneS, n1, n2, g): number` — `0.60 · sm · (0.20 + 0.65 · n1) ·
  (0.55 + 0.45 · n2) · (1 − skip) · g` with `sm = smoothstep(0.12, 0.85,
  toneS)` and `skip = smoothstep(0.55, 0.75, n1)` (`roughSmudge(0, ·, ·,
  1) → 0`; monotone in toneS; `roughSmudge(1, 0.9, 1, 1) → 0` (skip);
  `roughSmudge(1, 0.5, 0.5, 1) → 0.407`).
- `smearGate(n1): number` — `0.30 · n1`.
- `wallWashRough(toneS, g, n1w): number` — `0.35 · g · smoothstep(0.20,
  0.90, toneS) · (0.55 + 0.45 · n1w)` (`wallWashRough(1, 1, 0) → 0.1925`,
  `(1, 1, 1) → 0.35`).
- `skyShadeOf(n1s, n2s, horiz, g): number` — `0.22 · smoothstep(0.58,
  0.85, n1s) · (0.55 + 0.45 · n2s) · (0.35 + 0.65 · horiz) · g`
  (`skyShadeOf(0.5, ·, ·, 1) → 0`; `skyShadeOf(1, 1, 1, 1) → 0.22`;
  `skyShadeOf(1, 1, 0, 1) → 0.077`).
- `hatchGate(toneS, dC): number` — `smoothstep(0.50, 0.75, toneS) ·
  (1 − smoothstep(150, 400, dC))` (`hatchGate(1, 0) → 1`,
  `hatchGate(1, 400) → 0`, `hatchGate(0.5, 0) → 0`).
- `facadeDir(nW, W): 0 | 1` — `0` vertical, `1` 45°; deterministic;
  takes both values over 100 random inputs.

`smudgeOf` / `wallWash` of T-0147 are deleted (superseded). Crayon
re-exports the v3 pures (`toBe` identity).

## Uniforms owned by the style

| name       | shape                                    |
|------------|------------------------------------------|
| `daylight` | `uniform float daylight` (from `ctx.daylight`) |

Common uniforms (`tScene`, `grid`, `sub`, `sceneSize`, `exposure`,
`gamma`, `time`, `tDepth`, `cameraNear`, `cameraFar`, `viewUp`,
`tanHalfFov`, `viewToWorld`) come from `STYLE_PRELUDE`. The shader reads
`tanHalfFov` and `viewToWorld` (through the shared chunk); it never
redeclares them. No textures are created, so there is no `dispose`.

## What the shader does per pixel

1. `p = vUv · grid`, `cell = floor(p)`; `Surf s = surfaceAt(vUv)`;
   world-anchored paper grain `g = toothOf(s)`.
2. Sky cells mix paper toward `skyCol` (`G`) by `skyShadeOf` and return.
3. `toneS` from the 3×3 `sampleSub` mean × `depthFade`.
4. Horizontals mix paper toward `groundCol` (`G`) by `shade`
   (`roughSmudge` + smear + grain, clamped to 0.75); walls mix paper
   toward graphite by `wallWashRough`, then hatch in one facade
   direction gated by `hatchGate`.
5. 2-cell `outlineAt` max, silhouette strength 1.0 / crease 0.7;
   `out = mix(out, G, strength · e)`.

Expected frame: mostly white paper; buildings as dark contour drawings
with soft grey shading and hatching in the shadowed facades, one stroke
direction per facade; roads, water and roofs with rough uneven smudged
shading (never a solid thatch); a paper sky with a few smudged patches,
heavier toward the horizon.
