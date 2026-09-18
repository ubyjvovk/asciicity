# pastel render style

Cell **3×3**, sub **1×1**, depth texture (`needsDepth: true`),
`groundGrid: false`. Implements the soft-chalk-pastel look from
`docs/architecture.md` §4.11 (wave 18 "sketch family", T-0142): toned
pastel paper, **no strokes** — the scene sample is 3×3-cell **smoothed**
(nine taps, soft edges), the hue becomes a pastel (hue + white) that the
world/dome-anchored paper tooth lets bleed through, dark chalk deepens
the shadows, and a faint chalky outline marks edges.

**The stroke machinery is shared** — the GLSL helpers (`hash2`,
`viewPos`, `viewNormal`, `strokeCoords`, `strokeScale`, `wobble`,
`lifted`, `strokeLayer`, `nestedStrokeInk`, `hairInk`, `skyCoords`,
`depthFade`, `toothOf`, `blotchA`), the `Surf` struct and
`surfaceAt(vec2 uv)`, and their TS mirrors live in
`src/render/styles/strokes.ts` (`STROKE_GLSL`); see
**`docs/styles/strokes.md`**. `pastel` uses `surfaceAt` for the sky
test (`s.cls`), the outline flag (`s.outline`), and the coordinates
`toothOf` / `blotchA` read — there are no stroke calls at all. This
file documents only what is pastel-specific: the colours (`PAPER_S`,
`DARK_CHALK`), `chalkOf`, `pastelColour` and the fragment `main()`
(which starts with `Surf s = surfaceAt(vUv);`).

## Algorithm (per pixel)

1. `p = vUv · grid`, `cell = floor(p)`.
2. **Smoothed sample** — `cs` = the mean of `sampleSub(cell + (dx, dy),
   0, 0)` over the **3×3 cell neighbourhood** `dx, dy ∈ {−1, 0, 1}`
   (9 taps; soft edges — this replaces the common block's single-cell
   sample).
3. `v = shaped(bright(cs))` (1 = paper, 0 = solid); `tint = tintOf(cs)`;
   `sat = max(tint) − min(tint)`; `satF = smoothstep(0.10, 0.45, sat)`.
4. `Surf s = surfaceAt(vUv)` — the shared chunk computes the clamped
   one-cell depth taps, the sky test, the class, `dPix`, the world
   position `W` / normal `nW`, the stroke coordinates and scale, and the
   one-sided outline (`docs/styles/strokes.md`).
5. **Paper grain (anchored tooth).** `g = toothOf(s)` from the shared
   chunk (`docs/styles/strokes.md`, §4.11 "anchored tooth"): world-
   anchored on surfaces, dome-anchored on sky, ≈ 2 px, in `[0.80, 1.20]`.
   Colour formulas are unchanged; only the noise source moved.

**Sky** (`s.cls == 0`), then return:

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
4. **Outline** — `col = mix(col, DARK_CHALK, 0.35)` when `s.outline`:
   faint, chalky, never a solid line.
5. `gl_FragColor = vec4(col, 1.0)`.

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
- **3×3 smoothing in GLSL** — a constant-bound 3 × 3 loop over
  `sampleSub(cell + (dx, dy), 0, 0)` (9 taps, `sub` is 1×1), divided by
  9.
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

The 3×3 smoothing has no TS mirror (it taps the scene target). The
tooth and blotches live in `strokes.ts` — see `docs/styles/strokes.md`.

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

1. `p = vUv · grid`, `cell = floor(p)`; 3×3-cell smoothed sample `cs`;
   `v`, `tint`, `satF`.
2. `Surf s = surfaceAt(vUv)` — sky test, outline, and the coords
   `toothOf` / `blotchA` read.
3. World/dome-anchored paper grain `g = toothOf(s)`.
4. Sky cells paint the pastel-blue (day, white streaks via `blotchA(s)`)
   / indigo (night) sky; return.
5. Surface cells paint `pastelColour(v, tint, g)` — pastel chalk with
   the tooth showing through and dark chalk in the shadows — and the
   faint 0.35 chalky outline when `s.outline`.

Because the sample is smoothed over 9 cells and the tooth `g` rides the
surfaces and the sky dome, the result reads as a soft chalk pastel:
broad, soft-edged fields of hue + white on toned paper, shaded with dark
chalk, outlined faintly — with no stroke of any kind.
