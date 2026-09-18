# Shared stroke chunk (`strokes.ts`)

`src/render/styles/strokes.ts` — the world-anchored stroke machinery
shared by the sketch family (`scribble`, and since wave 18 `pencil`,
`crayon`, `pastel`, `watercolor`), extracted from `scribble.ts` by T-0139
with no change in behaviour. Contract: `docs/architecture.md` §4.11,
subsection "Shared stroke chunk (T-0139)".

## `STROKE_GLSL`

A GLSL ES 1.0 chunk exported as `export const STROKE_GLSL: string` that a
sketch style **prepends to its own fragment** (`fragment: STROKE_GLSL +
SCRIBBLE_FRAGMENT`); the whole thing is appended to `STYLE_PRELUDE`, so
the chunk defines only constants, functions, the `Surf` struct and
`surfaceAt` — it never redeclares a prelude uniform (`tScene`, `tDepth`,
`viewUp`, `tanHalfFov`, `viewToWorld`, …).

What the chunk provides:

- `const float UP_K = 0.6` — the ground/wall cut on
  `up = |dot(n, viewUp)|`.
- `hash2(a, b)` — precision-safe hash in `[0, 1)` for world-sized keys.
- `depthFade(d)` — `1 − 0.45·smoothstep(120, 900, d)`.
- `viewPos(uv, d, thf, asp)` / `viewNormal(…)` — view-space texel
  position and the unit view-space normal from the four L/R/U/D taps.
- `strokeCoords(W, nW, d, up)` / `strokeScale(…)` — world stroke
  coordinates in metres (`u` across, `along` along the strokes) and the
  screen gradient of them (`mu`/`ma` metres per screen cell).
- `vis(P, ma)`, `vnoise1(x, key)`, `wobble(along, ph, mu, ma, key)`,
  `lifted(key, along, ma)` — the world-metre hand-tremor wobble and
  pen-lift gate (value-noise octaves at 0.9 / 3.5 / 14 m, gap octaves at
  1.5 / 6 / 24 m, faded by screen size).
- `strokeLayer(…)` / `nestedStrokeInk(u, along, tone, mu, ma, wBase,
  wTone, aa)` — the world-anchored nested power-of-two LOD. Stroke core
  `hw = mu·(wBase + wTone·tone)` with edge `± aa·mu`; `scribble` passes
  its v4 values `(0.30, 0.20, 0.15)`, `pencil` `(0.45, 0.25, 0.60)`.
  Layer thresholds 0.10 / 0.40 / 0.70 (`SCRIBBLE_LAYERS`) soft-switched
  with `smoothstep(t ± 0.08)`.
- `hairInk(ps, density)` — the 3 × 3 × 3 short sky-hair strokes (7–23
  cells long, thinner than the surface core).
- `skyCoords(dirW, K)` — stereographic-from-nadir dome coordinates in
  cells: `K·(dirW.x, dirW.z) / (1 + dirW.y)`.
- The `Surf` struct and `Surf surfaceAt(vec2 uv)` — everything a sketch
  `main()` computed before colouring.

## `Surf` and `surfaceAt`

`surfaceAt(vUv)` computes, for the pixel at `vUv`:

| field     | meaning |
|-----------|---------|
| `cls`     | `0` sky · `1` ground · `2` wall (sky if `dC ≥ 0.98·cameraFar`; else ground when `up = \|dot(viewNormal, viewUp)\| > UP_K`) |
| `dC`      | cell-centre linear depth (metres) |
| `dPix`    | reconstructed per-pixel depth from the five clamped one-cell taps (gradient zeroed on a 35 % jump) |
| `W`       | world position of the pixel (`viewToWorld · viewPos(vUv, dPix, …)`) |
| `nW`      | unit world-space surface normal |
| `mu`, `ma`| metres of `u` / `along` per screen cell (`strokeScale` of the four neighbour taps) |
| `u`, `along` | stroke coordinates in metres (`strokeCoords`) |
| `dirW`    | sky cells only: unit world view direction |
| `ps`      | sky cells only: `skyCoords(dirW, K)` dome position in cells |
| `outline` | one-sided outline: a depth discontinuity (sky disagreement or inverse-depth second difference) whose nearer side this cell is |

For sky cells (`cls == 0`) `dirW` / `ps` are filled and the rest is zero;
the outline is false.

## Using the chunk (example)

```ts
fragment: STROKE_GLSL + PENCIL_FRAGMENT,   // style.ts entry
```

```glsl
Surf s = surfaceAt(vUv);
if (s.cls == 0) { /* sky: s.dirW / s.ps, e.g. hairInk(s.ps, …) */ }
float tone2 = tone * depthFade(s.dC);
float ink = nestedStrokeInk(s.u, s.along, tone2, s.mu, s.ma, 0.45, 0.25, 0.60);
if (s.outline) ink = 1.0;
```

## Pure TS mirrors (unit-tested in node)

`UP_K`, `SCRIBBLE_LAYERS`, `hash2`, `viewPos`, `viewNormal`,
`strokeCoords`, `strokeScale`, `lodOf`, `vnoise1`, `wobble`, `lifted`,
`nestedStrokeInk` (same eight arguments as the GLSL), `skyCoords`,
`hairInk`, `hairDir` — each mirrors the shader term for term;
`tests/styles/strokes.test.ts` covers them. `scribble.ts` keeps its own
colours (`PAPER`, `INK`, `SKY_INK`), `skyDensity`, `surfaceClass`,
`surfaceOutline`, `inkColour`, `washColour` and its fragment `main()` —
see `docs/styles/scribble.md`.
