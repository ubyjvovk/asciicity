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
   `new ZoneIndex(city.roads, city.places)`, `new Controls(canvas)`,
   `new Hud(hudRoot)`, `new AsciiRenderer(renderer, { cellW?, cellH? })`.
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
  `sectorOf`, `formatWorld`, `formatBearing(yawToBearingDeg(...))`, and
  `zone.zoneLabel`, then `hud.update(hudValues)`.
- After the first successful frame, set `api.ready = true`.

The `resolveMove` closure is created once (captures `collision`) so the loop
does not allocate a fresh arrow per frame. Aside from `stepPlayer`'s returned
`PlayerState`, no per-frame allocations are made inside `main.ts`.

## URL parameters

| Name        | Example        | Effect                                                     |
|-------------|----------------|------------------------------------------------------------|
| `synthetic` | `?synthetic=1` | Skip the fetch and use `syntheticCity()` unconditionally.  |
| `seed`      | `?seed=42`     | Passed to `syntheticCity(seed)` — deterministic output.    |
| `cell`      | `?cell=8x16`   | Overrides the ASCII cell size (`cellW × cellH` in pixels). |

Combine freely, e.g. `?synthetic=1&seed=3&cell=6x12`.

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
