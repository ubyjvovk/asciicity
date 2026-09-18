# pencil render style

Cell **2×2**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the graphite-pencil-sketch look from
`docs/architecture.md` §4.11 (wave 18 "sketch family", T-0140): warm
paper, a smudged tone *wash* whose strength follows the paper tooth,
world-anchored strokes with wider, softer pencil widths, a 45°
cross-hatch family on walls (none on the ground), soft one-sided
graphite outlines and a pencilled sky.

**The stroke machinery is shared** — the GLSL helpers (`hash2`,
`viewPos`, `viewNormal`, `strokeCoords`, `strokeScale`, `wobble`,
`lifted`, `strokeLayer`, `nestedStrokeInk`, `hairInk`, `skyCoords`,
`depthFade`), the `Surf` struct and `surfaceAt(vec2 uv)`, and their TS
mirrors live in `src/render/styles/strokes.ts` (`STROKE_GLSL`); see
**`docs/styles/strokes.md`**. This file documents only what is
pencil-specific: the colours (`PAPER_P`, `G`), `pencilWash`,
`crossCoords`, `groundTone`, `crossGate` and the fragment `main()`
(which starts with `Surf s = surfaceAt(vUv);`).

## Algorithm (per pixel)

The scene sample is **per cell** (`cell = floor(vUv · grid)`):
`c = sampleSub(cell, 0, 0)`; `v = shaped(bright(c))`; `tone = 1 − v`
(0 = paper, 1 = solid ink). The common block's `tint = tintOf(c)` and
`satF = smoothstep(0.10, 0.45, sat)` are unused here — pencil is
graphite, the one ink of the style — and are not declared (GLSL ES 1.0
has no `void` expression to keep them). Everything about the surface — the depth taps, the class, `dPix`,
the world position `W`, the stroke coordinates and scale, the one-sided
outline — is computed once per pixel by the shared chunk's
`Surf s = surfaceAt(vUv)` (`docs/styles/strokes.md`), and
`tone2 = tone · depthFade(s.dC)` as in the common block.

**Paper grain (anchored tooth).** `g = toothOf(s)` from the shared
chunk (`docs/styles/strokes.md`, §4.11 "anchored tooth"): world-anchored
on surfaces (`s.u`, `s.along`, `s.mu`, `s.ma`) and dome-anchored on sky
(`s.ps`, scale 1), ≈ 2 px, in `[0.80, 1.20]`. Colour formulas are
unchanged; only the noise source moved.

**Sky** (`s.cls == 0`):

    wash = daylight ≥ 0.5 ? mix(0.04, 0.28, clamp(s.dirW.y, 0, 1)) : 0.45   // day: darker toward the zenith; night: even grey
    out  = mix(PAPER_P, G, wash · g)
    out  = mix(out, G, hairInk(s.ps, 0.5) · 0.35)                      // sparse hair on the dome
    gl_FragColor = vec4(out, 1)

**Surface** (`s.cls == 1 | 2`), ground tune (wave 18b, T-0146):

0. **Ground tone** — if `s.cls == 1`, `tone2 ·= 0.55` (`groundTone`) so
   a road is lightly shaded, not hatched solid. Walls leave `tone2`
   unchanged.
1. **Smudged tone wash** — `pencilWash(tone2, g) = tone2 · 0.55 · g`;
   `base = mix(PAPER_P, G, wash)`. Tone 0 is bare paper; the tooth lets
   paper through the wash, so the smudge is never solid.
2. **Primary strokes** — `nestedStrokeInk(s.u, s.along, tone2, s.mu,
   s.ma, 0.45, 0.25, 0.60)`: the shared world-anchored nested-LOD family
   with pencil's wider, softer widths — `hw = mu·(0.45 + 0.25·tone)`,
   edge `± 0.60·mu` (scribble passes `0.30, 0.20, 0.15`). The primary's
   LOD base spacing stays 8 cells (unchanged).
