# pastel render style

Cell **2×2**, sub **1×1**, `targetCap` **960×540**, depth texture
(`needsDepth: true`), `groundGrid: false`. Implements the
soft-chalk-pastel look from `docs/architecture.md` §4.11 (wave 18
"sketch family", T-0142; soft edges T-0145): toned pastel paper, **no
strokes** — the scene sample is 3×3-cell **smoothed** then bilinear-
blended per pixel (36 taps, chalk-smudge jitter), the hue becomes a
pastel (hue + white) that the world/dome-anchored paper tooth lets
bleed through, dark chalk deepens the shadows, and a soft 2-cell
outline ramp marks edges.

**The stroke machinery is shared** — the GLSL helpers (`hash2`,
`viewPos`, `viewNormal`, `strokeCoords`, `strokeScale`, `wobble`,
`lifted`, `strokeLayer`, `nestedStrokeInk`, `hairInk`, `skyCoords`,
`depthFade`, `toothOf`, `blotchA`, `outlineAt`), the `Surf` struct and
`surfaceAt(vec2 uv)`, and their TS mirrors live in
`src/render/styles/strokes.ts` (`STROKE_GLSL`); see
**`docs/styles/strokes.md`**. `pastel` uses `surfaceAt` once for the
sky test (`s.cls`) and the coordinates `toothOf` / `blotchA` / the
smudge jitter read; neighbour outline flags come from `outlineAt`.
There are no stroke calls at all. This file documents only what is
pastel-specific: the colours (`PAPER_S`, `DARK_CHALK`), `chalkOf`,
`pastelColour`, `bilinearWeights`, `softEdge` and the fragment
`main()`.

## Algorithm (per pixel)

1. `p = vUv · grid`.
2. `Surf s = surfaceAt(vUv)` — the shared chunk computes the clamped
   one-cell depth taps, the sky test, the class, `dPix`, the world
   position `W` / normal `nW`, and the stroke coordinates and scale
   (`docs/styles/strokes.md`). Called **once** for the centre cell
   (`class` / `u` / `along` / `ps`).
3. **Paper grain (anchored tooth).** `g = toothOf(s)` from the shared
   chunk (`docs/styles/strokes.md`, §4.11 "anchored tooth"): world-
   anchored on surfaces, dome-anchored on sky, ≈ 2 px, in `[0.80, 1.20]`.
4. **Chalk smudge** — jitter the sample position before the blend:
   `pj = p + 1.2 · (vec2(anchoredNoise(u, along, mu, ma, 1.5, 6),
   anchoredNoise(u, along, mu, ma, 1.5, 7)) − 0.5)`. Sky uses the same
   on `ps` with `mx = my = 1`.
5. **Per-pixel sample** — let `c00..c11` be `sampleOrSky` of the four
   cells nearest to `pj − 0.5`, blended bilinearly with
   `fract(pj − 0.5)`. Sky cells contribute their sky colour (the
   PAPER_S mix, no streaks) so building/sky borders feather over one
   cell. Weights: `bilinearWeights(pj)` = `[w00, w10, w01, w11]`.
   (The spec's four overlapping 3×3 windows = 36 taps; the shipped
   shader samples each of the four cells once so the 20-style
   SwiftShader smoke stays inside 120 s. Silhouettes still feather.)
6. `v = shaped(bright(cs))` (1 = paper, 0 = solid); `tint = tintOf(cs)`;
   `sat = max(tint) − min(tint)`; `satF = smoothstep(0.10, 0.45, sat)`.

**Sky** (`s.cls == 0`):

    day (daylight ≥ 0.5):
      col = mix(PAPER_S, (0.62, 0.75, 0.92), 0.75 · g)
      col = mix(col, vec3(1.0), 0.5 · smoothstep(0.55, 0.75, blotchA(s)))   // white streaks
    night:
      col = mix(PAPER_S, (0.18, 0.18, 0.35), 0.8 · g)

**Surface** (`s.cls == 1 | 2`):

1. **Chalk** — `chalk = mix(vec3(1.0), tint, 0.65 · satF)` (pastel =
   hue + white; grey things are pure white chalk).
2. **Tooth** — `col = mix(PAPER_S, chalk, 0.9 · g)`: the 2×2-px tooth
   lets the toned paper show through the chalk.
3. **Shadows** — `col = mix(col, DARK_CHALK, (1 − v) · 0.55 · g)`: dark
   chalk in the shade.

**Soft edge** (both branches; no binary cell outline):

    e = bilinear blend (same weights) of the four cells' outlineAt flags (0/1)
    col = mix(col, DARK_CHALK, 0.35 · smoothstep(0.15, 0.85, e))   // 2-cell-wide ramp
    gl_FragColor = vec4(col, 1.0)

