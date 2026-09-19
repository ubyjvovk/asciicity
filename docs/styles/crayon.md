# crayon render style

Cell **2×2**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the `crayon` look from
`docs/architecture.md` §4.11 (wave 18d, T-0148 "Pencil / crayon v3"):
**coloured pencil — the `pencil` six-rule shader with colour**. The
stroke / shading GLSL block is byte-identical; only the colour lines
differ (`groundCol = mix(G, tint, satF)`, `strokeCol`, wash colour
`mix(G, tint, satF)`). The sky is paper — the blue pencil dome is
gone. Water smudges blue.

**The stroke machinery is shared** — the GLSL helpers (`hash2`,
`viewPos`, `viewNormal`, `strokeCoords`, `strokeScale`, `wobble`,
`lifted`, `strokeLayer`, `nestedStrokeInk`, `hairInk`, `skyCoords`,
`depthFade`), the `Surf` struct and `surfaceAt(vec2 uv)`, `outlineAt`,
`toothOf`, `vnoiseA`, `anchoredNoise`, and their TS mirrors live in
`src/render/styles/strokes.ts` (`STROKE_GLSL`); see
**`docs/styles/strokes.md`**. This file documents only what is
crayon-specific: the colours, the two pure mirrors (`crayonStroke`,
`crayonWash`), the re-exported `roughSmudge` / `smearGate` /
`wallWashRough` / `hatchGate` / `facadeDir` (from `pencil`), and the
fragment `main()`.

## The six rules (per pixel)

`p = vUv · grid`; `cell = floor(p)`; `Surf s = surfaceAt(vUv)`;
`g = toothOf(s)`. Stroke / shading is the same GLSL as `pencil` (the
RULES markers). After that block, crayon colours the mix:

    tint  = tintOf(meanC)            // 3×3 mean, not the per-cell sample
    satF  = smoothstep(0.10, 0.45, max(tint) − min(tint))
    groundCol = mix(G, tint, satF)
    washCol   = mix(G, tint, satF)
    strokeCol = mix(G, tint·0.60, 0.85·satF)     // crayonStroke
    out = mix(PAPER_P, s.cls == 1 ? groundCol : washCol, s.cls == 1 ? shade : wash)
    if s.cls == 2: out = mix(out, strokeCol, ink)
    out = mix(out, G, strength · e)              // outline stays graphite

**1. Sky = paper.** `out = PAPER_P`. No hair, no blue/violet wash.

**2. Horizontal surfaces** (`s.cls == 1`) = paper + rough smudge (no
hatch). Same `sm` / `n1` / `n2` / `skip` / `smudge` / `smear` /
`grain` / `shade` as pencil; mixed toward `groundCol` instead of
graphite, so water smudges blue.

    sm     = smoothstep(0.12, 0.85, toneS)
    n1     = vnoiseA(u, along, mu, ma, 14, 8)
    n2     = vnoiseA(u, along / 7, mu, ma / 7, 5, 9)
    skip   = smoothstep(0.72, 0.85, n1)
    smudge = sm · (0.20 + 0.65 · n1) · (0.55 + 0.45 · n2) · (1 − skip) · g
    smear  = nestedStrokeInk(s.u, s.along, toneS · 0.8, mu, ma, 1.0, 0.5, 1.5) · 0.30 · n1
    grain  = 0.12 · sm · anchoredNoise(u, along, mu, ma, 1.0, 10)
    shade  = clamp(smudge + smear + grain, 0, 0.75)
    out    = mix(PAPER_P, groundCol, shade)

**3. Smoothed tone.** `toneS = (1 − shaped(bright(mean of sampleSub over
the 3×3 cell neighbourhood))) · depthFade(s.dC)`. The per-cell tone is
used nowhere else; crayon's `tint` / `satF` also read `meanC`.

**4. Walls** = white + roughened wash + hatch only in the dark; **one
direction per facade** (`facadeDir` / `hash2` on `nW` and `W`). Wash
is `0.35 · g · smoothstep(0.20, 0.90, toneS) · (0.55 + 0.45 · n1w)`
with `n1w = vnoiseA(u, along, mu, ma, 10, 11)`. Same hatch formula as
pencil (`nestedStrokeInk` × `hatchGate`, widths `0.45, 0.25, 0.60`);
mixed toward `strokeCol` over `washCol`. No second family.