3. **Cross-hatch on walls** (`s.cls == 2`) — the same family rotated
   45° in stroke space (`crossCoords`): `u2 = (s.u + s.along)/√2`,
   `along2 = (s.along − s.u)/√2`, `mu2 = ma2 = (s.mu + s.ma)/2`;
   `secondary = nestedStrokeInk(u2, along2, tone2, mu2, mu2, 0.45, 0.25,
   0.60) · crossGate(tone2) · 0.75` with
   `crossGate = smoothstep(0.55, 0.70, tone2)` — the cross family fades
   in past `tone2 = 0.55` and sits lighter than the primary. **Ground
   (`s.cls == 1`): `secondary = 0`** — no cross-hatch on the road.
4. **Ink** — `ink = max(primary, secondary) · (0.65 + 0.30 · tone2)`;
   if `s.cls == 1`, `ink ·= 0.85`.
5. **Colour** — `out = mix(base, G, ink)`; **outline**:
   `out = mix(out, G, 0.7)` when `s.outline` (soft, never solid black).
   `gl_FragColor = vec4(out, 1)`.

## Shader notes

- **Shared chunk** — `fragment: STROKE_GLSL + PENCIL_FRAGMENT`: the
  shared machinery (chunk, `docs/styles/strokes.md`) plus pencil's
  constants (`PAPER_P`, `G`), the `daylight` uniform and `main()` (which
  starts `Surf s = surfaceAt(vUv);`). Nothing in the fragment redeclares
  a prelude uniform (`viewUp`, `tanHalfFov`, `viewToWorld`, …);
  `hash2` comes from the chunk.
- **Cross-hatch in GLSL** — `crossCoords` is inlined: `1/√2` is written
  as the literal `0.70710678`. The family is evaluated only on walls
  (`s.cls == 2`), gated by `smoothstep(0.55, 0.70, tone2) · 0.75`.
- **Ground tune** — `s.cls == 1`: `tone2 ·= 0.55`, `secondary = 0`,
  `ink ·= 0.85`. Same GLSL branch as `crayon` (colour lines excepted).
- **One uniform** — `uniform float daylight` is the only style uniform,
  seeded from `ctx.daylight` in `makeUniforms` and refreshed every frame
  by the `update` hook. `makeUniforms` creates no textures; no `dispose`.

## Pure exports (unit-tested in node)

- `PAPER_P` — `[0.97, 0.96, 0.93]`, the warm white paper.
- `G` — `[0.22, 0.22, 0.25]`, the graphite.
- `pencilWash(tone, g): number` — the smudged tone wash,
  `tone · 0.55 · g` (0 at tone 0, monotone in tone, ≤ 0.66 at the
  extreme).
- `crossCoords(u, along, mu, ma): { u, along, mu, ma }` — the 45°-rotated
  cross-hatch stroke space: `u2 = (u + along)/√2`,
  `along2 = (along − u)/√2`, `mu2 = ma2 = (mu + ma)/2`. Orthogonal, so
  `u2² + along2² = u² + along²`.
- `groundTone(tone2): number` — `tone2 · 0.55` (the ground-tone scale;
  `groundTone(1) → 0.55`).
- `crossGate(tone2): number` — `smoothstep(0.55, 0.70, tone2)` (0 at
  0.5, 1 at 0.7, monotone). Crayon re-exports both functions.

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

1. `p = vUv · grid`, `cell = floor(p)`; sample, tone, tint.
2. `Surf s = surfaceAt(vUv)` — clamped depth taps one cell apart;
   classify sky / ground / wall; `tone2 = tone · depthFade(s.dC)`;
   world/dome-anchored paper grain `g = toothOf(s)`.
3. Sky cells paint the pencilled sky (`wash·g` toward graphite, zenith-
   darkened by day, even grey by night) plus sparse hair; return.
4. Surface cells: ground scales `tone2` and drops the cross family;
   walls keep a later-gated, 0.75-weight 45° cross-hatch. Paint the
   smudged wash `base`, the wider softer world-anchored strokes, and
   the soft graphite outline; write `mix(base, G, ink)`.

Because the wash, the tooth and every stroke family are anchored in
world metres (sky: the dome) with the shared nested LOD, the result
reads as a graphite sketch: tone carried by a smudge and by stroke
density, cross-hatched on walls (the road stays a light wash), on paper
whose grain rides the surfaces and the sky rather than sitting as a
screen-space mask.
