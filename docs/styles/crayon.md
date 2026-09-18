# crayon render style

Cell **3×3**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the `crayon` look from
`docs/architecture.md` §4.11 (wave 18 "sketch family", T-0141):
**coloured pencil — the `pencil` shader with colour**. The graphite
pencil strokes (soft, wide, world-anchored) carry tone by *density* and
take the hue of the object under them; the paper takes a per-tone
coloured wash under the world/dome-anchored tooth; the sky is a faint
blue wash by day and a faint violet at night, with pencil hair strokes.

**The stroke machinery is shared** — the GLSL helpers (`hash2`,
`viewPos`, `viewNormal`, `strokeCoords`, `strokeScale`, `wobble`,
`lifted`, `strokeLayer`, `nestedStrokeInk`, `hairInk`, `skyCoords`,
`depthFade`), the `Surf` struct and `surfaceAt(vec2 uv)`, and their TS
mirrors live in `src/render/styles/strokes.ts` (`STROKE_GLSL`); see
**`docs/styles/strokes.md`**. This file documents only what is
crayon-specific: the colours, the two pure mirrors (`crayonStroke`,
`crayonWash`), the re-exported `groundTone` / `crossGate` (from
`pencil`), and the fragment `main()` (which starts with
`Surf s = surfaceAt(vUv);`).

## Algorithm (per pixel)

The scene sample and the colours are **per cell**
(`cell = floor(vUv · grid)`). Everything about the surface — the clamped
one-cell depth taps, the class (sky / ground / wall), the reconstructed
per-pixel depth `dPix`, the world position `W`, the stroke coordinates
and scale, the one-sided outline — is computed once per pixel by the
shared chunk's `Surf s = surfaceAt(vUv)` (`docs/styles/strokes.md`).

1. `p = vUv · grid`; `Surf s = surfaceAt(vUv)` — taps, sky test, class,
   `dPix`, `W`/`nW`, stroke coordinates + scale, one-sided outline.
2. **Paper grain** `g = toothOf(s)` from the shared chunk
   (`docs/styles/strokes.md`, §4.11 "anchored tooth"): world-anchored on
   surfaces, dome-anchored on sky, ≈ 2 px, in `[0.80, 1.20]`. Colour
   formulas are unchanged; only the noise source moved.
3. `c = sampleSub(cell, 0, 0)`; `v = shaped(bright(c))`;
   `tone = 1 − v`; `tint = tintOf(c)`; `sat = max(tint) − min(tint)`;
   `satF = smoothstep(0.10, 0.45, sat)` — exactly as scribble.
4. **Sky cells** (`s.cls == 0`):
   `hair = hairInk(s.ps, mix(0.75, 0.45, daylight))` (the scribble sky
   density — night a denser hair, noon sparse), then, with
   `daylight ≥ 0.5` = day:
   - day: `base = mix(PAPER_P, (0.55, 0.70, 0.95),
     0.25·g·(0.4 + 0.6·clamp(s.dirW.y, 0, 1)))` (faint blue, deeper
     toward the zenith); `out = mix(base, (0.35, 0.45, 0.70), hair·0.35)`.
   - night: `base = mix(PAPER_P, (0.25, 0.22, 0.45), 0.60·g)`;
     `out = mix(base, G, hair·0.35)` (graphite hair).
