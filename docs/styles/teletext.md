# Teletext (`src/render/styles/teletext.ts`)

Ceefax sixel mosaic. Contract: `docs/architecture.md` §4.11 **teletext**.
Cell 6×12 px, 2×3 scene samples per cell, no depth texture.

## Algorithm

Each cell is a 2×3 mosaic of sixels. Sample `(x, y)` (`x` ∈ {0, 1} left→right,
`y` ∈ {0, 1, 2} **bottom-first**, matching `sampleSub`) is bit
`k = y·2 + x`:

| bit | sixel |
|-----|--------|
| 0 | bottom-left |
| 1 | bottom-right |
| 2 | mid-left |
| 3 | mid-right |
| 4 | top-left |
| 5 | top-right |

Take `shaped(bright(sample))` for each of the six samples and let `mean` be
their average. Bit `k` is **on** when that sample's shaped brightness is
strictly greater than `mean`. If every sample equals the mean (none strictly
above — the all-equal cell, including a fully dark or fully bright cell) every
sixel is on (`bits = 63`).

Foreground is the nearest of the eight teletext colours

`[black, red, green, yellow, blue, magenta, cyan, white]`

(components 0 or 1) to `tintOf(meanOn)` after a further normalise so the max
channel is 1, where `meanOn` is the mean **exposed** colour of the on samples.
Black (index 0) is used only when `bright(meanOn) < 0.15`. Background is
black. The cell is filled analytically: the pixel's sixel is read from
`fract(vUv · grid)` (left/right split at 0.5, three equal rows from the
bottom).

## Pure exports

Safe in node; they never touch `document` / WebGL.

- `TELETEXT_PALETTE` — eight `[r, g, b]` triples, components 0/1, index order
  as above.
- `teletextIndex(rgb): number` — palette index of a mean-on colour. Mirrors
  the shader: `bright < 0.15` → 0, else nearest squared-RGB distance to the
  max-channel-normalised tint.
- `sixelBits(lums: number[6]): number` — pack the six bits. `lums` are already
  the shaped-brightness values in bottom-first order; bit `k` on when
  `lums[k] > mean`; all-equal → 63.
- `STYLES` — one `RenderStyle`, id `teletext`.

## Shader (per pixel)

No extra uniforms (`makeUniforms` returns `{}`; drawing is analytic, no
atlas). For the pixel's cell the fragment:

1. `sampleSub`s the six 2×3 samples and computes `shaped(bright)` of each.
2. Turns them into six on/off flags with the same rule as `sixelBits`.
3. Averages the **exposed** colours of the on samples → `meanOn`.
4. Resolves `fg` with the same rule as `teletextIndex(meanOn)`.
5. Maps `fract(vUv · grid)` onto sixel `k` and writes `fg` if that bit is on,
   else black.

`R` / `?render=teletext` select this look; `?cell=` overrides the 6×12 cell.
