# Rendering — scene constants and ASCII post-process

Reference for the two files in `src/render/`. The exports and shader are
contract-locked in `docs/architecture.md` §§4.8 and 6; this file explains how
they fit together and where to twist the knobs.

## Pipeline

```
       ┌──────────────────────────────────────────────────────────┐
       │  scene (buildings/roads/ground meshes + fog + 3 lights)  │
       └──────────────────────────────────────────────────────────┘
                                    │  makeCamera(aspect)
                                    ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  WebGLRenderTarget(cols, rows)   NearestFilter, no MSAA       │
   │      cols = floor(width / cellW), rows = floor(height / cellH)│
   └───────────────────────────────────────────────────────────────┘
                                    │  full-screen quad (2×2 plane)
                                    │  orthographic camera (-1..1)
                                    ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  ASCII fragment shader                                        │
   │    tScene = scene target texture                              │
   │    tAtlas = one row of `count` glyph tiles, LinearFilter      │
   │    per cell: sample scene at cell centre → luminance          │
   │              gamma-shape → glyph index → sample atlas mask    │
   │              tint = colour hue · (0.35 + 1.8·lum) · mask      │
   └───────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                            canvas (width × height)
```

`AsciiRenderer.render(scene, camera)` performs the two passes with no
per-frame allocation. The scene render target is recreated only when the cell
grid changes size (`setSize` recomputes `cols/rows`).

## Changing the ramp or cell size

Both are constructor options on `AsciiRenderer`. The full option shape is
`AsciiOptions`:

| Option  | Default                                                       | Effect                                          |
|---------|---------------------------------------------------------------|-------------------------------------------------|
| `cellW` | `6`                                                           | Pixel width of one glyph cell.                  |
| `cellH` | `12`                                                          | Pixel height of one glyph cell.                 |
| `ramp`  | `DEFAULT_RAMP` (68 glyphs, space → `$`)                       | Character set from sparsest to densest.         |
| `font`  | `'bold 24px "DejaVu Sans Mono", "Courier New", monospace'`    | Canvas `ctx.font` used when rasterising atlas.  |
| `gamma` | `0.8`                                                         | Luminance-shaping exponent; `< 1` lifts mids.   |

- Smaller `cellW/cellH` → more cells per frame → sharper look but heavier
  fill. `cellW = 6, cellH = 12` at 1080p is roughly 320×90 cells.
- Custom `ramp` must start with the sparsest character (space) and end with
  the densest; ordering drives `glyphIndex`. Keep the length ≥ ~40 to avoid
  visible banding.
- `font` is applied to the atlas canvas exactly as written. Fallback fonts
  are important because the game runs in browsers without DejaVu.
- `gamma` re-shapes luminance before glyph selection. Match the shader's
  `pow(lum, gamma)` — the JS `glyphIndex` mirrors it so unit tests can
  predict the shader's output.

## Scene constants (`src/render/scene.ts`)

| Factory                | Value                                                                     |
|------------------------|---------------------------------------------------------------------------|
| `makeRenderer(canvas)` | `WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true })`, `setPixelRatio(1)`. |
| `makeScene()`          | Background `0x000000`; `FogExp2(0x000000, 0.0018)`; `AmbientLight(0xffffff, 0.45)`; `DirectionalLight(0xffffff, 1.1)` at `(1, 2, 0.5)`; `HemisphereLight(0x223344, 0x080808, 0.4)`. |
| `makeCamera(aspect)`   | `PerspectiveCamera(70, aspect, 0.3, 2000)`.                               |

`preserveDrawingBuffer: true` lets the e2e smoke test read canvas pixels;
`setPixelRatio(1)` keeps the render target size equal to the cell grid.

## Fragment shader

The verbatim shader lives in `src/render/ascii.ts` and is diffed by review.
Any tweak to the tint math (`tint = c / max(lum, 0.02)`, then
`tint * clamp(lum * 1.8 + 0.35, 0.0, 1.0)`) or the glyph-index formula
(`floor(clamp(pow(lum, gamma), 0, 1) * (glyphCount - 1) + 0.5)`) requires a
matching update to `glyphIndex` in TS and its unit tests.

## CRT overlay (`src/render/crt.ts` + `crt.css`)

The retro-terminal finish is a pure CSS layer that sits above the canvas and
never captures mouse events. `mountCrt(parent)` appends a
`<div class="crt" aria-hidden="true">` with two children — `.crt-scan` and
`.crt-glow` — and returns the outer div. It imports `./crt.css`; wiring it
into `main.ts`/`index.html` is a later ticket.

| Layer       | Element       | What it does                                                        |
|-------------|---------------|---------------------------------------------------------------------|
| Container   | `.crt`        | `position: fixed; inset: 0; pointer-events: none; z-index: 5` — full-screen, click-through, above the canvas. |
| Scanlines   | `.crt-scan`   | `repeating-linear-gradient` 3px bands with `mix-blend-mode: multiply` for faint horizontal lines. |
| Vignette + glow | `.crt-glow` | Inset box-shadow: a dark 140px vignette around the edges plus a soft 24px green `rgba(72,224,106,.1)` phosphor bloom. |

Nothing animates, so no `prefers-reduced-motion` handling is needed. To
disable it once wired, drop the `mountCrt` call (a `?crt=0` switch is planned
for a later ticket) or remove the element from the DOM — there is no runtime
toggle yet.
