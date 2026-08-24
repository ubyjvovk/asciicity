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
   Add the world meshes:
   - `makeGround()`
   - `makeRoadsObject(city.roads)`
   - `makeBuildingsObject(city.buildings, makeWindowTexture())`
   - `makeWaterObject(city.water)` when `city.water?.length` is truthy
   - `makeSky(opts.time ?? new Date(), city.origin)` — the sun/moon/stars sky (docs/world.md §Sky)
5. **Wire helpers.** `new CollisionGrid(buildings, 25, corridors)` where
   `buildings` is the building footprints, plus — when there is water — each
   water ring as a fake footprint so the player cannot walk onto the river:
   `[...city.buildings, ...city.water.map((poly, i) => ({ id: -1 - i, h: 1, poly }))]`.
   The 3rd argument is the corridor list built from bridge roads —
   `city.roads.filter(r => r.bridge).map(r => ({ pts: r.pts, halfWidth: ROAD_WIDTH[r.cls] / 2 + 1 }))`
   with `ROAD_WIDTH` imported from `src/world/roads.ts`. Corridors override
   footprints (water and buildings alike), so the player can cross the Thames
   on bridges (T-0030). Then
   `new ZoneIndex(city.roads, city.places, 50, city.buildings)`,
   `new Controls(canvas)`, and when `'ontouchstart' in window` or
   `navigator.maxTouchPoints > 0`, `new TouchControls(canvas)`. Then
   `new Hud(hudRoot)`,
   `new AsciiRenderer(renderer, { cellW?, cellH?, invert? })` — `invert` is taken from `?gloom=1`; afterwards the `G` key toggles `ascii.setInvert()`.
   When `minimap` is enabled (default), append a `<canvas id="minimap">` to
   `#hud` from `main.ts` (after `Hud` has already inserted the title, rows,
   and help line — the canvas is not in `index.html` so it stays below those
   nodes) and construct `new Minimap(canvas, city)`. When `crt` is enabled
   (default), `mountCrt(document.body)`.
6. **Pick a spawn.** Start at `(0, 0)`. If `collision.blocked([0, 0])`, walk
   `+x` in 1 m steps up to 200 m and take the first free spot. Initial pose:
   `{ x: spawn, z: 0, yaw: -π/2, pitch: 0 }` (facing west, per §5 step 2).
   With bridge corridors in the grid, the default `bigben` spawn stays on
   Westminster Bridge (it is on a corridor, so `blocked` is false and no +x
   walk happens), and the player can walk across the Thames.
7. **Publish** `window.__asciicity` (see contract below).
8. **Resize.** Call the size handler once and register it on `window`
   `resize`. The handler forwards to `AsciiRenderer.setSize`, updates the
   camera aspect, and refreshes `cols`/`rows` on the API.
9. **Overlay + pointer lock.** The overlay starts visible with the title +
   `CLICK TO ENTER`; a click (or tap — the click handler also fires on touch)
   hides it and requests pointer lock on the canvas inside try/catch, because
   pointer lock rejects on touch devices. On `pointerlockchange` losing the
   lock (Escape), the overlay reappears with class `resume` and text
   `CLICK TO RESUME`.
10. **Frame loop.** See below.

**Sky cadence.** The sky is built once during startup (`makeSky`, with the
pinned `?time=` if present, else the real clock). A `setInterval` fires every
**10 s** and calls `updateSky(sky, opts.time ?? new Date(), city.origin)` —
advancing the sun/moon/stars with the real clock, or holding them fixed at the
pinned instant when `?time=` is set. The sky group rides with the camera:
each frame, after the camera update, `sky.position.set(state.x, EYE_HEIGHT,
state.z)` so the discs stay 1200 m from the player (children keep
`dir·radius` relative to the group).

## Frame loop

`requestAnimationFrame` drives the loop. Each frame:

- `dt = min(0.1, (now - lastTs) / 1000)` — clamps huge deltas after tab
  restore.
- `input = controls.readInput()`, or when a `TouchControls` was constructed,
  `input = mergeInput(controls.readInput(), touch.readInput())` — each
  source accumulates and zeroes its own look deltas; `mergeInput` sums axes
  (clamped to [−1, 1]), ORs `sprint`, and sums look deltas.
