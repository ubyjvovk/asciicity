# crayon render style

Cell **2×2**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the `crayon` look from
`docs/architecture.md` §4.11 (wave 18c, T-0147 "Pencil / crayon v2"):
**coloured pencil — the `pencil` six-rule shader with colour**. The
stroke / shading GLSL block is byte-identical; only the colour lines
differ (`strokeCol`, wash colour `mix(G, tint, satF)`). The sky is
paper — the blue pencil dome is gone.

**The stroke machinery is shared** — the GLSL helpers (`hash2`,
`viewPos`, `viewNormal`, `strokeCoords`, `strokeScale`, `wobble`,
`lifted`, `strokeLayer`, `nestedStrokeInk`, `hairInk`, `skyCoords`,
`depthFade`), the `Surf` struct and `surfaceAt(vec2 uv)`, `outlineAt`,
`toothOf`, and their TS mirrors live in `src/render/styles/strokes.ts`
(`STROKE_GLSL`); see **`docs/styles/strokes.md`**. This file documents
only what is crayon-specific: the colours, the two pure mirrors
(`crayonStroke`, `crayonWash`), the re-exported `smudgeOf` / `wallWash`
/ `hatchGate` / `facadeDir` (from `pencil`), and the fragment `main()`.

## The six rules (per pixel)

`p = vUv · grid`; `cell = floor(p)`; `Surf s = surfaceAt(vUv)`;
`g = toothOf(s)`. Stroke / shading is the same GLSL as `pencil` (the
RULES markers). After that block, crayon colours the mix:

    tint  = tintOf(meanC)            // 3×3 mean, not the per-cell sample
    satF  = smoothstep(0.10, 0.45, max(tint) − min(tint))
    washCol   = mix(G, tint, satF)
    strokeCol = mix(G, tint·0.60, 0.85·satF)     // crayonStroke
    out = mix(PAPER_P, washCol, s.cls == 1 ? smudge : wash)
    if s.cls == 2: out = mix(out, strokeCol, ink)
    out = mix(out, G, strength · e)              // outline stays graphite

**1. Sky = paper.** `out = PAPER_P`. No hair, no blue/violet wash.

**2. Horizontal surfaces** (`s.cls == 1`) = paper + smudge only. No
strokes. `smudge = 0.30 · g · smoothstep(0.55, 0.95, toneS)`; mixed
toward `washCol` instead of graphite.

**3. Smoothed tone.** `toneS = (1 − shaped(bright(mean of sampleSub over
the 3×3 cell neighbourhood))) · depthFade(s.dC)`. The per-cell tone is
used nowhere else; crayon's `tint` / `satF` also read `meanC`.

**4. Walls** = white + wash + hatch only in the dark; **one direction
per facade** (`facadeDir` / `hash2` on `nW` and `W`). Same hatch
formula as pencil (`nestedStrokeInk` × `hatchGate`, widths
`0.45, 0.25, 0.60`); mixed toward `strokeCol` over `washCol`. No second
family.

**5. Contrasting edges.** `e = max` of `outlineAt` over the cell and
its 4 neighbours. Any neighbour sky (`linearDepth` at the four neighbour
cell centres ≥ `0.98 · cameraFar`) → strength 1.0, crease → 0.7.
Outline colour is `G`. Ground cells keep their outline.

**6. Grain `g = toothOf(s)`, `depthFade`, outline `G` unchanged.**

## Shader notes

- **Pencil strokes, crayon colours** — the 9-tap tone, smudge, wash,
  one-direction hatch, 2-cell outline and silhouette strength are
  exactly the `pencil` RULES block; only `strokeCol` and wash colour
  `mix(G, tint, satF)` carry the hue.
- **Grain only** — crayon uses the chunk's `toothOf(s)`, not
  `blotchA`/`vnoiseA`. The tooth rides the surfaces (sky is paper, so
  the dome tooth is unused).
- **Chunk + fragment** — `fragment: STROKE_GLSL + CRAYON_FRAGMENT`:
  the shared machinery (`docs/styles/strokes.md`) plus crayon's
  constants (`PAPER_P`, `G`), the `daylight` uniform and `main()`.
- **One uniform** — `uniform float daylight` is the only style uniform,
  seeded from `ctx.daylight` in `makeUniforms` and refreshed every frame
  by the `update` hook. Unused in v2 (the sky is paper).
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
- `smudgeOf`, `wallWash`, `hatchGate`, `facadeDir` — re-exported from
  `pencil` (`toBe` identity).

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
3. 3×3 `sampleSub` mean → `toneS`; smudge / wash / one-direction hatch /
   2-cell outline (the shared RULES block).
4. Colour: `washCol = mix(G, tint, satF)`, `strokeCol = crayonStroke`;
   mix paper → wash → stroke → graphite outline.
5. Write `out` as `gl_FragColor` (alpha = 1).

Expected frame: a coloured-pencil drawing on mostly white paper;
buildings as tinted contour drawings with soft coloured shading and
hatching in the shadowed facades, one stroke direction per facade;
roads and roofs blank with a little shadow pooling; a blank sky.
