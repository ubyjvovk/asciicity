# blocks — ANSI quadrant art (T-0052)

`docs/architecture.md §4.11` — "blocks". Cell **6×12**, sub **2×2**, no
depth texture, no atlas: the whole look is drawn analytically, so
`makeUniforms` returns an empty uniforms table and there is nothing to
`dispose`.

## Algorithm

Each cell is split into four **quadrants**, matching the `sampleSub` order
(0 = bottom-left, 1 = bottom-right, 2 = top-left, 3 = top-right). Taking the
four exposed sample colours `c0..c3` in that order:

1. **Brightness** — `lq = shaped(bright(cq))` for each quadrant (the
   perceptual density curve `pow(clamp(bright, 0, 1), γ)`).
2. **Cell mean** — `m = (l0 + l1 + l2 + l3) / 4`.
3. **On/off bits** — quadrant `q` is *on* when `lq > m + 1e-4`; when all four
   `lq` are equal, every quadrant is on (all 15 bits).
4. **Means** — `fgRaw` = mean exposed colour of the *on* quadrants,
   `bgRaw` = mean of the *off* ones.
5. **Tint** — `fg = tintOf(fgRaw) · shaped(bright(fgRaw))`, likewise `bg`.
   When every quadrant is on there are no off quadrants, so `bg = black`.
6. **Draw** — each screen pixel maps to its quadrant via
   `fract(vUv · grid)` (left/right by `x < 0.5`, bottom/top by `y < 0.5`)
   and emits `bg` or `fg` depending on that quadrant's on/off bit.

## Pure exports (unit-tested in node)

- `GAMMA` — default γ (0.45, §4.8) used when the callers omit one.
- `quadrantBits(lums: number[])` → `number` — which quadrants are on for the
  four shaded brightnesses (`sampleSub` order). Bit `q` set when
  `lums[q] > mean + 1e-4`; all-equal → `15`.
- `splitMeans(colours, bits, gamma = GAMMA)` → `{ fg, bg }` — mean on/off
  colours rendered as `tintOf(mean) · shaped(bright(mean))`; `bg` is black
  when all four quadrants are on.

## What the shader does per pixel

The fragment samples the four quadrant colours, computes the on/off bits from
the shaded brightnesses, accumulates `fgRaw`/`bgRaw`, tints them, picks the
pixel's own quadrant from `fract(vUv · grid)`, then writes
`mix(bg, fg, thisOn)`. It stays bit-for-bit in step with the pure helpers
above — the unit tests are the spec for the shader.