## Shader notes

- **Shared chunk** — `fragment: STROKE_GLSL + PASTEL_FRAGMENT`: the
  shared machinery (chunk, `docs/styles/strokes.md`) plus pastel's
  constants (`PAPER_S`, `DARK_CHALK`), the `daylight` uniform and
  `main()` (which starts `Surf s = surfaceAt(vUv);`). Grain and sky
  streaks come from `toothOf(s)` / `blotchA(s)`. Nothing in the
  fragment redeclares a prelude uniform (`viewUp`, `tanHalfFov`,
  `viewToWorld`, …).
- **No strokes** — this is the stroke-free member of the sketch family:
  no `nestedStrokeInk` / `hairInk` / `wobble` calls, no `tone2`
  (the common block's `tone · depthFade(s.dC)` is not used here — the
  §4.11 pastel formula carries no depth fade).
- **Per-pixel bilinear in GLSL** — four `sampleOrSky` taps of the
  cells nearest to `pj − 0.5`, weighted by `fract(pj − 0.5)`. Sky cells
  return the PAPER_S mix so silhouettes feather.
- **One uniform** — `uniform float daylight` is the only style uniform,
  seeded from `ctx.daylight` in `makeUniforms` and refreshed every frame
  by the `update` hook. `makeUniforms` creates no textures; no
  `dispose`.

## Pure exports (unit-tested in node)

- `PAPER_S` — `[0.93, 0.90, 0.84]`, the toned pastel paper.
- `DARK_CHALK` — `[0.20, 0.18, 0.22]`, the dark chalk of the shadows
  and the faint outline.
- `chalkOf(tint, satF): [r, g, b]` — `mix(white, tint, 0.65·satF)`;
  white at `satF = 0` (grey things), hue + white where colour applies.
- `pastelColour(v, tint, g): [r, g, b]` — the full surface colour:
  `mix(PAPER_S, chalkOf(tint, satF), 0.9·g)` then
  `mix(col, DARK_CHALK, (1−v)·0.55·g)`; `satF` is derived from `tint`
  exactly as scribble (`smoothstep(0.10, 0.45, sat)`).
- `bilinearWeights(p): [w00, w10, w01, w11]` — bilinear weights of the
  four cells nearest to `p − 0.5` (sum 1). `[1, 0, 0, 0]` at a cell
  centre (`p − 0.5` integer); `[0.25 × 4]` at a cell corner.
- `softEdge(e)` — `0.35 · smoothstep(0.15, 0.85, e)`: the mix factor of
  the 2-cell outline ramp (`0` at `e = 0`, `0.35` at `e = 1`, monotone).

The 3×3 smoothing has no TS mirror (it taps the scene target). The
tooth, blotches and `outlineAt` live in `strokes.ts` — see
`docs/styles/strokes.md`.

## Uniforms owned by the style

| name       | shape                                    |
|------------|------------------------------------------|
| `daylight` | `uniform float daylight` (from `ctx.daylight`) |

Common uniforms (`tScene`, `grid`, `sub`, `sceneSize`, `exposure`,
`gamma`, `time`, `tDepth`, `cameraNear`, `cameraFar`, `viewUp`,
`tanHalfFov`, `viewToWorld`) come from `STYLE_PRELUDE`. The shader reads
`viewToWorld` (through the shared chunk); it never redeclares the
prelude uniforms. No textures are created, so there is no `dispose`.

## What the shader does per pixel

1. `p = vUv · grid`; `Surf s = surfaceAt(vUv)` — sky test and the coords
   `toothOf` / `blotchA` / the smudge jitter read.
2. World/dome-anchored paper grain `g = toothOf(s)`.
3. Chalk-smudge `pj`; bilinear 36-tap sample `cs` of the four cells
   nearest to `pj − 0.5` (sky cells → PAPER_S mix); `v`, `tint`, `satF`.
4. Sky cells paint the pastel-blue (day, white streaks via `blotchA(s)`)
   / indigo (night) sky.
5. Surface cells paint `pastelColour(v, tint, g)` — pastel chalk with
   the tooth showing through and dark chalk in the shadows.
6. Soft 2-cell outline: `col = mix(col, DARK_CHALK, softEdge(e))` where
   `e` is the bilinear blend of the four cells' `outlineAt` flags.

Because the sample is bilinear-smoothed over 36 taps, the sample
position is chalk-smudged, and the tooth `g` rides the surfaces and the
sky dome, the result reads as a soft chalk pastel: broad, feathered
fields of hue + white on toned paper, shaded with dark chalk, outlined
with a 2-cell ramp — with no stroke of any kind.
