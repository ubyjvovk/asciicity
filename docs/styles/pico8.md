# pico8 render style

Cell **4×4**, sub **1×1**, no depth texture. Implements the PICO-8 look
from `docs/architecture.md` §4.11: gamma-corrected scene sample, 4×4
ordered-dither offset, then nearest-neighbour snap into the 16-colour
PICO-8 palette.

## Algorithm (per cell)

1. Sample the scene once at the cell centre (`sampleSub(cell, 0, 0)`,
   which is `tScene · exposure`).
2. Gamma-correct per channel: `c = pow(clamp(c, 0, 1), gamma)` (`gamma`
   is the `StyleRenderer` default 0.45, matching architecture §4.8).
3. Look up the 4×4 Bayer threshold `bayer4(cell.x, cell.y)` — one of
   16 distinct values `(0.5/16, 1.5/16, …, 15.5/16)` — and offset every
   channel by `(bayer − 0.5) / 8`. This is symmetric around zero, so
   the average luminance is preserved.
4. Snap to the nearest palette entry by **squared RGB distance**
   (`nearestPico8`). Ties resolve to the lower index (first hit wins).

The fragment shader mirrors these steps term for term. Two things are
deliberately kept off the GPU-texture path:

- **Palette** — declared as `uniform vec3 palette[16]` and set from
  `PICO8_PALETTE` on activation. The 16-iteration nearest search reads
  it via a `for (int i = 0; i < 16; i++)` loop, which WebGL 1 permits
  because `i` is a constant-index-expression. No `sampler2D` and no
  8-bit round-tripping.
- **Bayer matrix** — computed inline via the recursive construction
  `M4[y][x] = M2[y/2][x/2] + 4·M2[y%2][x%2]` with `M2 = [[0, 2], [3, 1]]`,
  which reproduces the §4.11 matrix exactly (the same values the pure
  `bayer4(x, y)` reads from `BAYER4_M` — note the 4× multiplies the low
  bit, not the high bit, which is what keeps the orientation identical).
  Two `step`/`mix` calls per lookup; no texture upload.

## Pure exports (unit-tested in node)

- `PICO8_PALETTE: readonly [r, g, b][]` — the 16 canonical PICO-8
  colours in canonical index order (0 black, 7 near-white `#FFF1E8`,
  11 pure green `#00E436`).
- `bayer4(x, y): number` — the Bayer threshold at integer cell
  coordinates. Wraps modulo 4; the result is one of the 16 distinct
  values strictly inside `(0, 1)`.
- `nearestPico8(rgb): number` — squared-RGB-distance palette lookup.

## Uniforms owned by the style

| name      | shape                                     |
|-----------|-------------------------------------------|
| `palette` | `uniform vec3 palette[16]` (16 `Vector3`) |

Common uniforms (`tScene`, `grid`, `sub`, `sceneSize`, `exposure`,
`gamma`, `time`) come from `STYLE_PRELUDE`. No GPU textures are
allocated, so `dispose` is not needed.

## What the shader does per pixel

1. `cell = floor(vUv · grid)` — every pixel inside a 4×4 canvas tile
   maps to the same cell (sub = 1×1, so one scene sample per cell).
2. Apply steps 1–4 above.
3. Write the snapped palette colour as `gl_FragColor` (alpha = 1).

Because the entire cell is a solid palette colour, PICO-8 renders as
flat colour blocks — no glyphs, no dither pattern *within* a cell; the
dither is what decides *which* palette colour the whole cell picks per
frame.
