# Matrix render style (`src/render/styles/matrix.ts`)

Digital rain over the city. Contract: `docs/architecture.md` §4.11 **matrix**.
Cell 6×12, sub 1×1, no depth texture. Glyphs come from the ASCII atlas
(`buildGlyphAtlas` / `DEFAULT_RAMP` imported from `./ascii`); the rain phase
reads the common `time` uniform, so there is no `update` hook.

Pure helpers never touch `document` / WebGL and are unit-tested in node.
The fragment shader mirrors them term for term.

## Exports

- `hash3(a, b, c): number` — deterministic hash in `[0, 1)`
- `matrixGlyph(cellX, cellY, timeS, count): number` — glyph index in `[0, count)`
- `rainIntensity(colX, y01, timeS): number` — trail intensity in `[0, 1]`
- `STYLES` — one `RenderStyle`, id `matrix`, label `MATRIX`

## Algorithm

A cheap three-argument hash, identical in JS and GLSL:

```
hash(a, b, c) = fract(sin(a·12.9898 + b·78.233 + c·37.719)·43758.5453)
```

**Glyph.** Each cell picks a glyph from the ASCII ramp and holds it for 1/8 s:

```
idx = floor(hash(cell.x, cell.y, floor(time · 8)) · glyphCount)
```

`matrixGlyph` is that formula. The index is constant for every `timeS` that
share the same `floor(timeS · 8)` window and jumps when the window ticks.

**Rain.** Each column has its own speed and phase:

```
speed = 0.3 + 0.7 · hash(cell.x, 1, 0)
phase = hash(cell.x, 2, 0)
trail = fract(phase + time · speed · 0.25 − y01)
intensity = pow(trail, 3)
```

`y01` is screen `vUv.y` (0 at the bottom of the frame, 1 at the top).
`rainIntensity` returns `intensity`. The head of the drop is where
`trail > 0.97` (equivalently, the argmax of intensity over y). Because
`trail = fract(K − y)`, that argmax sits just above `fract(K)` and, between
wraps, travels toward **larger** `vUv.y` as time increases (then wraps to 0).

## Shader (per pixel)

The fragment is appended to `STYLE_PRELUDE`. Extra uniforms: `tAtlas`,
`glyphCount` (from `makeUniforms`; `dispose` frees the atlas texture).

For the pixel at `vUv`:

1. `cell = floor(vUv · grid)`.
2. Look up `idx` with the glyph formula; sample the atlas at
   `((idx + fract(vUv·grid).x) / glyphCount, fract(vUv·grid).y)` — the same
   tile mapping as the ASCII style. `mask` is the red channel.
3. Scene colour is `cellMean(cell)` (one sample at sub 1×1). Density is
   `0.35 + 0.65 · shaped(bright(scene))`.
4. Rain intensity from the column formula with `y01 = vUv.y`.
5. Body colour:
   `(0.2, 1.0, 0.3) · mask · density · (0.4 + 0.6 · intensity)`.
6. Head (`trail > 0.97`): `(0.9, 1.0, 0.9) · mask`.
7. Write `gl_FragColor`.

Empty atlas texels (`mask = 0`) stay black, so the rain reads as green
glyphs over a black ground, with a near-white leading character.
