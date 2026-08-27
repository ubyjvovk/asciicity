# Integration (src/main.ts)

Notes for the bootstrap in `src/main.ts`: what the app does when the page
loads, which URL parameters it reads, the `window.__asciicity` contract used
by the e2e test, and the recipe for adding a new world layer. The signatures
of every module it wires are in `docs/architecture.md`; this file is only the
composition.

## Startup sequence

The app runs a single asynchronous `main()` when the module executes.

1. **Locate DOM.** Find `#view` (canvas), `#hud` (panel root), `#overlay`
   (title/prompt). Any missing element is a hard error. `#gear` is in
   `index.html`; `#credits`, `#mini`, and the `#hit` input catcher are
   created here.
2. **Parse URL** (`window.location.search`) into `UrlOptions` — see
   [URL parameters](#url-parameters). Then `loadSettings(localStorage,
   searchParams)` (T-0060): URL wins, `localStorage['asciicity.settings']`
   fills gaps, defaults last. Malformed JSON and private-mode throws are
   ignored. The merged `hud` / `minimap` / `crt` / `render` / `city` overlay
   the URL options; `history.replaceState` mirrors the four toggle keys
   (`1`/`0`, omitted when they equal the default).
3. **Choose city.** `?synthetic=1` skips straight to `syntheticCity(seed, 12, hills)`
   (`?hills=1` toggles the deterministic heightfield). With a **valid**
   `?city=` (matched by `cityById`), `loadCity(BASE_URL + info.file)` for that
   entry; on a load failure log a `console.warn` and fall back to
   `syntheticCity(seed)`. With **no** `?synthetic=1` and **no** valid `?city=`
   (absent, empty, or an unknown id) the start overlay becomes a **city
   picker** (T-0046): one `.city` button per `CITIES` entry (label + blurb)
   plus keys `1`…`9` to select by index, and the prompt reads `CHOOSE A
   CITY`. Choosing writes `?city=<id>` into the URL with
   `history.replaceState` (keeping every other parameter) and then the boot
   continues — so data loading happens only after the choice. The chosen
   `CityInfo` id is surfaced on `window.__asciicity.city` (`'london'` /
   `'kyiv'` / `'synthetic'`); `?synthetic=1` never shows the picker.
4. **Build the scene.** `makeRenderer(canvas)`, `makeScene()`,
   `makeCamera(aspect)`; set `camera.rotation.order = 'YXZ'` (architecture §5).
   Compute the walkable `HeightFn` (`groundAt`): with `city.terrain`
   present, `terrain = new Terrain(city.terrain)`,
   `decks = new BridgeDecks(city.roads, terrain.heightAt)`, and
   `groundAt = makeGroundAt(terrain, decks)`; otherwise `groundAt = FLAT_HEIGHT`
   (London / synthetic-without-`hills` behaviour is byte-identical). Add
   the world meshes, passing `groundAt` to every draped builder:
   - `makeGround()` — with terrain, `.position.y = terrain.min − 0.5` (void
     filler under the heightfield)
   - `makeTerrainObject(terrain.data)` — only when terrain is present
   - `makeRoadsObject(city.roads, groundAt)`
   - `makeBuildingsObject(city.buildings, makeWindowTexture(), groundAt)`
   - `makeWaterObject(city.water, city.waterLevels)` when `city.water?.length` is truthy
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
   `new StyleRenderer(renderer, STYLES, { initial: opts.render, cellW?, cellH? })`
   — `opts.render` comes from `?render=` (with `?theme=` / `?gloom=1` as
   aliases; unknown → `ascii`). `R` cycles forward, `Shift+R` backward; a
   `#toast` shows `RENDER: <LABEL>` for 1.5 s on every change.
   Always append `<div id="mini"><canvas id="minimap"></canvas></div>` to
   `document.body` and construct `new Minimap(canvas, city)` (T-0060: the
   panel is created even when off). Hide `#mini` with `display: none` when
   `settings.minimap` is false. Always `mountCrt(document.body)` and
   `setCrt(el, settings.crt)` so the CRT overlay can be toggled without
   re-mounting. `#hud` is hidden the same way when `settings.hud` is false.