5. **Surface cells**: `tone2 = tone · depthFade(s.dC)` (far things wash
   lighter, as in every sketch style). The pencil strokes (T-0140 spec
   plus the T-0146 ground tune; identical GLSL branch to `pencil`,
   since the colours are all that differ):
   - **Ground** (`s.cls == 1`): `tone2 ·= 0.55` (`groundTone`) so a
     road is lightly shaded, not hatched solid.
   - `primary = nestedStrokeInk(s.u, s.along, tone2, s.mu, s.ma, 0.45,
     0.25, 0.60)` — pencil widths: soft wide core
     `hw = mu·(0.45 + 0.25·tone)`, AA edge `± 0.6·mu` (softer and wider
     than scribble's v4 `0.30, 0.20, 0.15`). The primary's LOD base
     spacing stays 8 cells (unchanged).
   - **45° cross-hatch on walls** (`s.cls == 2`) — the same stroke
     family rotated 45° in stroke space: `u2 = (s.u + s.along)/√2`,
     `along2 = (s.along − s.u)/√2`, `mu2 = ma2 = (s.mu + s.ma)/2`;
     `secondary = nestedStrokeInk(u2, along2, tone2, mu2, mu2, 0.45,
     0.25, 0.60) · crossGate(tone2) · 0.75` with
     `crossGate = smoothstep(0.55, 0.70, tone2)`. **Ground:
     `secondary = 0`** — no cross-hatch on the road.
   - `ink = max(primary, secondary) · (0.65 + 0.30·tone2)`; if
     `s.cls == 1`, `ink ·= 0.85`.
6. **Colour** (this is where crayon differs from pencil):
   - `strokeCol = mix(G, tint·0.60, 0.85·satF)` — graphite for grey
     things, the object's own hue for saturated ones (`crayonStroke`).
   - `wash = 0.45·satF·tone2^0.7 + 0.20·(1 − satF)·tone2`
     (`crayonWash`) — pigment washes in with tone, faster for saturated
     colours; 0 on bare paper.
   - `base = mix(PAPER_P, mix(G, tint, satF), wash·g)` — the grain lets
     the tooth through.
   - `out = mix(base, strokeCol, ink)`.
7. **Outline**: one-sided (from `s.outline`), soft, never solid black:
   `out = mix(out, G, 0.7)`.

Lit windows read as bare paper with a faint tinted wash (tone ≈ 0); the
shade on walls reads as dense coloured strokes and a lighter
cross-hatch; the ground is a light wash with primary strokes only.

## Shader notes

- **Pencil strokes, crayon colours** — the stroke call, widths
  (`0.45, 0.25, 0.60`), the 45° cross-hatch rotation in stroke space,
  the ground/wall branch (`tone2 ·= 0.55` / `secondary = 0` /
  `ink ·= 0.85` on ground; `crossGate · 0.75` on walls) and the
  `0.65 + 0.30·tone2` darkening are exactly the `pencil` spec; only
  `strokeCol`, `wash`, `base` and the sky colours carry the hue.
- **Grain only** — crayon uses the chunk's `toothOf(s)`, not
  `blotchA`/`vnoiseA`. The tooth rides the surfaces and the sky dome.
- **Cross-hatch gate** — the secondary family is evaluated only on
  walls (`s.cls == 2`); the `smoothstep(0.55, 0.70, tone2)` soft gate
  then fades it in (and `· 0.75` keeps it lighter than the primary), so
  there is no pop at the threshold. Ground never draws a cross family.
- **Chunk + fragment** — `fragment: STROKE_GLSL + CRAYON_FRAGMENT`:
  the shared machinery (`docs/styles/strokes.md`) plus crayon's
  constants (`PAPER_P`, `G`), the `daylight` uniform and `main()` (which
  starts `Surf s = surfaceAt(vUv);`).
- **One uniform** — `uniform float daylight` is the only style uniform,
  seeded from `ctx.daylight` in `makeUniforms` and refreshed every frame
  by the `update` hook. `makeUniforms` creates no textures; no `dispose`.
  Prelude uniforms (`viewUp`, `tanHalfFov`, `viewToWorld`) are never
  redeclared — neither in the fragment nor in `STROKE_GLSL`.

## Pure exports (unit-tested in node)

The stroke machinery is in `src/render/styles/strokes.ts` — see
`docs/styles/strokes.md` and `tests/styles/strokes.test.ts`. Crayon
keeps:

- `PAPER_P` — `[0.97, 0.96, 0.93]`, the white paper (shared with
  `pencil`).
- `G` — `[0.22, 0.22, 0.25]`, the graphite dark: stroke colour for grey
  things, the outline colour, the night-sky hair ink.
- `crayonStroke(tint, satF): [r, g, b]` — `mix(G, tint·0.60,
  0.85·satF)` per channel.
- `crayonWash(tone, satF): number` — `0.45·satF·tone^0.7 +
  0.20·(1−satF)·tone` (0 at tone 0 → bare paper; monotone in tone).
- `groundTone`, `crossGate` — re-exported from `pencil` (`toBe`
  identity): `groundTone(tone2) = tone2 · 0.55`,
  `crossGate(tone2) = smoothstep(0.55, 0.70, tone2)`.

The sky wash/hair colours (`(0.55, 0.70, 0.95)`, `(0.35, 0.45, 0.70)`,
`(0.25, 0.22, 0.45)`) are GLSL constants in the fragment; the hair
density `mix(0.75, 0.45, daylight)` is the shared scribble rule inlined
in the sky branch.

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

1. `p = vUv · grid`; `Surf s = surfaceAt(vUv)` (taps, class, `dPix`,
   `W`, stroke coordinates/scale, outline); world/dome-anchored paper
   grain `g = toothOf(s)`.
2. Sample, `tone`, `tint`, `satF` (per cell).
3. Sky cells paint the faint blue/violet wash with pencil hair (step 4).
4. Surface cells: depth-fade `tone2`, ground tune (scale / no
   cross-hatch / lighter ink) or wall cross-hatch (step 5), coloured
   wash under the grain, mix in the hue-tinted stroke colour, one-sided
   graphite outline (steps 6–7).
5. Write `out` as `gl_FragColor` (alpha = 1).

The result is a coloured-pencil drawing: every object shaded in its own
hue, darks and outlines in graphite, on toothy white paper.
