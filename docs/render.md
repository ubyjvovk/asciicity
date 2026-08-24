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

## Themes (`theme`)

`G` (or `?theme=` / `?gloom=1`) cycles the colour theme: **0 cyber** (black
cyberspace), **1 gloom** (darker structures, more retained colour, for overcast
days), **2 solarized** (muted ink on cream, almost wireframe-like). The change
is purely in the fragment shader: a `float theme` uniform (0/1/2) selects one
of three colour paths. Glyph density (`idx`) is unchanged, so empty cells
become the theme's background (mask 0 → background colour).

`AsciiOptions` gains `theme: number` (default 0); `AsciiRenderer` exposes
`get theme(): number` and `setTheme(t: number): void` which update the
uniform. The `theme` uniform is a float so the JS mirror and GLSL ternary agree
(`theme < 0.5 ? normal : (theme < 1.5 ? gloom : solarized)`). The terminal
lines of the fragment shader are:

```glsl
vec3 normalCol = tint * mask;
float lumT = dot(tint, vec3(0.299, 0.587, 0.114));
float hot = smoothstep(0.92, 1.0, clamp(v, 0.0, 1.0)); // sun/moon/lit windows stay bright
vec3 gWash = mix(vec3(lumT), tint, 0.75) * 0.20;        // darker + more colour than T-0037
vec3 gGlyph = mix(gWash, tint * 0.9, hot);
vec3 gloomCol = mix(vec3(0.72, 0.73, 0.75), gGlyph, mask);
vec3 sInk = mix(vec3(0.396, 0.482, 0.514), tint, 0.5) * 0.75; // solarized base00 ink
vec3 sGlyph = mix(sInk, vec3(0.71, 0.54, 0.0), hot);          // hot → solarized yellow
vec3 solCol = mix(vec3(0.992, 0.965, 0.890), sGlyph, mask);   // base3 paper
vec3 outCol = theme < 0.5 ? normalCol : (theme < 1.5 ? gloomCol : solCol);
gl_FragColor = vec4(outCol, 1.0);
```

`v` is the already-exposed max-channel brightness computed earlier in the
shader (`v = max(max(c.r, c.g), c.b)`) — the hot-highlight `smoothstep` reuses
it rather than recomputing anything.

### The three themes and their constants

| Theme | Value | Background (mask 0) | Glyph (mask 1)                                                      | Hot cells (`v → 1`)      |
|-------|-------|---------------------|---------------------------------------------------------------------|--------------------------|
| cyber | `0`   | black               | `normalCol = tint * mask`                                            | —                        |
| gloom | `1`   | `[0.72, 0.73, 0.75]` grey | `gWash = mix(lumT, tint, 0.75) * 0.20`, blended up by `mask` | `tint * 0.9` (bright)    |
| solarized | `2` | `[0.992, 0.965, 0.890]` base3 paper | `sInk = mix(base00, tint, 0.5) * 0.75`, blended up by `mask` | `[0.71, 0.54, 0.0]` yellow |

Solarized base00 ink is `[0.396, 0.482, 0.514]`.

The pure helper `themeMix(tint, v, mask, theme): [number, number, number]`
implements exactly these lines (including the `smoothstep`)
for unit tests — it is reviewed against the GLSL term-for-term.
(PM: `docs/architecture.md` §4.8 carries the same block — needs a matching update after accept.)

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