**5. Contrasting edges.** `e = max` of `outlineAt` over the cell and
its 4 neighbours. Any neighbour sky (`linearDepth` at the four neighbour
cell centres ≥ `0.98 · cameraFar`) → strength 1.0, crease → 0.7.
Outline colour is `G`. Ground cells keep their outline.

**6. Grain `g = toothOf(s)`, `depthFade`, outline `G` unchanged.**

## Shader notes

- **Pencil strokes, crayon colours** — the 9-tap tone, rough smudge,
  rough wash, one-direction hatch, 2-cell outline and silhouette
  strength are exactly the `pencil` RULES block; only `groundCol`,
  `strokeCol` and wash colour `mix(G, tint, satF)` carry the hue.
- **Grain only** — crayon uses the chunk's `toothOf(s)`, `vnoiseA` and
  `anchoredNoise` (via the shared RULES block), not `blotchA`. The tooth
  rides the surfaces (sky is paper, so the dome tooth is unused).
- **Chunk + fragment** — `fragment: STROKE_GLSL + CRAYON_FRAGMENT`:
  the shared machinery (`docs/styles/strokes.md`) plus crayon's
  constants (`PAPER_P`, `G`), the `daylight` uniform and `main()`.
- **One uniform** — `uniform float daylight` is the only style uniform,
  seeded from `ctx.daylight` in `makeUniforms` and refreshed every frame
  by the `update` hook. Unused in v3 (the sky is paper).
  `makeUniforms` creates no textures; no `dispose`. Prelude uniforms
  (`viewUp`, `tanHalfFov`, `viewToWorld`) are never redeclared.

## Pure exports (unit-tested in node)

The stroke machinery is in `src/render/styles/strokes.ts` — see
`docs/styles/strokes.md` and `tests/styles/strokes.test.ts`. Crayon
keeps:

- `PAPER_P` — `[0.97, 0.96, 0.93]`, the white paper (shared with
  `pencil`).
- `G` — `[0.22, 0.22, 0.25]`, the graphite dark: stroke colour for grey
  things and the outline colour.
- `crayonStroke(tint, satF): [r, g, b]` — `mix(G, tint·0.60,
  0.85·satF)` per channel.
- `crayonWash(tone, satF): number` — `0.45·satF·tone^0.7 +
  0.20·(1−satF)·tone` (kept; v1 wash strength).
- `roughSmudge`, `smearGate`, `wallWashRough`, `hatchGate`,
  `facadeDir` — re-exported from `pencil` (`toBe` identity).

## Uniforms owned by the style

| name       | shape                                    |
|------------|------------------------------------------|
| `daylight` | `uniform float daylight` (from `ctx.daylight`) |

Common uniforms (`tScene`, `grid`, `sub`, `sceneSize`, `exposure`,
`gamma`, `time`, `tDepth`, `cameraNear`, `cameraFar`, `viewUp`,
`tanHalfFov`, `viewToWorld`) come from `STYLE_PRELUDE`; the shader reads
them and never redeclares them. No textures are created, so there is no
`dispose`.

## What the shader does per pixel

1. `p = vUv · grid`; `Surf s = surfaceAt(vUv)`; `g = toothOf(s)`.
2. Sky cells write `PAPER_P` and return.
3. 3×3 `sampleSub` mean → `toneS`; rough smudge / rough wash /
   one-direction hatch / 2-cell outline (the shared RULES block).
4. Colour: `groundCol = washCol = mix(G, tint, satF)`,
   `strokeCol = crayonStroke`; mix paper → ground/wash → stroke →
   graphite outline.
5. Write `out` as `gl_FragColor` (alpha = 1).

Expected frame: a coloured-pencil drawing on mostly white paper;
buildings as tinted contour drawings with soft coloured shading and
hatching in the shadowed facades, one stroke direction per facade;
roads, water and roofs with rough uneven tinted smudge (water blue);
a blank sky.
