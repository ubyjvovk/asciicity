# pencil render style

Cell **2×2**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the graphite **quick-drawing** look from
`docs/architecture.md` §4.11 (wave 18c, T-0147 "Pencil / crayon v2"):
mostly white paper, contrasting edges, soft shading here and there, no
uniform thatch, one stroke direction per facade. The hair sky and the
lines on every horizontal surface are gone.

**The stroke machinery is shared** — the GLSL helpers (`hash2`,
`viewPos`, `viewNormal`, `strokeCoords`, `strokeScale`, `wobble`,
`lifted`, `strokeLayer`, `nestedStrokeInk`, `hairInk`, `skyCoords`,
`depthFade`), the `Surf` struct and `surfaceAt(vec2 uv)`, `outlineAt`,
`toothOf`, and their TS mirrors live in `src/render/styles/strokes.ts`
(`STROKE_GLSL`); see **`docs/styles/strokes.md`**. This file documents
only what is pencil-specific: the colours (`PAPER_P`, `G`), `pencilWash`,
`crossCoords`, `smudgeOf`, `wallWash`, `hatchGate`, `facadeDir` and the
fragment `main()`. The stroke / shading GLSL block (the RULES markers)
is byte-identical in `crayon.ts`.

## The six rules (per pixel)

`p = vUv · grid`; `cell = floor(p)`; `Surf s = surfaceAt(vUv)`;
`g = toothOf(s)`.

**1. Sky = paper.** `s.cls == 0` → `out = PAPER_P`. No hair, no wash.

**2. Horizontal surfaces** (`s.cls == 1`: ground, roofs, bus tops) =
paper + smudge only. No strokes at all.

    smudge = 0.30 · g · smoothstep(0.55, 0.95, toneS)     // shadow pools only
    out    = mix(PAPER_P, G, smudge)

**3. Smoothed tone.** The per-cell sample is used nowhere. `toneS` is
the 3×3 neighbourhood mean of `sampleSub` (9 taps), then:

    toneS = (1 − shaped(bright(meanC))) · depthFade(s.dC)

Window-grid noise averages away.

**4. Walls** (`s.cls == 2`) = white + wash + hatch only in the dark.

    wash  = 0.35 · g · smoothstep(0.20, 0.90, toneS)                      // soft shading
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
outlines are the one thing horizontal surfaces keep.

**6. Everything else** unchanged: grain `g = toothOf(s)`, `depthFade`,
outline colour `G`. Pencil widths stay `0.45, 0.25, 0.60`.

## Shader notes

- **Shared chunk** — `fragment: STROKE_GLSL + PENCIL_FRAGMENT`: the
  shared machinery plus pencil's constants (`PAPER_P`, `G`), the
  `daylight` uniform and `main()`. Nothing in the fragment redeclares
  a prelude uniform. The `daylight` uniform is kept (seeded /
  refreshed) but unused in v2 — the sky is paper.
- **RULES markers** — the stroke / shading GLSL between the RULES
  markers is byte-identical in `crayon.ts`. Only the colour lines after
  it differ (pencil: `washCol = G`, `strokeCol = G`).
- **9-tap tone** — `meanC` is the mean of `sampleSub` over the 3×3 cell
  neighbourhood (`ox, oy ∈ {−1, 0, 1}`).
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
- `smudgeOf(toneS, g): number` — `0.30 · g · smoothstep(0.55, 0.95, toneS)`
  (`smudgeOf(0.5, 1) → 0`, `smudgeOf(1, 1) → 0.30`).
- `wallWash(toneS, g): number` — `0.35 · g · smoothstep(0.20, 0.90, toneS)`.
- `hatchGate(toneS, dC): number` — `smoothstep(0.50, 0.75, toneS) ·
  (1 − smoothstep(150, 400, dC))` (`hatchGate(1, 0) → 1`,
  `hatchGate(1, 400) → 0`, `hatchGate(0.5, 0) → 0`).
- `facadeDir(nW, W): 0 | 1` — `0` vertical, `1` 45°; deterministic;
  takes both values over 100 random inputs.

`groundTone` / `crossGate` of T-0146 are deleted (superseded). Crayon
re-exports the four v2 pures (`toBe` identity).

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
2. Sky cells write `PAPER_P` and return.
3. `toneS` from the 3×3 `sampleSub` mean × `depthFade`.
4. Horizontals mix paper toward graphite by `smudgeOf`; walls mix paper
   toward graphite by `wallWash`, then hatch in one facade direction
   gated by `hatchGate`.
5. 2-cell `outlineAt` max, silhouette strength 1.0 / crease 0.7;
   `out = mix(out, G, strength · e)`.

Expected frame: mostly white paper; buildings as dark contour drawings
with soft grey shading and hatching in the shadowed facades, one stroke
direction per facade; roads and roofs blank with a little shadow pooling
at building feet; a blank sky.