- `next = stepPlayer(state, input, dt, resolveMove)` — pure step; scalar
  fields are copied back into the persistent `state` so
  `window.__asciicity.state` stays a stable reference.
- Camera update — position `(state.x, 1.7, state.z)`, rotation
  `y = -state.yaw, x = state.pitch` (with `YXZ` order set at bootstrap).
  Then one no-allocation line `sky.position.set(state.x, EYE_HEIGHT, state.z)`
  so the sky group rides with the camera.
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
| `hud`       | `?hud=0`       | Hide the NAVIGATION panel and skip its per-frame updates; the rest of the app still runs (default on). |
| `gloom`     | `?gloom=1`     | Start in gloom mode (inverted, washed-out grey rendering) — same effect as pressing `G` (default off). |
| `time`      | `?time=2026-06-21T12:00:00Z` or `?time=12:00` | Pin the sky to a fixed time. Accepts an ISO timestamp (pinned absolute instant) or `HH:MM` meaning *today* in local time. Invalid or absent → real clock (default). |
| `at`        | `?at=gherkin`  | Spawn at a landmark preset (name) or `lon,lat[,bearing]`
                 coordinate instead of Bank (ignored with `synthetic`). |

### Spawn presets (`?at=<name>`)

`?at=` accepts a preset name (case-insensitive, trimmed) or a
`lon,lat[,bearing]` coordinate. Preset keys and labels:

| Key           | Resolves to                                                            |
|---------------|------------------------------------------------------------------------|
| `bank`        | Fixed coordinate — Bank junction (yaw 270°).                           |
| `stpauls`     | Named building "St Paul's Cathedral" (data-driven).                   |
| `gherkin`     | Named building "30 St Mary Axe" (data-driven).                        |
| `monument`    | Named building "Monument" (data-driven).                              |
| `tower`       | Named building "Tower of London" (data-driven; may be absent → `bigben`).|
| `barbican`    | Named building "Barbican" (data-driven).                              |
| `liverpoolst` | Named building "Liverpool Street" (data-driven).                      |
| `leadenhall`  | Named building "Leadenhall Market" (data-driven).                     |
| `walkietalkie`| Named building "20 Fenchurch Street" (data-driven).                   |
| `lloyds`      | Named building "Lloyd's" (data-driven).                               |
| `bigben`      | Fixed coordinate — Westminster Bridge, facing Big Ben (yaw 268°).       |
| `parliament`  | Fixed coordinate — Parliament Square, facing the Palace of Westminster (yaw 90°). |
| `trafalgar`   | Fixed coordinate — Trafalgar Square, facing Whitehall (yaw 180°).       |
| `embankment`  | Fixed coordinate — Victoria Embankment, facing the London Eye (yaw 120°).|

**Data-driven presets** (`stpauls`, `gherkin`, `monument`, `tower`,
`barbican`, `liverpoolst`, `leadenhall`, `walkietalkie`, `lloyds`): the
named building is located in `city.json` by a case-insensitive substring
match on `Building.name`, its centroid computed, and the game spawns on the
nearest road vertex ~70 m away from it (falling back to any road vertex
within 200 m), facing the building. If the building is absent from the
bbox (e.g. `tower`), the preset falls back to `bigben` — nothing is logged.

With no `?at=` the game spawns at the `bigben` preset (Westminster Bridge,
facing Big Ben). The `bank` preset is still available as `?at=bank`.

Coordinate form: `?at=lon,lat[,bearing]`, e.g. `?at=-0.0984,51.5138,90`
(bearing in degrees; defaults to 0 / north if omitted). Presets and
coordinates are ignored when `?synthetic=1`.

Combine freely, e.g. `?synthetic=1&seed=3&cell=6x12&crt=0&minimap=0`.

## Keyboard

| Key | Effect                                   |
|-----|------------------------------------------|
| `G` | Toggle gloom mode (inverted, washed-out grey rendering). |

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

Layers today are ground, roads, buildings, and (when `city.water` is
non-empty) water, added to the scene at step 4. To add another
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
