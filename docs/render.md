# Rendering — scene constants and render styles

Reference for `src/render/`. The plug-in contract (`RenderStyle`,
`STYLE_PRELUDE`, `STYLE_ORDER`) is PM-owned in `src/render/style.ts` and
locked in `docs/architecture.md` §4.11; the ASCII shader that the three
original themes share is §4.8. This file explains the pipeline, how a style
plugs in, and where to twist the knobs.

## Pipeline

```
       ┌──────────────────────────────────────────────────────────┐
       │  scene (buildings/roads/ground meshes + fog + 3 lights)  │
       └──────────────────────────────────────────────────────────┘
                                    │  makeCamera(aspect)
                                    ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  WebGLRenderTarget(cols·subX, rows·subY)                      │
   │      NearestFilter, depthBuffer; DepthTexture if needsDepth   │
   │      cols = floor(width / cellW), rows = floor(height / cellH)│
   │      cellW/cellH come from the active style (`?cell=` overrides)
   └───────────────────────────────────────────────────────────────┘
                                    │  full-screen quad (2×2 plane)
                                    │  STYLE_VERTEX + STYLE_PRELUDE + fragment
                                    ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  Style fragment                                               │
   │    tScene / grid / sub / sceneSize / exposure / gamma / time  │
   │    tDepth, cameraNear/Far when needsDepth                     │
   │    style uniforms from makeUniforms (atlas, palettes, …)      │
   └───────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                            canvas (width × height)
```

`StyleRenderer` (`src/render/post.ts`) owns the target, the quad and the
common uniforms, and swaps styles. `render(scene, camera)` performs the two
passes with no per-frame allocation: scene → target, then quad → canvas.
`setStyle` disposes the previous style (`style.dispose?.(uniforms)`,
material, target) and rebuilds at the current canvas size. `setSize`
recomputes `cols/rows` and resizes the target.

The performance budget is a scene target ≤ 640×360 px at 1080p
(`cols·subX × rows·subY`) so every style stays ≥ 30 fps on an integrated GPU.
`styleGrid` (exported from `post.ts`) clamps `cols`/`rows` to that cap, so a
2×2-cell style at 1920×1080 still renders into 640×360 rather than 960×540.

## Contract

Read `src/render/style.ts` before writing a style. A `RenderStyle` is:

| Field | Meaning |
|-------|---------|
| `id` | URL id (`?render=<id>`), lower-case, unique. |
| `label` | Upper-case toast name, e.g. `BRAILLE`. |
| `cellW` / `cellH` | Screen pixels per cell (default; `?cell=WxH` overrides). |
| `subX` / `subY` | Scene samples per cell; target is `cols·subX × rows·subY`. |
| `needsDepth` | Attach a `THREE.DepthTexture`; prelude then provides `linearDepth()`. |
| `fragment` | GLSL ES 1.0 body appended to `STYLE_PRELUDE`. Must define `void main()`. |
| `makeUniforms(ctx)` | Style-specific uniforms (atlases, palettes). `{}` is fine. |
| `update?` | Optional per-frame hook (`timeS` seconds since start). |
| `dispose?` | Optional: free GPU resources created by `makeUniforms`. |

Do **not** redeclare uniforms the prelude already makes (`tScene`, `grid`,
`sub`, `sceneSize`, `exposure`, `gamma`, `time`, `tDepth`, `cameraNear`,
`cameraFar`, `varying vec2 vUv`). Do not name a local `shaped` / `bright` —
those are prelude helpers.

Helpers: `sampleSub`, `cellMean`, `bright`, `shaped`, `tintOf`, `linearDepth`.
See the comment on `STYLE_PRELUDE` in `style.ts`.

## How to add a style

1. Add the id to `STYLE_ORDER` in `src/render/style.ts` (PM-owned — that is
   a separate ticket).
2. Create `src/render/styles/<name>.ts` exporting
   `export const STYLES: readonly RenderStyle[]` (one entry, or two for
   `dither.ts` which owns `dither` **and** `gameboy`).
3. Import that array in `src/render/styles/index.ts`. The registry throws at
   import if any `STYLE_ORDER` id is missing or duplicated.
4. Keep the scene target ≤ 640×360 at 1080p. Pure helpers belong next to the
   shader and are unit-tested in node; the shader must mirror them.

`R` cycles `STYLE_ORDER`; `Shift+R` goes backwards. `?render=<id>` selects
(unknown → `ascii`).

## Style ids

