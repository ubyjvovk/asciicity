# Dither + Game Boy (`src/render/styles/dither.ts`)

Ordered 8×8 Bayer dithering, two looks sharing one module. Contract:
`docs/architecture.md` §4.11 **dither / gameboy**. Cell 2×2, sub 1×1, no
depth texture. `STYLES` is `[dither, gameboy]`.

Everything except `makeUniforms` is pure (no `document` / WebGL) and
unit-tested in node.

## Exports

- `BAYER8` — the 8×8 index matrix `M[y][x]` from §4.11
- `bayer8(x, y): number` — `(M[y mod 8][x mod 8] + 0.5) / 64`, in `(0, 1)`
- `ditherOn(v, x, y): boolean` — `v > bayer8(x, y)` (`v` is already-shaped brightness)
- `gameboyLevel(v, x, y): number` — `clamp(floor(v·3 + bayer8(x, y)), 0, 3)`
- `GAMEBOY_PALETTE` — four DMG greens, darkest → lightest
- `STYLES` — `dither` then `gameboy`

## Algorithm

Each output cell samples the scene once (`cellMean` of the 1×1 sub-grid)
and compares that cell's perceptual brightness against a Bayer threshold
indexed by the cell coordinate modulo 8. The 64 thresholds
`(0.5, 1.5, …, 63.5) / 64` are a permutation of a uniform grid, so a
flat mid-grey (`v = 0.5`) lights 32 of 64 cells.

The matrix itself is the recursive 2×2 Bayer construction
`Iₙ₊₁ = [[4 Iₙ, 4 Iₙ + 2], [4 Iₙ + 3, 4 Iₙ + 1]]` with
`I₂ = [[0, 2], [3, 1]]`, which expands to:

```
 0 32  8 40  2 34 10 42
48 16 56 24 50 18 58 26
12 44  4 36 14 46  6 38
60 28 52 20 62 30 54 22
 3 35 11 43  1 33  9 41
51 19 59 27 49 17 57 25
15 47  7 39 13 45  5 37
63 31 55 23 61 29 53 21
```

`bayer8` wraps: `bayer8(x + 8k, y + 8m) === bayer8(x, y)`.

### dither

White `(0.9, 0.95, 0.9)` when `shaped(bright(cellMean)) > bayer8`, else
black. `ditherOn(0, …)` is therefore false on every cell (thresholds are
strictly positive) and `ditherOn(1, …)` is true on every cell (thresholds
are strictly less than 1).

### gameboy

Level `L = clamp(floor(shaped(bright)·3 + bayer8), 0, 3)` selects one of
the four DMG greens:

| L | hex       | RGB 0–1 (approx)   |
|---|-----------|--------------------|
| 0 | `#0f380f` | 15, 56, 15 / 255   |
| 1 | `#306230` | 48, 98, 48 / 255   |
| 2 | `#8bac0f` | 139, 172, 15 / 255 |
| 3 | `#9bbc0f` | 155, 188, 15 / 255 |

`L` is 0 at `v = 0`, 3 at `v = 1`, and monotone in `v` for a fixed cell.
A flat `v = 0.5` averages to 1.5 over the 64-cell tile (32 cells at
level 1, 32 at level 2).

## Shader (per pixel)

The fragment is appended to `STYLE_PRELUDE`. For every canvas pixel:

1. `cell = floor(vUv * grid)` — whole 2×2 cell shares one colour.
2. `v = shaped(bright(cellMean(cell)))` — exposure + max-channel + gamma.
3. `b = bayer8(cell)` — the GLSL helper is the same recursive 2×2
   construction as `BAYER8`, so it matches the JS lookup at integer cells.
4. **dither:** `gl_FragColor = v > b ? vec3(0.9, 0.95, 0.9) : black`.
5. **gameboy:** `level = clamp(floor(v * 3.0 + b), 0.0, 3.0)` then the
   matching palette triple.

No atlas: the looks are solid per-cell colours, so `makeUniforms` returns
`{}` and there is nothing to `dispose`.
