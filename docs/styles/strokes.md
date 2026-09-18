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
- `anchoredNoise(x, y, mx, my, cells, key)` / `vnoiseA(...)` — world-
  (surfaces) / dome- (sky) anchored grain, blended across two
  power-of-two LODs. See **Anchored tooth** below.
- The `Surf` struct and `Surf surfaceAt(vec2 uv)` — everything a sketch
  `main()` computed before colouring. The one-sided outline is
  `outlineAt(uv)` (T-0145).
- `float outlineAt(vec2 cellUv)` — the one-sided outline test extracted
  from `surfaceAt` (wave 18b, T-0145). See **`outlineAt`** below.
- `toothOf(s)` / `blotchA(s)` / `bloomA(s)` — paper tooth, granulation
  blotches and backruns/cloud gaps; GLSL takes a `Surf` (sky branch
  uses `s.ps` with `mx = my = 1`).

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
| `outline` | one-sided outline: `outlineAt(uv) > 0.5` (sky cells stay false because `surfaceAt` returns before the call) |

For sky cells (`cls == 0`) `dirW` / `ps` are filled and the rest is zero;
the outline is false.

## `outlineAt` (wave 18b, T-0145)

`float outlineAt(vec2 cellUv)` is the one-sided outline test extracted
from `surfaceAt` so a style can sample it at a cell other than the
pixel's own. Behaviour for the pixel's cell is byte-identical to the
pre-T-0145 inline test (the scribble e2e is the lock).

Given a UV that identifies a cell (`floor(cellUv · grid)`):

1. The same five clamped one-cell depth taps as `surfaceAt` (`centreUv`
   and L/R/U/D, clamped to `[0.5·texel, 1 − 0.5·texel]`).
2. `outlineFromDepths(dC, dL, dR, dU, dD)`: sky (`dC ≥ 0.98 ·
   cameraFar`) → `0`; else `1` when the cell is a depth discontinuity
   (a neighbour is sky, or an inverse-depth second difference
   `|wL + wR − 2·wC| > 0.02·wC` / same on U/D) **and** this cell is
   the nearer side of it; else `0`.

`surfaceAt` applies `outlineFromDepths` to the taps it already fetched
(so scribble / pencil / crayon / watercolor do not re-sample `tDepth`).
`pastel` bilinear-blends the four neighbour `outlineAt` flags (0/1) for
its soft 2-cell edge ramp (`docs/styles/pastel.md`).

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

## Anchored tooth (wave 18b, T-0144)

The paper grain and blotch noise of the sketch family (`pencil`,
`crayon`, `pastel`, `watercolor`) are world-anchored on surfaces
(`s.u`, `s.along` with scale `s.mu`, `s.ma`) and dome-anchored on sky
(`s.ps` with scale 1), at a constant on-screen size via a blended
power-of-two LOD — no screen-space shower-door, no pop. Colour formulas
do not change; only the noise sources.

- **`anchoredNoise(x, y, mx, my, cells, key)`** — hash grain of `cells`
  on-screen cells, in world units:
  `lx = log2(cells · mx)`, `Lx = floor(lx)`, `fx = fract(lx)` (same for
  `y`); `n(L) = hash2(floor(x / 2^Lx) + 7·key, floor(y / 2^Ly) + 13·key)`;
  result `mix(n(Lx, Ly), n(Lx+1, Ly+1), max(fx, fy))` in `[0, 1]`. Sky
  pass uses `mx = my = 1` (`ps` is already in cells).
- **`vnoiseA(x, y, mx, my, cells, key)`** — bilinear value noise on the
  same lattice (corner hashes of `n(L)` at the four floor/ceil corners
  of the level-`Lx`/`Ly` cell, smoothstep weights, blended across the
  two levels like `anchoredNoise`).
- **`toothOf`** — `g = 0.80 + 0.40 · anchoredNoise(u, along, mu, ma,
  0.67, 1)` (≈ 2 px tooth, in `[0.80, 1.20]`). GLSL takes a `Surf`;
  sky uses `s.ps` with scale 1. TS mirror: `toothOf(u, along, mu, ma)`.
- **`blotchA`** — `0.5 · vnoiseA(..., 6, 2) + 0.5 · vnoiseA(..., 17, 3)`.
  GLSL takes a `Surf`; sky uses `s.ps` with scale 1. TS:
  `blotchA(u, along, mu, ma)`.
- **`bloomA`** — surface `smoothstep(0.60, 0.90, vnoiseA(..., 40, 4))`;
  sky clouds `smoothstep(0.55, 0.80, vnoiseA(ps.x, ps.y, 1, 1, 30, 5))`.
  GLSL takes a `Surf`. TS: `bloomA(u, along, mu, ma)` (surface form).

Styles: `pencil` / `crayon` use `g = toothOf(s)` on surface and sky;
`pastel` uses `toothOf(s)` and sky streaks `blotchA(s)`; `watercolor`
uses `gran = 0.70 + 0.60·blotchA(s)`, surface bloom `0.25·bloomA(s)`,
sky cloud gaps `0.6·bloomA(s)`.

## Pure TS mirrors (unit-tested in node)

`UP_K`, `SCRIBBLE_LAYERS`, `hash2`, `viewPos`, `viewNormal`,
`strokeCoords`, `strokeScale`, `lodOf`, `vnoise1`, `wobble`, `lifted`,
`nestedStrokeInk` (same eight arguments as the GLSL), `skyCoords`,
`hairInk`, `hairDir`, `anchoredNoise`, `vnoiseA`, `toothOf(u, along,
mu, ma)`, `blotchA(u, along, mu, ma)`, `bloomA(u, along, mu, ma)` —
each mirrors the shader term for term; `tests/styles/strokes.test.ts`
covers them. `scribble.ts` keeps its own colours (`PAPER`, `INK`,
`SKY_INK`), `skyDensity`, `surfaceClass`, `surfaceOutline`,
`inkColour`, `washColour` and its fragment `main()` — see
`docs/styles/scribble.md`.
