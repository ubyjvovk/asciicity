# hatch — pen-and-ink cross-hatch

Source: `src/render/styles/hatch.ts`. Contract: `docs/architecture.md`
§4.11 "hatch". The style renders the scene as ink strokes on paper — bright
cells stay blank, darker cells accumulate diagonal hatching, and the
darkest cells cross-hatch.

## Cell / atlas

- Cell 6×12 px, sub 1×1, `needsDepth: false`.
- Procedural atlas of 8 tiles, each 16×32 px, laid out in one horizontal
  row (128×32 total). Paper-black background, white ink strokes; the
  fragment shader uses the red channel as an ink mask and mixes it between
  the paper and ink colours.
- Each tile is clipped to its 16×32 rectangle so the 45° strokes (which
  are drawn longer than the tile so they fully cover it) do not bleed into
  neighbouring levels.
- Atlas texture uses `NearestFilter` so 1.5-px ink lines stay crisp when the
  16-px-wide tile is displayed inside a 6-px-wide cell.
- `dispose` releases the `THREE.CanvasTexture` created by `makeUniforms`.

## Algorithm (per cell)

1. Sample the cell: `mean = sampleSub(cell, 0, 0)`. Hatch has `sub = 1×1`,
   so this single sample is the cell's mean colour; using `sampleSub`
   directly avoids the `cellMean` helper's 8×8 loop (SwiftShader unrolls
   the loop even when it exits after one iteration, which is enough to blow
   the e2e cycle test's 60 s budget).
2. `v = bright(mean)` — hue-independent brightness, clamp of the max channel.
3. `level = round((1 − shaped(v)) · 7)` — density index in [0, 7]. Bright
   cells (`v = 1`) map to `level = 0` (blank paper); dark cells (`v = 0`)
   map to `level = 7` (densest cross-hatch). `shaped(v) = v^gamma` uses the
   common gamma uniform (0.45), so the ink density is perceptually paced.
4. Sample the atlas at tile `level`, sub-pixel `inCell = fract(vUv · grid)`:
   `mask = atlas[(level + inCell.x) / 8, inCell.y].r`.
5. Output `mix(paper, ink, mask)` with paper `(0.96, 0.93, 0.86)` and ink
   `(0.13, 0.11, 0.10)`.

## Atlas tiles

| level | `/` spacing (px) | `\` spacing (px) | look                          |
|-------|------------------|------------------|-------------------------------|
| 0     | —                | —                | blank paper                    |
| 1     | 16               | —                | one "/" diagonal              |
| 2     | 12               | —                | sparser "/"                    |
| 3     | 8                | —                | medium "/"                     |
| 4     | 4                | —                | dense "/"                      |
| 5     | 4                | 12               | dense "/" + one "\"           |
| 6     | 4                | 8                | dense "/" + medium "\"        |
| 7     | 4                | 4                | full cross-hatch               |

All ink strokes are 1.5-px wide 45° lines rasterised via the 2D canvas API
(`strokeStyle = '#fff'`, `lineWidth = 1.5`). Each line is drawn long enough
to reach across the tile — starting `tileH` px outside the tile and stepping
in `spacing`-px increments — then clipped to the tile so every level has
full coverage without leaking into its neighbours.

## Pure exports

- `hatchLevel(v: number): number` — density index for a cell brightness in
  [0, 1]. Mirrors the shader term for term (`floor((1 − v^0.45) · 7 + 0.5)`).
  Clamps the input to [0, 1] and the output to [0, 7]. Monotone
  non-increasing in `v`.
- `hatchSpacing(level: number): { fwd: number | null; back: number | null }`
  — the "/" (`fwd`) and "\" (`back`) spacings for atlas tile `level`.
  `null` means "no diagonals of this orientation".
- `buildHatchAtlas(canvas: HTMLCanvasElement)` — resizes `canvas` to
  `128×32`, paints the 8 tiles, and returns `{ canvas, count: 8 }`. Takes
  the canvas so tests can supply a fake one.

## Shader per pixel

```glsl
vec2 cell = floor(vUv * grid);
float v = bright(sampleSub(cell, 0.0, 0.0));
float lvl = clamp(floor((1.0 - shaped(v)) * (levelCount - 1.0) + 0.5),
                  0.0, levelCount - 1.0);
vec2 inCell = fract(vUv * grid);
float mask = texture2D(tAtlas, vec2((lvl + inCell.x) / levelCount, inCell.y)).r;
gl_FragColor = vec4(mix(vec3(0.96, 0.93, 0.86),
                        vec3(0.13, 0.11, 0.10), mask), 1.0);
```

The `levelCount` and `tAtlas` uniforms are the only style-specific uniforms;
everything else comes from `STYLE_PRELUDE`.
