# Integration (src/main.ts)

Notes for the bootstrap in `src/main.ts`: what the app does when the page
loads, which URL parameters it reads, the `window.__asciicity` contract used
by the e2e test, and the recipe for adding a new world layer. The signatures
of every module it wires are in `docs/architecture.md`; this file is only the
composition.

## Startup sequence

The app runs a single asynchronous `main()` when the module executes.

1. **Locate DOM.** Find `#view` (canvas), `#hud` (panel root), `#overlay`
   (title/prompt). Any missing element is a hard error.
2. **Parse URL** (`window.location.search`) into `UrlOptions` — see
   [URL parameters](#url-parameters).
3. **Choose city.** With `?synthetic=1`, call `syntheticCity(seed)`. Otherwise
   `loadCity(BASE_URL + 'data/city.json')`; on any failure log a
   `console.warn` and fall back to `syntheticCity(seed)`.
4. **Build the scene.** `makeRenderer(canvas)`, `makeScene()`,
   `makeCamera(aspect)`; set `camera.rotation.order = 'YXZ'` (architecture §5).
   Add three meshes:
   - `makeGround()`
   - `makeRoadsObject(city.roads)`
   - `makeBuildingsObject(city.buildings, makeWindowTexture())`
5. **Wire helpers.** `new CollisionGrid(city.buildings)`,
   `new ZoneIndex(city.roads, city.places, 50, city.buildings)`,
   `new Controls(canvas)`, `new Hud(hudRoot)`,
   `new AsciiRenderer(renderer, { cellW?, cellH? })`.
   When `minimap` is enabled (default), append a `<canvas id="minimap">` to
   `#hud` from `main.ts` (after `Hud` has already inserted the title, rows,
   and help line — the canvas is not in `index.html` so it stays below those
   nodes) and construct `new Minimap(canvas, city)`. When `crt` is enabled
   (default), `mountCrt(document.body)`.
6. **Pick a spawn.** Start at `(0, 0)`. If `collision.blocked([0, 0])`, walk
   `+x` in 1 m steps up to 200 m and take the first free spot. Initial pose:
   `{ x: spawn, z: 0, yaw: -π/2, pitch: 0 }` (facing west, per §5 step 2).
7. **Publish** `window.__asciicity` (see contract below).
8. **Resize.** Call the size handler once and register it on `window`
   `resize`. The handler forwards to `AsciiRenderer.setSize`, updates the
   camera aspect, and refreshes `cols`/`rows` on the API.
9. **Overlay + pointer lock.** The overlay starts visible with the title +
   `CLICK TO ENTER`; a click hides it and requests pointer lock on the
   canvas. On `pointerlockchange` losing the lock (Escape), the overlay
   reappears with class `resume` and text `CLICK TO RESUME`.
10. **Frame loop.** See below.

## Frame loop

`requestAnimationFrame` drives the loop. Each frame:

- `dt = min(0.1, (now - lastTs) / 1000)` — clamps huge deltas after tab
  restore.
- `input = controls.readInput()` — accumulates and zeroes look deltas.
- `next = stepPlayer(state, input, dt, resolveMove)` — pure step; scalar
  fields are copied back into the persistent `state` so
  `window.__asciicity.state` stays a stable reference.
- Camera update — position `(state.x, 1.7, state.z)`, rotation
  `y = -state.yaw, x = state.pitch` (with `YXZ` order set at bootstrap).
- `ascii.render(scene, camera)` — the ASCII post-process.
- Rolling FPS — accumulate frame count and elapsed seconds; when the window
  exceeds 1 s, publish `api.fps = frames / elapsed` and reset the window.
- HUD every 4th frame — mutate a persistent `HudValues` in place with
  `sectorOf`, `formatWorld`, `formatBearing(yawToBearingDeg(...))`,
  `zone.zoneLabel`, and
  `zone.nearestLandmark(state.x, state.z, state.yaw)?.name ?? undefined`,
  then `hud.update(hudValues)` and, when enabled, `minimap.update(state)`.
- After the first successful frame, set `api.ready = true`.

The `resolveMove` closure is created once (captures `collision`) so the loop
does not allocate a fresh arrow per frame. Aside from `stepPlayer`'s returned
`PlayerState` and the `nearestLandmark` result object (every 4th frame), no
per-frame allocations are made inside `main.ts`.

## URL parameters

| Name        | Example        | Effect                                                     |
|-------------|----------------|------------------------------------------------------------|
| `synthetic` | `?synthetic=1` | Skip the fetch and use `syntheticCity()` unconditionally.  |
| `seed`      | `?seed=42`     | Passed to `syntheticCity(seed)` — deterministic output.    |
| `cell`      | `?cell=8x16`   | Overrides the ASCII cell size (`cellW × cellH` in pixels). |
| `crt`       | `?crt=0`       | Disable the CRT scanline/vignette overlay (default on).    |
| `minimap`   | `?minimap=0`   | Disable the heading-up minimap under the HUD (default on). |
| `at`        | `?at=gherkin`  | Spawn at a landmark preset (name) or `lon,lat[,bearing]`
                 coordinate instead of Bank (ignored with `synthetic`). |

### Spawn presets (`?at=<name>`)

`?at=` accepts a preset name (case-insensitive, trimmed) or a
`lon,lat[,bearing]` coordinate. Preset keys and labels:

| Key          | Lon      | Lat      | Bearing° | Label                                      |
|--------------|----------|----------|----------|--------------------------------------------|
| `bank`       | −0.0887  | 51.5133  | 270      | Bank junction                              |
| `stpauls`    | −0.0950  | 51.5139  | 270      | Cheapside, facing St Paul's                |
| `gherkin`    | −0.0800  | 51.5132  | 0        | St Mary Axe, facing the Gherkin            |
| `monument`   | −0.0859  | 51.5098  | 0        | Monument                                   |
| `tower`      | −0.0760  | 51.5095  | 180      | Tower Hill                                 |
| `barbican`   | −0.0930  | 51.5185  | 0        | Barbican                                   |
| `liverpoolst`| −0.0830  | 51.5178  | 90       | Liverpool Street                           |
| `leadenhall` | −0.0845  | 51.5128  | 90       | Leadenhall Market                          |

Coordinate form: `?at=lon,lat[,bearing]`, e.g. `?at=-0.0984,51.5138,90`
(bearing in degrees; defaults to 0 / north if omitted). Presets and
coordinates are ignored when `?synthetic=1`.

Combine freely, e.g. `?synthetic=1&seed=3&cell=6x12&crt=0&minimap=0`.

## `window.__asciicity`

Declared in `main.ts` via `declare global`; the e2e smoke test (T-0011) waits
for `ready === true` and reads the other fields.

```ts
interface Window {
  __asciicity: {
    ready: boolean;    // false until the first frame has rendered
    state: PlayerState; // live reference — same object every frame
    fps: number;       // 1 s moving-average frames per second (0 until first window closes)
    cols: number;      // AsciiRenderer.cols after the last resize
    rows: number;      // AsciiRenderer.rows after the last resize
  };
}
```

The `state` reference is stable: fields are mutated in place, so a test
holding on to it always sees the latest pose without re-reading the property.

## Adding a new world layer

Layers today are three meshes added to the scene at step 4. To add another
(e.g. street furniture, a landmark spotlight, a minimap indicator on top):

1. **Write the module.** Follow the split used by `world/buildings.ts` —
   a pure `buildXMesh(...)` returning `MeshData` (unit-testable in node)
   plus a thin `makeXObject(...)` that wraps it in a `THREE.Mesh` or
   `THREE.Object3D`. Reuse `MeshBuilder` / `toGeometry` from
   `src/world/mesh.ts` (PM-owned).
2. **Feed it real data.** Extend the ticket-owned data-format if the layer
   needs new arrays on `CityData` (the file is PM-owned; block with a
   question rather than editing it in-line).
3. **Add tests.** `tests/<module>.test.ts` in vitest, covering each case
   named in the layer's ticket by name.
4. **Wire it in `main.ts`.** After the existing three `scene.add(...)`
   calls, add one more. If the layer needs to opt in on a URL flag, extend
   `parseUrlOptions` first.
5. **Update this file.** New URL parameters and any new
   `window.__asciicity` fields belong in the tables above.

Do not touch `src/world/mesh.ts` or `src/data/types.ts` directly — they are
PM-owned; propose changes through a ticket instead.

## Assets

- `public/favicon.svg` — the tab/shorthand icon. A 64×64 SVG: black square
  (`#000`) with a 1 px `#1f5a2a` inner border and a bold monospace `@` glyph
  in `#48e06a`, centred. Linked from `index.html` via
  `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`, which Vite
  rewrites with `base` at build time so it resolves under the GitHub Pages
  prefix. Kept under 1 KB with no external references.
