# Matrix render style (`src/render/styles/matrix.ts`)

Digital rain over the city. Contract: `docs/architecture.md` §4.11 **matrix**
(revised 2026-08-27). Cell 6×12, sub 1×1, no depth texture. Glyphs come from
the ASCII atlas (`buildGlyphAtlas` / `DEFAULT_RAMP` imported from `./ascii`);
the rain phase reads the common `time` uniform, so there is no `update` hook.

Pure helpers never touch `document` / WebGL and are unit-tested in node.
The fragment shader mirrors them term for term.

## Exports

- `hash3(a, b, c): number` — deterministic hash in `[0, 1)`
- `matrixGlyph(cellX, cellY, timeS, count): number` — glyph index in `[0, count)`
- `rainIntensity(colX, y01, timeS): number` — trail intensity `I` in `[0, 1]`
- `matrixBrightness(S, I, head): [r, g, b]` — body / head RGB (no glyph mask)
- `STYLES` — one `RenderStyle`, id `matrix`, label `MATRIX`

## Algorithm

A cheap three-argument hash, identical in JS and GLSL:

```
hash(a, b, c) = fract(sin(a·12.9898 + b·78.233 + c·37.719)·43758.5453)
```

**Glyph.** Each cell picks a glyph from the ASCII ramp and holds it for about
half a second, with a per-cell phase so neighbouring cells do not re-roll
together:

```
window = floor(time · 2 + 7 · hash(cell.x, cell.y, 0))
idx    = floor(hash(cell.x, cell.y, window) · glyphCount)
```

`matrixGlyph` is that formula. The index is constant for ~0.5 s at a given
cell (a 0.1 s step stays inside the window) and jumps when the window ticks.

**Rain.** Each column has its own speed and phase:

```
speed = 0.3 + 0.7 · hash(cell.x, 1, 0)
phase = hash(cell.x, 2, 0)
trail = fract(phase − time · speed · 0.25 − y01)
I     = pow(trail, 4)
```

`y01` is screen `vUv.y` (0 at the bottom of the frame, 1 at the top).
`rainIntensity` returns `I`. The minus on the time term sends the head
(**`trail > 0.96`**, equivalently the argmax of `I` over y) toward **smaller**
`vUv.y` as time increases — down the screen, wrapping from 0 back to 1.

**Brightness.** With `S = shaped(bright(scene))` (0 in the sky):

```
body = (0.2, 1.0, 0.3) · (S · (0.3 + 0.7 · I) + 0.12 · I)
head = (0.9, 1.0, 0.9) · (0.4 + 0.6 · S)
```

`matrixBrightness(S, I, head)` returns that RGB. There is no floor on `S`:
empty sky stays black except for the faint `0.12 · I` trail, and a lit city
cell carries the brightness while the rain modulates it.

## Shader (per pixel)

The fragment is appended to `STYLE_PRELUDE`. Extra uniforms: `tAtlas`,
`glyphCount` (from `makeUniforms`; `dispose` frees the atlas texture).

For the pixel at `vUv`:

1. `cell = floor(vUv · grid)`.
2. Look up `idx` with the glyph formula; sample the atlas at
   `((idx + fract(vUv·grid).x) / glyphCount, fract(vUv·grid).y)` — the same
   tile mapping as the ASCII style. `mask` is the red channel.
3. `S = shaped(bright(cellMean(cell)))` (one sample at sub 1×1).
4. Rain `I` from the column formula with `y01 = vUv.y`; head when
   `trail > 0.96`.
5. Output `matrixBrightness(S, I, head) · mask`.

Empty atlas texels (`mask = 0`) stay black, so the rain reads as green
glyphs over a black ground, with a near-white leading character on the
city and a dimmer head in the sky.