6. **Pick a spawn.**
   `resolveSpawn(opts.at, city.origin, collision.blocked, city, cityInfo.defaultSpawn)`
   with `?synthetic=1` short-circuiting to `(0, 0, −π/2)`. The city's own
   `defaultSpawn` (London → `bigben`, Kyiv → `maidan`) is the fallback used
   when `?at=` is absent, unknown, a building preset with no match, or a
   preset/coordinate whose WGS84 point falls **outside `city.bbox`** — a
   London preset in Kyiv drops back to `maidan` rather than dropping the
   player 2 000 km into the void. A blocked spawn walks `+x` in 1 m steps up
   to 200 m. Initial pose: `{ x: spawn.x, z: spawn.z, yaw: spawn.yaw, pitch: 0 }`.
   With bridge corridors in the grid, the default `bigben` spawn stays on
   Westminster Bridge (it is on a corridor, so `blocked` is false and no +x
   walk happens), and the player can walk across the Thames.
7. **Publish** `window.__asciicity` (see contract below).
8. **Resize.** Call the size handler once and register it on `window`
   `resize`. The handler forwards to `StyleRenderer.setSize`, updates the
   camera aspect, and refreshes `cols`/`rows` on the API.
9. **Overlay + pointer lock.** The overlay starts visible with the title +
   `CLICK TO ENTER` (or, before a city is chosen, the picker showing
   `CHOOSE A CITY`); a click (or tap) hides it and requests pointer lock on
   the canvas inside try/catch, because pointer lock rejects on touch
   devices. On `pointerlockchange` losing the lock (Escape), the overlay
   reappears with class `resume`, text `CLICK TO RESUME`, and the **pause /
   settings menu** populated into `#menu` (HUD / MINIMAP / CRT / STYLE / FLY
   / LANDMARKS stub / COPY LINK TO HERE / SWITCH CITY — see
   [City picker & pause menu](#city-picker--pause-menu)). The ⚙ `#gear`
   button (bottom-right, every platform) also opens this overlay: it calls
   `document.exitPointerLock()` on desktop so the existing resume path
   fires, and just shows the overlay on touch. Gear `pointerdown`/`click`
   stop propagation so `TouchControls` never sees the tap. All chrome
   (`#mini`, `#hud`, `#gear`, `#credits`, `#toast`) sits at z-index 5 above
   the canvas (`#view` at 0). `#view` is `pointer-events: none`; look and
   the joystick attach to `#hit` (z-index 1). The CRT overlay is below the
   chrome (`pointer-events: none`); `#overlay` is above those (z-index 10).
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
- `next = stepPlayer(state, input, dt, resolveMove, groundAt)` — pure step
  (including fly/toggle and fall); scalar fields are copied back into the
  persistent `state` so `window.__asciicity.state` stays a stable reference.
- Camera update — position `(state.x, state.y, state.z)`, rotation
  `y = -state.yaw, x = state.pitch` (with `YXZ` order set at bootstrap).
  Then one no-allocation line `sky.position.set(state.x, state.y, state.z)` so
  the sky group rides with the camera at the same eye height. `api.y` is
  refreshed with the eye height every frame and `api.fly` with the fly state
  so headless tests can read them from `window.__asciicity`.
- `fleet.update(dt)` — each frame, before the ASCII render, the bus
  ambience (`BusFleet`, docs/world.md §Traffic) advances every walker by
  `dt · 7` m and writes its instance matrices via a single reused dummy.
- `post.render(scene, camera)` — the active render-style post-process.
- Rolling FPS — accumulate frame count and elapsed seconds; when the window
  exceeds 1 s, publish `api.fps = frames / elapsed` and reset the window.
- HUD every 4th frame — mutate a persistent `HudValues` in place with
  `sectorOf`, `formatWorld`, `formatBearing(yawToBearingDeg(...))`,
  `zone.zoneLabel`, and the altitude/mode rows:
  - `alt` (eye altitude) — when `city.terrain` is present,
    `formatAlt(city.terrain.datum + state.y − EYE_HEIGHT, 'ASL')`;
    else while flying `formatAlt(agl, 'AGL')`; otherwise `undefined` (cleared)
    so the panel stays six rows on flat London.
  - `mode` — `state.fly ? 'FLY' : undefined` (MODE row between LANDMARK and FPS).
  Then
  `zone.nearestLandmark(state.x, state.z, state.yaw)?.name ?? undefined`,
  followed by `hud.update(hudValues)` when `settings.hud` is on, and
  `minimap.update(state)` when `settings.minimap` is on. Hidden panels skip
  their per-frame update.
- After the first successful frame, set `api.ready = true`.

The `resolveMove` closure is created once (captures `collision`) so the loop
does not allocate a fresh arrow per frame. Aside from `stepPlayer`'s returned
`PlayerState` and the `nearestLandmark` result object (every 4th frame), no
per-frame allocations are made inside `main.ts`.

## URL parameters

| Name        | Example        | Effect                                                     |
|-------------|----------------|------------------------------------------------------------|
| `city`      | `?city=kyiv`   | Load a specific dataset from the [CITIES](../src/data/cities.ts) registry (`london`, `kyiv`). Trimmed + case-insensitive. Absent or invalid (`no picker for ?synthetic=1`) → the city picker (T-0046); a valid id boots that city directly. Ignored when `?synthetic=1`. |
| `synthetic` | `?synthetic=1` | Skip the fetch and use `syntheticCity()` unconditionally.  |
| `hills`     | `?hills=1`     | Only meaningful with `?synthetic=1`: switch the deterministic city to `syntheticCity(seed, 12, true)` so the heightfield code paths run without a real dataset. |
| `seed`      | `?seed=42`     | Passed to `syntheticCity(seed)` — deterministic output.    |
| `cell`      | `?cell=8x16`   | Overrides every style's cell size (`cellW × cellH` in pixels). |
| `crt`       | `?crt=0`       | Hide the CRT scanline/vignette overlay (default on; toggle from the ⚙ menu). |
| `minimap`   | `?minimap=0`   | Hide the top-left `#mini` panel (default on). The canvas is still created. `M` toggles. |
| `hud`       | `?hud=0`       | Hide the NAVIGATION panel and skip its per-frame updates; the rest of the app still runs (default on). `H` toggles. |
| `render`    | `?render=solarized` | Start render style (`ascii`, `gloom`, `solarized`, `braille`, `blocks`, `teletext`, `dither`, `gameboy`, `pico8`, `edges`, `hatch`, `matrix`). Unknown or absent → `ascii`. Wins over `theme` / `gloom`. |
| `gloom`     | `?gloom=1`     | Alias for `?render=gloom` when `render` is absent. Ignored when `theme` or `render` is present. |
| `theme`     | `?theme=solarized` | Alias for `?render=`: `cyber`/`0` → `ascii`, `gloom`/`1` → `gloom`, `solarized`/`2` → `solarized`. `render` wins when both are present. |
| `time`      | `?time=2026-06-21T12:00:00Z` or `?time=12:00` | Pin the sky to a fixed time. Accepts an ISO timestamp (pinned absolute instant) or `HH:MM` meaning *today* in local time. Invalid or absent → real clock (default). |
| `at`        | `?at=gherkin`  | Spawn at a landmark preset (name) or `lon,lat[,bearing]`
                 coordinate instead of Bank (ignored with `synthetic`). |
| `fly`       | `?fly=1`       | Take off immediately — boot with `fly = true` (airborne, longer
                 camera far plane; see [Fly mode](#fly-mode--fog)). Default off. |

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
`barbican`, `liverpoolst`, `leadenhall`, `walkietalkie`, `lloyds`,
`sophia`, `michael`): the named building is located in the loaded dataset
by a case-insensitive substring match on `Building.name`, its centroid
computed, and the game spawns on the nearest road vertex ~70 m away from
it (falling back to any road vertex within 200 m), facing the building. If
the building is absent from the bbox (e.g. `tower`), the preset falls back
to the current city's `defaultSpawn` (London → `bigben`, Kyiv → `maidan`)
— nothing is logged. `sophia` and `michael` also carry a static
coordinate fallback in case the OSM name changes upstream.

With no `?at=` the game spawns at the current city's `defaultSpawn`
(London → `bigben` on Westminster Bridge, Kyiv → `maidan` on Maidan
Nezalezhnosti). A preset or coordinate whose WGS84 point falls **outside
`city.bbox`** (e.g. a London preset while `?city=kyiv`) drops back to the
same city fallback rather than teleporting the player 2 000 km into the
void.

Coordinate form: `?at=lon,lat[,bearing]`, e.g. `?at=-0.0984,51.5138,90`
(bearing in degrees; defaults to 0 / north if omitted). Presets and
coordinates are ignored when `?synthetic=1`.

Combine freely, e.g. `?synthetic=1&seed=3&cell=6x12&crt=0&minimap=0`.

### Kyiv presets

Available with `?city=kyiv&at=<name>`. Coordinate presets are fixed WGS84
points; building presets resolve against `kyiv.json` via `landmarkSpawn`
and fall back to their listed coordinates if the name goes missing.

| Key            | Kind        | Description                                                                 |
|----------------|-------------|-----------------------------------------------------------------------------|
| `maidan`       | coordinate  | Maidan Nezalezhnosti, facing Hotel Ukraina (default).                       |
| `sophia`       | building    | Facing Saint Sophia Cathedral (`Sophia`).                                   |
| `michael`      | building    | Facing St Michael's Golden-Domed Monastery (`Michael`).                     |
| `lavra`        | coordinate  | Pechersk Lavra, facing the Great Bell Tower.                                |
| `motherland`   | coordinate  | Facing the Motherland Monument.                                             |
| `podil`        | coordinate  | Kontraktova Square, Podil.                                                  |
| `andriyivskyy` | coordinate  | Top of Andriyivskyy Descent, facing St Andrew's Church.                     |
| `goldengate`   | coordinate  | Facing the Golden Gate.                                                     |
| `arsenalna`    | coordinate  | Arsenalna, the deepest metro station.                                       |
| `parkbridge`   | coordinate  | Parkovyi Bridge first vertex, facing Trukhaniv Island (bearing 33°).        |
| `glassbridge`  | coordinate  | Klitschko glass bridge first vertex, facing the Arch (bearing 286°).        |
| `mariinsky`    | coordinate  | Facing Mariinsky Palace.                                                    |
| `bessarabka`   | coordinate  | Bessarabska Square, looking down Khreshchatyk.                              |
| `funicular`    | coordinate  | Funicular lower station, looking up.                                        |
| `hydropark`    | coordinate  | Hydropark, facing the right-bank hills.                                     |
| `metrobridge`  | coordinate  | Metro Bridge over the Dnipro.                                               |

## City picker & pause menu

Both the start picker and the pause menu render into the `#menu` div in the
start overlay (`index.html`): a column of `button` elements, HUD green on
black with a 1 px green border, monospace, letter-spaced like the overlay
prompt. On the compact/mobile breakpoint (max-width 700 px, as the HUD panel)
the buttons and the share input stack full-width.

### City picker

With no `?synthetic=1` and no *valid* `?city=` the start overlay becomes a
picker: one `button.city` per `CITIES` entry, each with a `<label>` on the
first line and a smaller `<blurb>` below. Keys `1`…`9` select by index.
Choosing calls `history.replaceState` with the current query plus
`city=<id>` (every other parameter kept, so `?render=gloom` survives the
choice) and boots that city. Data loading happens only after the choice.
`?synthetic=1` or a valid `?city=` skips the picker entirely. A city id
remembered in `localStorage` also skips the picker when the URL has no
`city` (URL still wins). **SWITCH CITY** clears the stored city so the
picker comes back.

### Pause / settings menu

Losing pointer lock (Esc) **or** clicking the ⚙ `#gear` button shows the
resume overlay (`CLICK TO RESUME`) with these rows in `#menu` (architecture
§4.12), all of which sit inside the container-level `stopPropagation()`
guard so the overlay's own click-to-resume does not fire:

- **HUD: ON/OFF** — toggles `#hud` (`display: none`) and skips its per-frame
  update. Same path as the `H` key.
- **MINIMAP: ON/OFF** — toggles `#mini`. Same path as the `M` key.
- **CRT: ON/OFF** — `setCrt` on the already-mounted overlay.
- **STYLE: \<LABEL\> ▸** — `StyleRenderer.next(1)` (same as `R`).
- **FLY: ON/OFF** — flips `state.fly` (same as `F`; `stepPlayer` stays
  pure).
- **LANDMARKS ▸** — stub for T-0061 (does nothing yet).
- **COPY LINK TO HERE** — calls `buildShareUrl(window.location.href,
  city.id, state, city.origin)`, best-effort `navigator.clipboard.writeText`,
  copies the URL into a read-only `<input id="share">` under the buttons and
  selects it, and shows `COPIED` for 1.5 s.
- **SWITCH CITY** — writes `settings.city = null` to storage, then
  navigates to `location.pathname` plus the current query minus `city` and
  `at` (i.e. back to the picker; empty search → just the pathname).

Every HUD / minimap / CRT / style change is written to
`localStorage['asciicity.settings']` as `{ hud, minimap, crt, render, city }`
and mirrored onto the URL (`hud`/`minimap`/`crt`/`render` only) via
`history.replaceState`, so COPY LINK TO HERE carries the live toggles.
`window.__asciicity.settings` is the live object. URL parameters still win
on the next boot; storage fills whatever the URL left unset.

### Credits

`src/credits.ts` exports `CREDITS = { author, url }` — the only file to
edit to rebrand. `main.ts` mounts `<a id="credits" href target="_blank"
rel="noopener">built by @ubyjvovk · github.com/ubyjvovk/asciicity</a>` as a
bottom-centre footer. Clicks stop propagation.

### Share URL format

`buildShareUrl` (`src/hud/share.ts`, pure) turns the live `href` plus the
player pose into a URL that reopens the same city at the exact spot and
heading. It keeps only `render`, `time`, `cell`, `crt`, `minimap`, `hud` from
`href` (in that order, when present) and drops everything else, then adds
`city=<id>` and `at=<lon 5dp>,<lat 5dp>,<bearing whole degrees>` — lon/lat
from `unproject(x, z, origin)` (`src/geo.ts`), bearing from
`Math.round(yawToBearingDeg(yaw))`. It returns `origin + pathname + '?' +
params` (any hash dropped) with literal commas in `at` (so `parseAt` +
`project` round-trip within 1 m).

Example: looking east (`yaw = π/2`) at local `(100, −50)` in Kyiv
(`origin 50.4501, 30.5234`):

```
/?render=gloom&city=kyiv&at=30.52481,50.45055,90
```

## Fly mode & fog (T-0049)

`?fly=1` boots airborne (`state.fly = true`); otherwise `F` toggles flight
per press (§4.7). The frame loop follows each step:

- `agl = state.y − EYE_HEIGHT − groundAt(state.x, state.z)` (metres above
  the walkable ground).
- Fog density is `0.0018 / (1 + agl / 150)` — unchanged at ground level,
  roughly halving by ~150 m AGL so the whole city stays visible from above.
  Guarded by `instanceof THREE.FogExp2` (the flat London world uses the same
  `FogExp2`).
- Camera `y` (and the sky group) follow `state.y`, not `groundAt + 1.7`.
- On each fly toggle `camera.far = fly ? 6000 : 2000` and
  `camera.updateProjectionMatrix()` — the far viewpoint from altitude needs
  the longer plane.
- `window.__asciicity` exposes `fly` (live) and `y` (eye height, absolute).
- HUD `mode = fly ? 'FLY' : undefined` (MODE row between LANDMARK and FPS);
  `alt` (the **eye altitude** — where the camera is, not the ground below) =
  `formatAlt(terrain.datum + state.y − EYE_HEIGHT, 'ASL')` on terrain cities,
  or `formatAlt(agl, 'AGL')` while flying on flat cities (cleared
  otherwise).

No collision while airborne (noclip); `Space`/`C` climb/descend, `Shift` is
`FLY_SPRINT_SPEED`; leaving fly mode falls at constant `FALL_SPEED` until the
ground catches the player.

## Keyboard

| Key | Effect                                   |
|-----|------------------------------------------|
| `R` | Next render style (`STYLE_ORDER`). A toast `#toast` shows `RENDER: <LABEL>` for 1.5 s. Persisted. |
| `Shift+R` | Previous render style. |
| `H` | Toggle the NAVIGATION panel (`#hud`). Ignored while the city picker is open; no key-repeat. Persisted. |
| `M` | Toggle the minimap panel (`#mini`). Same rules as `H`. |
| `1`…`9` | On the start picker only: choose city by index. |
| `F` | Toggle fly mode (noclip flight).         |
| `Space` / `C` | Climb / descend while flying (`Space` also `preventDefault`s). |

## `window.__asciicity`

Declared in `main.ts` via `declare global`; the e2e smoke test (T-0011) waits
for `ready === true` and reads the other fields.

```ts
interface Window {
  __asciicity: {
    ready: boolean;    // false until the first frame has rendered
    state: PlayerState; // live reference — same object every frame
    fps: number;       // 1 s moving-average frames per second (0 until first window closes)
    y: number;         // eye height in metres — state.y, follows the camera in fly mode
    fly: boolean;      // true while flying (T-0049)
    city: string;      // 'london' | 'kyiv' | 'synthetic' (added T-0045)
    render: string;    // live style id (`ascii`, `gloom`, …) — updates on R
    styles: string[];  // ids in STYLE_ORDER (R-cycle order)
    settings: Settings; // live { hud, minimap, crt, render, city } (T-0060)
    cols: number;      // StyleRenderer.cols after the last resize / style change
    rows: number;      // StyleRenderer.rows after the last resize / style change
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
