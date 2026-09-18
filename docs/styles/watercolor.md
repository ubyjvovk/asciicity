# watercolor render style

Cell **3×3**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the `watercolor` look from
`docs/architecture.md` §4.11 (wave 18 "sketch family", T-0143),
**v2 formula** (PM review 2026-09-18 of the v1 frames): **wet washes —
no strokes at all**. Tone is carried by *pigment density* in a
transparent wash over bright paper: more pigment in the shade,
granulation blotches in screen space, grey things washed neutral slate,
backruns (blotchy paper gaps) keeping the wash wet, the edge of a wash
darkening where the pigment pools, and lights left white — the classic
watercolour trick (a lit window has tone ≈ 0, so it reads as paper).
The sky is a granulated blue that deepens toward the zenith by day with
cloud gaps, deep indigo at night.

v2 keeps the wash transparent — the v1 mix factor clamped to 1 on every
coloured wall (flat cel fills, no visible granulation, plain grey
ground). v2 caps the density at 0.8 and the mix factor at 0.9, widens
the granulation swing to `0.70 + 0.60·blotch`, and adds the backruns
bloom and the sky cloud gaps.

**The surface machinery is shared** — the GLSL helpers (`hash2`,
`viewPos`, `viewNormal`, `strokeCoords`, `strokeScale`, `wobble`,
`lifted`, `strokeLayer`, `nestedStrokeInk`, `hairInk`, `skyCoords`,
`depthFade`), the `Surf` struct and `surfaceAt(vec2 uv)`, and their TS
mirrors live in `src/render/styles/strokes.ts` (`STROKE_GLSL`); see
**`docs/styles/strokes.md`**. Watercolor uses the chunk only for the
*sky test*, `s.dirW` (the zenith gradient in the day sky) and the
one-sided `s.outline` flag — it makes **no** stroke calls. This file
documents what is watercolor-specific: the colours, the 2-D
`vnoise`/`blotch` (the chunk only carries 1-D `vnoise1`, so the wash
noise lives here), the pure mirrors, and the fragment `main()` (which
starts with `Surf s = surfaceAt(vUv);`).

## Algorithm (per pixel)

The scene sample and the colours are **per cell**
(`cell = floor(vUv · grid)`). Everything about the surface — the clamped
one-cell depth taps, the class (sky / ground / wall), the reconstructed
per-pixel depth `dPix`, the world position `W`, the stroke coordinates
and scale, the one-sided outline — is computed once per pixel by the
shared chunk's `Surf s = surfaceAt(vUv)` (`docs/styles/strokes.md`).

1. `p = vUv · grid` (in **screen-space cells** — the paper is the
   screen; it does not move with the world); **granulation**
   `gran = 0.70 + 0.60 · blotch(p)` where
   `blotch(q) = 0.5·vnoise(q/6) + 0.5·vnoise(q/17)` and `vnoise(q)` is
   the bilinear (smoothstep-fade) blend of `hash2` at the four corners
   of `floor(q)`. (The wave-18 common block also defines the 2×2-px
   paper tooth `g`; watercolor uses only `gran`.)
2. `Surf s = surfaceAt(vUv)` — taps, sky test, class, `dPix`, `W`/`nW`,
   stroke coordinates + scale, one-sided outline.
3. `c = sampleSub(cell, 0, 0)`; `v = shaped(bright(c))`;
   `tone = 1 − v`; `tint = tintOf(c)`; `sat = max(tint) − min(tint)`;
   `satF = smoothstep(0.10, 0.45, sat)` — exactly as scribble.
4. **Sky cells** (`s.cls == 0`) — a plain granulated wash, no hair:
   - day (`daylight ≥ 0.5`): `col = mix((0.86, 0.92, 1.0),
     (0.55, 0.72, 0.95), clamp(s.dirW.y, 0, 1)) · gran` — a
     zenith-gradient blue via the world direction — then **cloud
     gaps**: `col = mix(col, (0.97, 0.98, 1.0), 0.6 · smoothstep(0.55,
     0.80, vnoise(p/30)))`, letting paper peek through the sky wash.
   - night: `col = (0.18, 0.20, 0.40) · gran`.
   - `out = col`.
5. **Surface cells**: `tone2 = tone · depthFade(s.dC)` (far things wash
   lighter, as in every sketch style).
   - `pig = mix(1, tint, 0.8·satF)` — transparent pigment: white where
     there is no colour, the object's own (slightly off-pure) hue where
     there is (`pigmentOf`).
   - `dens = 0.25 + 0.55·tone2^0.6` — more pigment in the shade, a
     floor of 0.25 so even the lightest wash is slightly tinted, a
     ceiling of 0.8 so nothing is a full-strength wash
     (`washDensity`).
   - `mixF = clamp(dens·gran·(0.35 + 0.65·satF), 0, 0.9)` and
     `col = mix(PAPER_W, pig, mixF)` — the 0.9 cap keeps the paper
     grain showing through even the darkest wash (`washStrength`).
   - **Grey things** get a neutral wash instead of a hue:
     `col = mix(col, GREY_WASH = (0.35, 0.36, 0.42), (1 − satF)·tone2
     · 0.5 · gran)` — factor 0 for saturated things, so the term fades
     out naturally.
   - **Bloom (backruns)**: `col = mix(col, PAPER_W, 0.25 ·
     smoothstep(0.60, 0.90, vnoise(p/40)))` — blotchy paper gaps in the
     wet wash (`bloom`).
