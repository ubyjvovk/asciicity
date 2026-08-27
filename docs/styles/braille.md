# Braille render style

Reference for `src/render/styles/braille.ts` (docs/architecture.md §4.11
"braille"). The plug-in contract (`RenderStyle`, `STYLE_PRELUDE`, the prelude
helpers) is PM-owned in `src/render/style.ts`; the pipeline that drives the
shader is `docs/render.md`.

## What it looks like

Every screen cell is a 6×12 px block (scene sub-samples 2×4, one dot per
sub-sample). The cell encodes local luminance as a Unicode-braille-ordered
8-dot glyph, sampled from a procedural 256-tile atlas — one tile per bitmask.
Bright columns become solid garnets of dots; dark cells stay empty.

## Algorithm

For a cell, the 8 scene sub-samples `(c, r)` (`c` ∈ {0,1} column, `r` ∈
0..3 row **from the top**) are each turned into a dot:

> dot `(c, r)` is lit when `shaped(bright(sample)) > T[r][c]`
>
> `T = [[1/9, 5/9], [7/9, 3/9], [2/9, 6/9], [8/9, 4/9]]`

`shaped` is `pow(clamp(v,0,1), gamma)` (`gamma` = 0.45) and `bright` is the
max channel — the prelude helpers from `style.ts`. The thresholds are the
eight values 1/9 … 8/9, so a ramp of brightness lights exactly one new dot
at each ninth and the lit-dot count is monotone.

The dot bitmask uses the Unicode braille order:

| bit | dot | sample `(c, r)` | bit | dot | sample `(c, r)` |
|-----|-----|-----------------|-----|-----|-----------------|
| 0 | 1 | `(0, 0)` | 4 | 5 | `(1, 1)` |
| 1 | 2 | `(0, 1)` | 5 | 6 | `(1, 2)` |
| 2 | 3 | `(0, 2)` | 6 | 7 | `(0, 3)` |
| 3 | 4 | `(1, 0)` | 7 | 8 | `(1, 3)` |

Tile index = bitmask; 256 tiles.

## Pure exports (node-safe)

- `BRAILLE_THRESHOLDS: number[][]` — `T[r][c]`, top-first, exactly as §4.11.
- `brailleBits(lums: number[]): number` — bitmask; bit `b` set when
  `lums[r*2+c] > T[r][c]` (lums row-major top-first). The test spec for the
  shader's bit accumulation.
- `brailleDots(bits: number): [c, r][]` — inverse of `brailleBits`: the lit
  dots in ascending bit order.
- `buildBrailleAtlas(canvas): HTMLCanvasElement` — rasterises 256 16×32 px
  tiles in one row (4096×32 canvas): white dots radius 2.5 at x ∈ {4, 12},
  y ∈ {4, 12, 20, 28} (top-first) on black. Tile index = bitmask. Called from
  `makeUniforms` via `ctx.makeCanvas`; the resulting `CanvasTexture`
  (`flipY`, `LinearFilter`, matching the ascii atlas) is disposed on style
  switch.

`brailleBits` / `brailleDots` / `BRAILLE_THRESHOLDS` never touch `document`;
the atlas builder takes the canvas from the caller so it runs under a fake
canvas in node.

## What the shader does per pixel

The fragment body adds one uniform, `tAtlas` (the 256-tile atlas), then for
each pixel of the cell:

1. `cell = floor(vUv * grid)` — which cell the pixel is in.
2. Read the 8 sub-samples once (named `s<c><r>` with `r` top-first; the
   prelude's `sampleSub` takes `sy` bottom-first, so `sy = 3 − r`). Their
   mean is `cellMean` for a 2×4 cell.
3. Compare `shaped(bright(sample)) > T[r][c]` for each of the eight dots,
   accumulating `bitsF` in `[0, 255]` the same way `brailleBits` does:
   `bitsF = float(…)·1 + float(…)·2 + … + float(…)·128`. (GLSL ES 1.00 has
   no bitwise ops; `float(bool)` is 0 or 1, so this is the strict-`>` test
   with no divergent `if`s.)
4. `inCell = fract(vUv * grid)`; `mask = texture2D(tAtlas,
   (bitsF + inCell.x)/256, inCell.y).r` — sample of the correct tile
   (`flipY` so top-first dots land on top of the cell).
5. Colour: `tintOf(mean) · clamp(shaped(bright(mean))·0.7 + 0.4, 0, 1) ·
   mask` — the dot picks up the cell's hue, the density factor keeps it from
   being a flat patch, and the atlas mask shapes the dot itself.
   `gl_FragColor = vec4(out, 1)`.

`cellW: 6`, `cellH: 12`, `subX: 2`, `subY: 4`, `needsDepth: false`. The
scene target stays `cols·2 × rows·4`, within the ≤ 640×360 budget.