| id | module | cell | sub | depth | notes |
|----|--------|------|-----|-------|-------|
| `ascii` | `styles/ascii.ts` | 6×12 | 1×1 | no | Cyber ASCII (former theme 0). |
| `gloom` | `styles/ascii.ts` | 6×12 | 1×1 | no | Gloom ASCII (former theme 1). |
| `solarized` | `styles/ascii.ts` | 6×12 | 1×1 | no | Solarized ASCII (former theme 2). |
| `braille` | `styles/braille.ts` | 6×12 | 2×4 | no | Stub until T-0051. |
| `blocks` | `styles/blocks.ts` | 6×12 | 2×2 | no | Stub until T-0052. |
| `teletext` | `styles/teletext.ts` | 6×12 | 2×3 | no | Stub until T-0053. |
| `dither` | `styles/dither.ts` | 2×2 | 1×1 | no | Stub until T-0054. |
| `gameboy` | `styles/dither.ts` | 2×2 | 1×1 | no | Stub until T-0054. |
| `pico8` | `styles/pico8.ts` | 4×4 | 1×1 | no | Stub until T-0055. |
| `edges` | `styles/edges.ts` | 2×2 | 1×1 | yes | Stub until T-0056. |
| `hatch` | `styles/hatch.ts` | 6×12 | 1×1 | no | Stub until T-0057. |
| `matrix` | `styles/matrix.ts` | 6×12 | 1×1 | no | Stub until T-0058. |

Stubs copy the ascii cyber shader with the stub's own `id`,
`label: '<ID> (TODO)'`, and cell/sub/needsDepth so the cycle, the URL ids
and the e2e loop work today. Each style ticket replaces one file wholesale.

## ASCII family (`styles/ascii.ts`)

`asciiStyle(id, label, theme)` builds one of the three former themes.
`DEFAULT_RAMP`, `glyphIndex`, `buildGlyphAtlas`, `themeMix` stay exported
unchanged (the unit tests in `tests/ascii.test.ts` import them from this
module). The §4.8 shader body is the `fragment`; extra uniforms `tAtlas`,
`glyphCount`, `theme` come from `makeUniforms`.

Glyph index (TS `glyphIndex` mirrors the shader):
`floor(clamp(lum,0,1)^gamma · (count−1) + 0.5)`, clamped to `[0, count−1]`.
`v` is the exposed max-channel brightness, not luminance.

| Theme | `theme` | Background (mask 0) | Glyph (mask 1) | Hot cells (`v → 1`) |
|-------|---------|---------------------|----------------|---------------------|
| cyber | `0` | black | `tint * mask` | — |
| gloom | `1` | `[0.72, 0.73, 0.75]` | `gWash = mix(lumT, tint, 0.75) * 0.20` | `tint * 0.9` |
| solarized | `2` | `[0.992, 0.965, 0.890]` paper | muted base00 ink | `[0.71, 0.54, 0.0]` yellow |

## Scene constants (`src/render/scene.ts`)

| Factory                | Value                                                                     |
|------------------------|---------------------------------------------------------------------------|
| `makeRenderer(canvas)` | `WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true })`, `setPixelRatio(1)`. |
| `makeScene()`          | Background `0x000000`; `FogExp2(0x000000, 0.0018)`; `AmbientLight(0xffffff, 0.6)`; `DirectionalLight(0xffffff, 1.1)` at `(1, 2, 0.5)`; `HemisphereLight(0x223344, 0x080808, 0.4)`. |
| `makeCamera(aspect)`   | `PerspectiveCamera(70, aspect, 0.3, 2000)`.                               |

`preserveDrawingBuffer: true` lets the e2e smoke test read canvas pixels;
`setPixelRatio(1)` keeps the render target size equal to the cell grid.

## CRT overlay (`src/render/crt.ts` + `crt.css`)

The retro-terminal finish is a pure CSS layer that sits above the canvas and
never captures mouse events. `mountCrt(parent)` appends a
`<div class="crt" aria-hidden="true">` with two children — `.crt-scan` and
`.crt-glow` — and returns the outer div. It imports `./crt.css`. Disable with
`?crt=0`.

| Layer       | Element       | What it does                                                        |
|-------------|---------------|---------------------------------------------------------------------|
| Container   | `.crt`        | `position: fixed; inset: 0; pointer-events: none; z-index: 5` — full-screen, click-through, above the canvas. |
| Scanlines   | `.crt-scan`   | `repeating-linear-gradient` 3px bands with `mix-blend-mode: multiply` for faint horizontal lines. |
| Vignette + glow | `.crt-glow` | Inset box-shadow: a dark 140px vignette around the edges plus a soft 24px green `rgba(72,224,106,.1)` phosphor bloom. |