6. **Pooled edge**: `col = col · 0.55` when `s.outline` — the pigment
   collects at the edge of a wash. (The classic watercolour dark edge,
   darker and cheaper than the sketch styles' outlined cells.)

Lit windows read as paper with a faint tint (tone ≈ 0 → `mixF ≈
0.25·gran·(0.35 + 0.65·satF)` ≤ 0.325); the shade reads as dense — but
still transparent — pigment.

## Shader notes

- **No stroke calls** — unlike the rest of the sketch family, watercolor
  never calls `nestedStrokeInk`/`strokeLayer`/`hairInk`; tone lives
  entirely in the wash density. The shared chunk is used only for the
  sky test, `dirW` and the outline.
- **Screen-space granulation** — `blotch(p)` is anchored to the screen
  (cells of `vUv·grid`), so the blotches never scroll with the world,
  the same rule as the sketch family's paper grain.
- **`vnoise`/`blotch` live here** — the wave-18 common block's 2-D value
  noise is not in `strokes.ts` yet (it only has 1-D `vnoise1`), so both
  the GLSL (in the fragment, after `STROKE_GLSL`) and the TS mirrors
  (this file) carry it. When the chunk gains them, this file should
  switch to importing them.
- **`vnoise`** is the bilinear blend of `hash2` at the four corners of
  `floor(q)` with a smoothstep (Hermite) fade — it is 0 exactly on the
  integer lattice and stays in `[0, 1]`.
- **Chunk + fragment** — `fragment: STROKE_GLSL + WATERCOLOR_FRAGMENT`:
  the shared machinery (`docs/styles/strokes.md`) plus watercolor's
  constants (`PAPER_W`, `GREY_WASH`), `vnoise`/`blotch`, the `daylight`
  uniform and `main()` (which starts `Surf s = surfaceAt(vUv);`).
- **One uniform** — `uniform float daylight` is the only style uniform,
  seeded from `ctx.daylight` in `makeUniforms` and refreshed every frame
  by the `update` hook. `makeUniforms` creates no textures; no `dispose`.
  Prelude uniforms (`viewUp`, `tanHalfFov`, `viewToWorld`) are never
  redeclared — neither in the fragment nor in `STROKE_GLSL`.

## Pure exports (unit-tested in node)

The surface machinery is in `src/render/styles/strokes.ts` — see
`docs/styles/strokes.md` and `tests/styles/strokes.test.ts`. Watercolor
keeps:

- `PAPER_W` — `[0.99, 0.98, 0.95]`, the bright paper.
- `GREY_WASH` — `[0.35, 0.36, 0.42]`, the neutral slate the wash mixes
  toward for grey things (factor `(1 − satF)·tone2·0.5·gran`).
- `vnoise(x, y): number` — 2-D value noise in `[0, 1]`: bilinear
  (smoothstep-fade) blend of `hash2` at the four corners of `floor(q)`;
  0 exactly on the integer lattice.
- `blotch(x, y): number` — `0.5·vnoise(q/6) + 0.5·vnoise(q/17)`, two
  octaves in `[0, 1]` (so `gran = 0.70 + 0.60·blotch` sits in
  `[0.70, 1.30]`).
- `pigmentOf(tint, satF): [r, g, b]` — `mix(1, tint, 0.8·satF)` per
  channel: transparent pigment.
- `washDensity(tone): number` — `0.25 + 0.55·tone^0.6`: more pigment in
  the shade, floor 0.25, ceiling 0.8 (never a full-strength wash);
  monotone in tone.
- `washStrength(tone2, satF, gran): number` — the clamped
  paper→pigment mix factor `clamp(dens·gran·(0.35 + 0.65·satF), 0,
  0.9)`; monotone in `tone2`, at most `0.25·gran·(0.35 + 0.65·satF) ≤
  0.325` at tone 0.
- `bloom(x, y): number` — `0.25·smoothstep(0.60, 0.90, vnoise(q/40))`,
  the backruns paper-gap factor in `[0, 0.25]`.
- `watercolorWash(tint, satF, tone2, gran): [r, g, b]` — the full
  surface wash colour: `mix(PAPER_W, pigmentOf, washStrength)`, then
  `mix` toward `GREY_WASH` by `(1 − satF)·tone2·0.5·gran` — i.e. the
  fragment's `col` before bloom and the pooled edge.

The sky colours (`(0.86, 0.92, 1.0)`, `(0.55, 0.72, 0.95)`,
`(0.97, 0.98, 1.0)`, `(0.18, 0.20, 0.40)`), the sky cloud-gap factor
0.6 and the pooled-edge factor 0.55 are GLSL constants/operations in
the fragment.

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

1. `p = vUv · grid`; the screen-space granulation `gran`;
   `Surf s = surfaceAt(vUv)` (taps, class, `dPix`, `W`, stroke
   coordinates/scale, outline — of which only the sky test, `dirW` and
   the outline are used).
2. Sample, `tone`, `tint`, `satF` (per cell).
3. Sky cells paint the granulated blue/indigo wash (with cloud gaps by
   day, step 4) and return.
4. Surface cells: depth-fade `tone2`, transparent pigment, density,
   wash (mixF capped at 0.9), neutral slate for grey things, backruns
   bloom, pooled darker edge (step 5–6).
5. Write `col` as `gl_FragColor` (alpha = 1).

The result is a wet watercolour: every object shaded by pigment
density in its own hue, grey things in slate, the wash granulated and
punching through with paper gaps, edges darkening where the wash pools,
lights left as paper, over a granulated washed sky.
