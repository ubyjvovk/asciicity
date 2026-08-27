# AsciiCity — architecture & module contract

PM-owned design doc. Tickets cite sections of this file; when a ticket and
this file disagree, **flag it in your report** rather than guessing.

## 1. What it is

A static browser minigame: first-person walking around the City of London,
rendered as coloured ASCII glyphs (retro terminal look) with a green
"NAVIGATION" HUD on the right. No backend. Built with Vite + TypeScript +
three.js; deployed as static files (GitHub Pages).

Controls: `W/S` or `↑/↓` move, `A/D` strafe, `←/→` turn, mouse look after a
click (pointer lock), `Shift` sprint. HUD shows SECTOR, WORLD, BEARING, ZONE,
FPS.

## 2. Stack (locked)

| Concern      | Choice                                                     |
|--------------|------------------------------------------------------------|
| Build        | Vite 6, ESM, `base` from `process.env.VITE_BASE ?? '/'`     |
| Language     | TypeScript 5, `strict: true`, `module: ESNext`, `moduleResolution: Bundler`, `target: ES2022` |
| 3D           | `three` (latest), imported only as `import * as THREE from 'three'` or named imports from `'three'` |
| Unit tests   | Vitest, `environment: 'node'`, files `tests/**/*.test.ts`   |
| E2E          | `@playwright/test` **1.55.1 exactly** (matches the worker image's baked chromium-1193 at `/opt/pw-browsers`) |
| Lint gate    | `tsc --noEmit` (no eslint)                                  |
| Data         | `public/data/<city>.json` — see `docs/data-format.md` (London `city.json`, Kyiv `kyiv.json`) |

`package.json` / `package-lock.json` are **PM-owned after T-0001**: workers
never add or upgrade a dependency; if you need one, block with a question.

## 3. Coordinate system

Local metres relative to the origin (`docs/data-format.md`): `x` east,
`z` south, `y` up. **Yaw** (radians) is the player's heading: `0` faces north
(`−z`), `+π/2` faces east (`+x`). Forward vector:
`(sin(yaw), 0, −cos(yaw))`; right vector `(cos(yaw), 0, sin(yaw))`.
Bearing in degrees for the HUD: `((yaw · 180/π) % 360 + 360) % 360`.
Pitch is clamped to `±60°`. Eye height is `1.7` m (`EYE_HEIGHT` in controls.ts).

## 4. Layout & module contract

Pure/testable logic lives in functions that never touch `document`, `window`,
or WebGL; thin browser wrappers sit beside them. Signatures below are the
contract — implement them exactly (add helpers freely, keep these exports).

```
index.html                 canvas + HUD DOM skeleton, loads /src/main.ts
src/main.ts                bootstrap (T-0010): data → world → controls → ascii → hud → loop
src/style.css              black page, full-viewport canvas, right-hand HUD panel
src/geo.ts                 project/unproject (docs/data-format.md §Coordinate system)
src/data/types.ts          CityData & friends (PM-owned)
src/data/validate.ts       validateCity(raw: unknown): CityData — throws Error naming the offending path
src/data/synthetic.ts      syntheticCity(seed?, blocks?): CityData (deterministic, spec in data-format.md)
src/data/load.ts           loadCity(url: string, fetchImpl?: typeof fetch): Promise<CityData> (fetch → json → validateCity)
src/data/cities.ts         CITIES registry + cityById (§4.10, wave 5)
src/data/spawn.ts          SPAWN_PRESETS, parseAt, landmarkSpawn, resolveSpawn (per-city fallback, §4.10)
src/world/palette.ts       PALETTE, LANDMARK_PALETTE (readonly number[] hex), colorFor(b: Building): number
src/world/textures.ts      makeWindowTexture(): THREE.CanvasTexture (browser-only)
src/world/mesh.ts          MeshData, MeshBuilder, toGeometry (PM-owned; already written — use MeshBuilder)
src/world/buildings.ts     buildBuildingsMesh(buildings: Building[]): MeshData (pure); makeBuildingsObject(buildings, windowTex): THREE.Mesh
src/world/roads.ts         ROAD_WIDTH: Record<RoadClass, number>; buildRoadsMesh(roads: Road[]): MeshData (pure); makeRoadsObject(roads): THREE.Mesh
src/world/ground.ts        makeGridTexture(): THREE.CanvasTexture; makeGround(size?: number): THREE.Mesh (plane at y=0 with the grid texture)
src/world/terrain.ts       Terrain, buildTerrainGeometry, makeTerrainObject, bridgeProfile, BridgeDecks, makeGroundAt (§4.9, wave 5)
src/hud/share.ts           buildShareUrl (pure, §4.10)
src/world/collision.ts     pointInPolygon, distToSegment, class CollisionGrid { blocked(p, r?), resolve(from, to, r?) }
src/player/controls.ts     PlayerState, InputState, stepPlayer(...) (pure), class Controls (DOM), yawToBearingDeg(yaw)
src/render/scene.ts        makeRenderer(canvas), makeScene(), makeCamera() — lights, fog, camera constants (§6)
src/render/ascii.ts        DEFAULT_RAMP, glyphIndex(lum, count, gamma) (pure), buildGlyphAtlas(...), class AsciiRenderer
src/hud/format.ts          formatBearing, formatWorld, sectorOf, hudRow (pure)
src/hud/zone.ts            class ZoneIndex { nearestRoad, nearestPlace, zoneLabel }
src/hud/hud.ts             class Hud { constructor(root: HTMLElement); update(v: HudValues) }
scripts/test.sh            npm ci if node_modules missing, then `vitest run "$@"`
scripts/check.sh           full gate: install → typecheck → unit → build → e2e (if e2e/ exists)
scripts/fetch-osm.mjs      Overpass → city.json (CLI); scripts/osm-convert.mjs holds the pure conversion
tests/                     vitest unit tests (+ tests/fixtures/)
e2e/                       Playwright smoke test (T-0011), screenshots in e2e/__shots__/ (gitignored)
docs/                      this file, data-format.md, and per-module notes tickets ask for
```

### 4.1 MeshData (src/world/mesh.ts) — already written, PM-owned

`MeshData` = non-indexed triangle soup (`positions`, `normals`, `uvs`,
`colors` as Float32Arrays + `groups`). `MeshBuilder` accumulates vertices
(`vertex`, `triangle`, `quad`, `endGroup(materialIndex)`, `build()`);
`toGeometry(m)` wraps it in a `THREE.BufferGeometry`. Group `start`/`count`
are vertex counts. Buildings: group 0 = walls, group 1 = roofs; roads: a
single group 0. Read the file before using it.

### 4.2 Buildings (src/world/buildings.ts)

- Normalise each ring so `THREE.ShapeUtils.area(ring as Vector2[]) > 0`
  (reverse when negative). Skip rings with `|area| < 1`.
- **Terrain (wave 5)**: `buildBuildingsMesh(buildings, heightAt: HeightFn = FLAT_HEIGHT)`.
  Per building `base = min` and `top = max` of `heightAt(x, z)` over the
  ring's vertices; walls run from `y = base` to `y = top + h`, the roof sits
  at `y = top + h`. With `FLAT_HEIGHT` this is exactly the old `0 … h`.
- **Walls**: for each edge `a→b` of the normalised ring emit one quad (two
  triangles, 6 vertices) from `y=base` to `y=top+h`. Outward normal
  `n = normalize(b.z − a.z, 0, −(b.x − a.x))`. Triangle winding must be
  counter-clockwise seen from outside (`cross(v1−v0, v2−v0) · n > 0`).
  UVs: `u = cumulativeDistanceAlongRing / 24`, `v = (y − base) / 24` (one texture tile
  = 24 m × 24 m = 8 × 8 windows of 3 m).
- **Roofs**: `THREE.ShapeUtils.triangulateShape(ring, [])`; normal `(0,1,0)`,
  winding so `cross(...).y > 0`; uv `(0,0)`.
- Colour: `colorFor(building)` (§4.3) → `new THREE.Color(hex)`; write the
  linear `.r .g .b` for every vertex of that building.
- Groups: all wall triangles first (group 0), then all roof triangles (group 1).
- `makeBuildingsObject(buildings, windowTex, heightAt = FLAT_HEIGHT)` = one `THREE.Mesh(toGeometry(data), [wallMat, roofMat])`
  with `wallMat = MeshLambertMaterial({ vertexColors: true, map: windowTex })`
  and `roofMat = MeshLambertMaterial({ vertexColors: true, color: 0x606060 })`.
  One draw call per material for the whole city.

### 4.3 Palette (src/world/palette.ts)

```ts
export const PALETTE = [0x3a6fd8, 0x2ecc71, 0x1abc9c, 0xf1c40f, 0xe67e22, 0xc0392b, 0x9b59b6, 0x95a5a6] as const;
export const LANDMARK_PALETTE = [0x5dade2, 0xf7dc6f, 0xff6b6b, 0xda70d6] as const;
export const LANDMARK_COLORS: Readonly<Record<string, number>>  // exact OSM name → hex (T-0029; table in docs/world.md)
export function landmarkColor(name: string | undefined): number | undefined
export function colorFor(b: Building): number  // LANDMARK_COLORS[name] if present, else named → LANDMARK_PALETTE[id % 4], else PALETTE[id % 8]
```

### 4.4 Textures (src/world/textures.ts, browser-only)

- `makeWindowTexture()`: 64×64 canvas, 8×8 grid of 8-px window cells; each
  cell's inner 4×5 px is "lit" (`#ffffff`) with probability 0.7 from a fixed
  seeded PRNG (mulberry32, seed 7), else `#2c2c2c`; wall background `#8c8c8c`.
  `RepeatWrapping` both axes, `NearestFilter`, `colorSpace = SRGBColorSpace`.
- `makeGridTexture()` (lives in `ground.ts`): 256×256 canvas, background `#07080a`, 3-px lines
  `#2f8a40` every 32 px (both axes) → with `repeat` so one tile = 40 m
  (a line every 5 m). `RepeatWrapping`, mipmapped (`LinearMipmapLinearFilter`), `anisotropy = 8`.

### 4.5 Roads & ground

- `ROAD_WIDTH = { primary: 12, secondary: 9, tertiary: 7, residential: 6, service: 4, pedestrian: 4, footway: 2 }` (metres).
- `buildRoadsMesh(roads, heightAt: HeightFn = FLAT_HEIGHT)`: for each segment
  `p→q` of length `len`, split it into `n = max(1, ceil(len / 10))` equal
  sub-segments and emit one quad per sub-segment, normal `(0,1,0)`, uv
  `(0,0)`, colour `0x585858` for primary/secondary, `0x404040` otherwise.
  Corners are not mitred (overlap is fine). Height (`ROAD_LIFT = 0.15`):
  - ordinary road: each of the quad's four corners gets its own
    `y = heightAt(corner.x, corner.z) + ROAD_LIFT`;
  - `bridge: true` road: `ys = bridgeProfile(road.pts, heightAt)` (§4.9)
    gives one deck height per polyline vertex; a sub-segment corner at
    fraction `f` along segment `i` gets `y = lerp(ys[i], ys[i+1], f) + ROAD_LIFT`
    (both edges identical — the deck is flat across).
  With `FLAT_HEIGHT` every vertex sits at `y = 0.15`.
- `buildWaterMesh(rings, levels?: number[])` / `makeWaterObject(rings, levels?)`:
  ring `i` is triangulated at `y = levels[i] + 0.3` when `levels` is given,
  else at `0.02` (the flat London value).
- `makeGround(size = 6000)`: `PlaneGeometry(size, size)` rotated to lie on
  `y = 0`, `MeshBasicMaterial({ map: makeGridTexture() })`, texture `repeat`
  set to `size / 40`. With terrain the same plane is kept as the void-filler
  under the heightfield (`position.y = terrain.min − 0.5`).

### 4.6 Collision (src/world/collision.ts)

- `pointInPolygon(p: Vec2, poly: Vec2[]): boolean` — ray casting.
- `distToSegment(p: Vec2, a: Vec2, b: Vec2): number`.
- `class CollisionGrid { constructor(buildings: Building[], cell = 25) }`
  buckets each footprint into every grid cell its bounding box touches.
- `blocked(p, r = 0.6)`: true when `p` is inside any nearby footprint or
  within `r` of any of its edges.
- `resolve(from, to, r = 0.6): Vec2`: returns `to` if not blocked; else tries
  `[to.x, from.z]` then `[from.x, to.z]` (wall sliding); else `from`.

### 4.7 Player (src/player/controls.ts) — wave 6: speeds + fly mode

```ts
export interface PlayerState { x: number; z: number; y: number /* eye height, absolute world y */; yaw: number; pitch: number; fly: boolean }
export interface InputState { forward: number /* -1..1 */; strafe: number /* -1..1 */; turn: number /* -1..1 */; sprint: boolean; lookDx: number; lookDy: number /* px since last read */; up: number /* -1..1: Space +1, KeyC −1 */; flyToggles: number /* KeyF presses since last read */ }
export const EYE_HEIGHT = 1.7, WALK_SPEED = 9, SPRINT_SPEED = 27, FLY_SPEED = 30, FLY_SPRINT_SPEED = 90, FALL_SPEED = 30, MAX_ALTITUDE = 1500, TURN_SPEED = Math.PI / 2 /* rad/s */, MOUSE_SENS = 0.0025 /* rad/px */;
export function stepPlayer(s: PlayerState, i: InputState, dt: number, resolve: (from: Vec2, to: Vec2) => Vec2, groundAt: HeightFn = FLAT_HEIGHT): PlayerState
export function yawToBearingDeg(yaw: number): number   // 0 ≤ result < 360
export class Controls { constructor(target: HTMLElement); readInput(): InputState; dispose(): void }
```

`stepPlayer` is pure. `fly = s.fly` flipped once per odd `i.flyToggles`; yaw +=
turn·TURN_SPEED·dt + lookDx·MOUSE_SENS; pitch −= lookDy·MOUSE_SENS (clamped
±π/3). Then:

- **Walk** (`fly = false`): speed = sprint ? SPRINT_SPEED : WALK_SPEED; move
  along forward/right (§3) by `speed·dt`, normalising the (forward, strafe)
  vector when both are non-zero; `[x, z] = resolve(from, to)`;
  `groundY = groundAt(x, z) + EYE_HEIGHT`;
  `y = s.y > groundY ? max(groundY, s.y − FALL_SPEED·dt) : groundY`
  (glued to the ground, or falling at a constant 30 m/s after leaving fly mode).
- **Fly** (`fly = true`): speed = sprint ? FLY_SPRINT_SPEED : FLY_SPEED;
  `look = (sin yaw·cos pitch, sin pitch, −cos yaw·cos pitch)`,
  `right = (cos yaw, 0, sin yaw)`, `dir = forward·look + strafe·right + up·(0, 1, 0)`,
  normalised when non-zero; `to = from + dir·speed·dt` with **no collision**
  (noclip — `resolve` is not called); `y` clamped to
  `[groundAt(x, z) + EYE_HEIGHT, MAX_ALTITUDE]`.

`Controls` maps `KeyW/ArrowUp`→forward 1, `KeyS/ArrowDown`→−1, `KeyA/KeyD`→strafe
∓1, `ArrowLeft/ArrowRight`→turn ∓1, `ShiftLeft/ShiftRight`→sprint,
`Space`→up +1, `KeyC`→up −1 (held-key model, T-0013), `KeyF` keydown (no
repeat) increments `flyToggles`; requests pointer lock on click of `target`,
accumulates `movementX/Y` while locked, and `readInput()` returns the
accumulated deltas/toggles and zeroes them. `Space` must `preventDefault`
(page scroll).

Frame loop consequences (§5): `camera.position.y = state.y`; `?fly=1` starts
airborne; `window.__asciicity.fly`; fog density each frame
`0.0018 / (1 + agl / 150)` with `agl = state.y − EYE_HEIGHT − groundAt(x, z)`
(unchanged on the ground, thinning with altitude so the city stays visible
from above); `camera.far = fly ? 6000 : 2000` (+ `updateProjectionMatrix`) on
each toggle; HUD row `MODE ... FLY` (between LANDMARK and FPS) only while
flying; the `ALT` row is shown when the city has terrain (`… M ASL`) **or**
while flying (`… M AGL` when there is no terrain); help line gains `· F FLY`.

### 4.8 ASCII renderer — the core of the look (wave 6: now the `ascii`/`gloom`/`solarized` styles, §4.11)

> Wave 6 moves this code to `src/render/styles/ascii.ts` behind the
> `RenderStyle` contract (§4.11); `AsciiRenderer` becomes the generic
> `StyleRenderer` in `src/render/post.ts`. The atlas, `glyphIndex`, the
> shader and the three themes below are unchanged — they are the reference
> implementation every other style imitates.

```ts
export const DEFAULT_RAMP = " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
export interface AsciiOptions { cellW: number /* 6 */; cellH: number /* 12 */; ramp: string; font: string /* 'bold 24px "DejaVu Sans Mono", "Courier New", monospace' */; gamma: number /* 0.45 */; exposure: number /* 1.7 */; theme: number /* 0 cyber · 1 gloom · 2 solarized (T-0038); G cycles */ }
export function glyphIndex(lum: number, count: number, gamma: number): number  // floor(clamp(lum,0,1)^gamma · (count−1) + 0.5), clamped to [0, count−1]
export function buildGlyphAtlas(ramp: string, tileW: number, tileH: number, font: string, canvas: HTMLCanvasElement): { canvas: HTMLCanvasElement; count: number }
export class AsciiRenderer {
  constructor(renderer: THREE.WebGLRenderer, opts?: Partial<AsciiOptions>)
  setSize(width: number, height: number): void   // renderer size = width×height (pixelRatio 1); cols = floor(width/cellW), rows = floor(height/cellH)
  render(scene: THREE.Scene, camera: THREE.Camera): void
  get cols(): number; get rows(): number
  dispose(): void
}
```

Pipeline per frame: (1) render `scene` into a `WebGLRenderTarget(cols, rows)`
(`NearestFilter`, no depth texture needed); (2) render a full-screen quad
(`OrthographicCamera(−1,1,1,−1,0,1)` + `PlaneGeometry(2,2)`) with the shader
below to the canvas. The atlas is one row of `count` tiles, each
`tileW × tileH = 16 × 32` px, glyph drawn white on black, centred, with the
font above scaled to fit; uploaded as a `CanvasTexture` (`LinearFilter`,
`flipY = true`). The vertex shader is the trivial `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`. Fragment shader (GLSL ES 1.0):

```glsl
uniform sampler2D tScene; uniform sampler2D tAtlas;
uniform vec2 grid;        // (cols, rows)
uniform float glyphCount; // atlas tiles
uniform float gamma;      // perceptual curve for glyph density (0.45 ≈ linear→sRGB)
uniform float exposure;   // scene brightness multiplier before the curve
uniform float theme;      // 0 cyber, 1 gloom, 2 solarized
varying vec2 vUv;
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 c = texture2D(tScene, (cell + 0.5) / grid).rgb * exposure;
  float v = max(max(c.r, c.g), c.b);                 // hue-independent brightness
  float shaped = clamp(pow(clamp(v, 0.0, 1.0), gamma), 0.0, 1.0);
  float idx = floor(shaped * (glyphCount - 1.0) + 0.5);
  vec2 inCell = fract(vUv * grid);
  float mask = texture2D(tAtlas, vec2((idx + inCell.x) / glyphCount, inCell.y)).r;
  vec3 tint = c / max(v, 0.02);                      // hue at full brightness…
  tint = tint * clamp(shaped * 0.7 + 0.4, 0.0, 1.0); // …density carries most of the luminance
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
}
```

`glyphIndex(v, count, gamma)` in TS must mirror the shader's `idx` formula exactly (unit-tested); `v` is the exposed max-channel brightness, not luminance — so a saturated blue wall is as dense as a white one and only the hue differs.

### 4.9 Terrain (src/world/terrain.ts, wave 5)

```ts
export class Terrain {
  constructor(data: TerrainData)
  readonly data: TerrainData
  readonly min: number; readonly max: number        // over data.heights
  heightAt(x: number, z: number): number             // the HeightFn — see below
}
export function terrainHeightAt(t: TerrainData, x: number, z: number): number  // pure; Terrain.heightAt delegates to it
export function buildTerrainGeometry(t: TerrainData): THREE.BufferGeometry     // indexed heightfield (works in node)
export function makeTerrainObject(t: TerrainData): THREE.Mesh                   // browser-only: grid texture + slope shade
export function bridgeProfile(pts: Vec2[], heightAt: HeightFn): number[]       // deck height per polyline vertex
export class BridgeDecks {
  constructor(roads: Road[], heightAt: HeightFn, cell = 25)                     // keeps roads with bridge === true
  deckAt(p: Vec2): number | undefined                                           // deck height under p, or undefined
}
export function makeGroundAt(terrain: Terrain | undefined, decks: BridgeDecks | undefined): HeightFn
```

- **Sampling** (`terrainHeightAt`): `u = (x − x0) / step`, `v = (z − z0) / step`,
  each clamped to `[0, cols − 1]` / `[0, rows − 1]` (outside the grid = the
  edge value). `c = min(floor(u), cols − 2)`, `r = min(floor(v), rows − 2)`,
  `fu = u − c`, `fv = v − r`, `h(cc, rr) = heights[rr · cols + cc]`. The cell
  is split along the diagonal `(c, r) → (c + 1, r + 1)`:
  `fu ≥ fv` ⇒ `h00 + fu · (h10 − h00) + fv · (h11 − h10)`, else
  `h00 + fv · (h01 − h00) + fu · (h11 − h01)`. This is exactly the surface the
  geometry below draws, so draped geometry never floats or sinks at sample points.
- **Geometry** (`buildTerrainGeometry`): `cols · rows` vertices, vertex
  `(c, r)` at `(x0 + c·step, h(c, r), z0 + r·step)`, `uv = (x / 40, z / 40)`
  (one grid tile = 40 m, as the flat ground); per cell the two index
  triangles `(i00, i01, i11)` and `(i00, i11, i10)` with `i01 = (r+1)·cols + c`
  etc. — the same diagonal as the sampler, wound so normals point `+y`.
  `computeVertexNormals()`, then a `color` attribute holding the slope shade
  `s = min(1, 0.6 + 0.5 · max(0, n · L))`, `L = normalize(1, 2, 0.5)` (flat
  ground ⇒ 1.0 — identical to London's unlit floor), `computeBoundingSphere()`.
- `makeTerrainObject(t)` = `Mesh(buildTerrainGeometry(t), MeshBasicMaterial({ map: makeGridTexture(), vertexColors: true }))`
  (texture `repeat` left at 1: the uvs already count tiles).
- **Bridges** (`bridgeProfile`): `ya = heightAt(pts[0])`, `yb = heightAt(pts[last])`,
  `t_i` = cumulative length / total length; `ys[i] = max(ya + (yb − ya) · t_i, heightAt(pts[i]))`
  — a straight deck between the abutments that never dips below the ground
  (over the flattened river bed it is the straight line; a 2-point polyline
  gives `[ya, yb]`). `BridgeDecks` buckets every segment of every
  `bridge: true` road (half-width `ROAD_WIDTH[cls] / 2 + 1`, the same
  corridor the `CollisionGrid` uses) into a 25 m spatial hash; `deckAt(p)`
  returns the **maximum** over all segments whose corridor contains `p` of
  `lerp(ys[i], ys[i+1], t)` with `t` the clamped projection of `p` onto the
  segment; `undefined` when no corridor contains `p`.
- `makeGroundAt(terrain, decks)(x, z) = max(terrain?.heightAt(x, z) ?? 0, decks?.deckAt([x, z]) ?? −Infinity)`
  — the walkable height: the player, the buses and the sky ride on this;
  boats ride on `terrain.heightAt` alone (the river bed is flattened to the
  water level, so a boat's `y = level + 1` falls out for free).

### 4.10 Cities, spawn fallback, overlay menu (wave 5)

```ts
// src/data/cities.ts
export interface CityInfo { id: string; label: string; file: string; defaultSpawn: string; blurb: string }
export const CITIES: readonly CityInfo[]   // london (data/city.json, 'bigben'), kyiv (data/kyiv.json, 'maidan')
export function cityById(id: string | null | undefined): CityInfo | undefined   // trimmed, case-insensitive
// src/data/spawn.ts
export function resolveSpawn(param, origin, blocked, city?, fallback = 'bigben'): SpawnPoint
// src/hud/share.ts
export function buildShareUrl(href: string, cityId: string, state: { x: number; z: number; yaw: number }, origin: { lat: number; lon: number }): string
```

- `?city=<id>` picks the dataset. No `?city=` (and no `?synthetic=1`) ⇒ the
  start overlay becomes a **city picker**: one button per `CITIES` entry
  (`label` + `blurb`, keys `1`/`2`… also work); choosing writes `?city=<id>`
  into the URL with `history.replaceState`, keeps every other parameter, and
  boots that city. `?synthetic=1` never shows the picker.
- `resolveSpawn` fallback is the city's `defaultSpawn`; a preset or
  coordinate that projects **outside the city's bbox** also falls back
  (a London preset in Kyiv must not drop the player 2 000 km into the void).
  Kyiv presets are listed in `docs/integration.md`.
- **Pause menu**: losing pointer lock (Esc) shows the resume overlay with
  `CLICK TO RESUME` plus two buttons that stop propagation:
  `COPY LINK TO HERE` — `buildShareUrl(location.href, city.id, state, city.origin)`
  copied via `navigator.clipboard.writeText` (best effort) **and** shown in a
  read-only `<input>` selected for manual copy, button text `COPIED` for
  1.5 s — and `SWITCH CITY`, which navigates to `location.pathname` plus
  the current query minus `city`/`at` (i.e. back to the picker).
  `buildShareUrl` keeps `theme`, `time`, `cell`, `crt`, `minimap`, `hud` from
  `href`, drops everything else, sets `city` and
  `at=<lon 5 dp>,<lat 5 dp>,<bearing rounded>` via `unproject` (§3), and
  returns an absolute URL; a round trip through `parseAt` + `project` lands
  within 1 m of the original state.
- HUD gains an `ALT` row (`HudValues.alt?: string`, rendered between `ZONE`
  and `LANDMARK` only when defined): `formatAlt(m) = "<round(m)> M ASL"`,
  fed with `terrain.datum + groundAt(x, z)`; London (no terrain) keeps the
  six-row panel.

### 4.11 Render styles (wave 6) — `src/render/style.ts` (PM-owned), `src/render/post.ts`, `src/render/styles/*.ts`

The scene is rendered once into a small target, then one full-screen
fragment shader turns it into the look. A **style** is that shader plus its
cell/sample geometry and its own uniforms (`RenderStyle` in `style.ts` —
read the file; it also holds `STYLE_PRELUDE`, the helper GLSL every style
is compiled with, and `STYLE_ORDER`, the `R`-cycle order). Twelve styles
ship: `ascii`, `gloom`, `solarized` (the former themes), `braille`,
`blocks`, `teletext`, `dither`, `gameboy`, `pico8`, `edges`, `hatch`,
`matrix`. Every style must keep ≥ 30 fps on an integrated GPU: the scene
target must stay ≤ 640×360 px (`cols·subX × rows·subY` at 1080p).

```ts
// src/render/post.ts
export interface StyleRendererOptions { initial?: string; cellW?: number; cellH?: number; exposure?: number /* 1.7 */; gamma?: number /* 0.45 */ }
export class StyleRenderer {
  constructor(renderer: THREE.WebGLRenderer, styles: readonly RenderStyle[], opts?: StyleRendererOptions)
  get styles(): readonly RenderStyle[]; get style(): RenderStyle
  setStyle(id: string): boolean          // false + no-op for unknown ids; disposes the old style's uniforms
  next(step = 1): RenderStyle             // cyclic; step −1 for Shift+R
  setSize(width: number, height: number): void   // cols = floor(w / cellW), rows = floor(h / cellH); target = cols·subX × rows·subY (+ DepthTexture when needsDepth)
  render(scene: THREE.Scene, camera: THREE.Camera): void  // scene → target, update common uniforms (time, cameraNear/Far from a PerspectiveCamera), style.update?, quad → canvas
  get cols(): number; get rows(): number
  dispose(): void
}
// src/render/styles/index.ts
export const STYLES: readonly RenderStyle[]   // exactly STYLE_ORDER, one entry per id, from the per-style modules' `STYLES` exports
```

Each `src/render/styles/<module>.ts` exports `export const STYLES: readonly RenderStyle[]`
(usually one entry; `ascii.ts` has three, `dither.ts` two) plus its pure
helpers. `?cell=WxH` overrides `cellW/cellH` of every style. Common
uniforms and helpers: see `STYLE_PRELUDE` in `style.ts`. `main.ts`: `R` →
`next(1)`, `Shift+R` → `next(−1)`, `?render=<id>` (unknown → `ascii`),
`?theme=`/`?gloom=1` accepted as aliases (`cyber|0 → ascii`, `gloom|1 → gloom`,
`solarized|2 → solarized`; `render` wins), the `G` key is gone; every
change shows a toast `<div id="toast">RENDER: <LABEL></div>` for 1.5 s;
`window.__asciicity.render` (id) and `.styles` (ids in order);
`buildShareUrl` keeps `render` instead of `theme`.

Per-style algorithms (each ticket implements exactly one subsection; the
"pure" exports are unit-tested in node, the shader mirrors them):

**ascii / gloom / solarized** — `styles/ascii.ts`: §4.8 verbatim. Cell 6×12,
sub 1×1. One factory `asciiStyle(id, label, theme)`; `DEFAULT_RAMP`,
`glyphIndex`, `buildGlyphAtlas`, `themeMix` stay exported from this module.

**braille** — cell 6×12, sub 2×4. Dot `(c, r)` (`c` ∈ {0,1} column, `r` ∈
0..3 row from the **top**) is lit when `shaped(bright(sample)) > T[r][c]`,
`T = [[1/9, 5/9], [7/9, 3/9], [2/9, 6/9], [8/9, 4/9]]`. Bits: dots 1–3 =
left column rows 0–2 → bits 0–2; dots 4–6 = right column rows 0–2 → bits
3–5; dot 7 = left row 3 → bit 6; dot 8 = right row 3 → bit 7 (Unicode
braille order; tile index = bits, 256 tiles). Atlas: **procedural**, tile
16×32, dot radius 2.5 px at x ∈ {4, 12}, y ∈ {4, 12, 20, 28} (top-first),
white on black. Colour: `tintOf(cellMean) · clamp(shaped(bright(cellMean))·0.7 + 0.4, 0, 1) · mask`.
Pure: `BRAILLE_THRESHOLDS`, `brailleBits(lums: number[8] /* row-major top-first, [r][c] */): number`, `brailleDots(bits): [c, r][]`.

**blocks** — ANSI quadrant art. Cell 6×12, sub 2×2. `m` = mean of the four
`shaped(bright(s))`; quadrant `q` (0 = bottom-left, 1 = bottom-right, 2 =
top-left, 3 = top-right, matching `sampleSub` order) is "on" when its
value `> m + 1e-4`; all-equal → all on. fg = mean exposed colour of the on
quadrants, bg = mean of the off ones (each `tintOf(mean)·shaped(bright(mean))`).
Drawn analytically: pixel quadrant from `fract(vUv·grid)`. Pure:
`quadrantBits(lums: number[4]): number` (bit q), `splitMeans(colours, bits)`.

**teletext** — Ceefax mosaic. Cell 6×12, sub 2×3 (sixels). Bit `k` for
sample `(x, y)` = `y·2 + x` (bottom-first) on when `shaped(bright) > mean`
(all-equal → all on). fg colour = nearest of the 8 teletext colours
`[black, red, green, yellow, blue, magenta, cyan, white]` (components 0/1)
to `tintOf(meanOn)` **after** normalising so its max channel is 1 (black
only when `bright(meanOn) < 0.15`); bg black. Analytic drawing. Pure:
`TELETEXT_PALETTE`, `teletextIndex(rgb): number`, `sixelBits(lums: number[6])`.

**dither / gameboy** — `styles/dither.ts`, two styles. Cell 2×2, sub 1×1.
`bayer8(x, y)` = the standard 8×8 Bayer matrix value `(M[y][x] + 0.5) / 64`
with `M = [[0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],[12,44,4,36,14,46,6,38],[60,28,52,20,62,30,54,22],[3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],[15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21]]`
indexed by `cell mod 8`. `dither`: white `(0.9, 0.95, 0.9)` when
`shaped(bright) > bayer8`, else black. `gameboy`: level
`= clamp(floor(shaped(bright)·3 + bayer8), 0, 3)` → palette
`[#0f380f, #306230, #8bac0f, #9bbc0f]`. Pure: `BAYER8`, `bayer8(x, y)`,
`ditherOn(v, x, y)`, `gameboyLevel(v, x, y)`, `GAMEBOY_PALETTE`.

**pico8** — cell 4×4, sub 1×1. Colour `c = pow(clamp(exposed, 0, 1), gamma)`
per channel `+ (bayer4(x, y) − 0.5)/8` (`bayer4` = the 4×4 Bayer matrix
`(M[y][x] + 0.5)/16`, `M = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]]`),
then the nearest (squared RGB distance) of the 16 PICO-8 colours
`#000000 #1D2B53 #7E2553 #008751 #AB5236 #5F574F #C2C3C7 #FFF1E8 #FF004D #FFA300 #FFEC27 #00E436 #29ADFF #83769C #FF77A8 #FFCCAA`.
Pure: `PICO8_PALETTE`, `bayer4(x, y)`, `nearestPico8(rgb): number`.

**edges** — wireframe/vector look. Cell 2×2, sub 1×1, `needsDepth: true`.
`dC = linearDepth(uv)` at the cell centre and `dL/dR/dU/dD` one sub-sample
away; `sky = d ≥ 0.98·cameraFar`. Work on **inverse depth** `w = 1/d`,
which is exactly linear across any plane in screen space, so flat ground
and long walls give zero response at every distance while silhouettes
*and* creases (floor↔wall, building corners) still fire. Edge when
`|wL + wR − 2·wC| > k·wC` or `|wU + wD − 2·wC| > k·wC` with `k = 0.02`
(non-sky samples only), or when the centre and a neighbour disagree on
`sky` (the sky/sky case is never an edge). Output: edge → `(0.25, 1.0, 0.6)`;
else `exposed scene · 0.12` (the floor grid stays faintly visible). Pure:
`isEdge(dC, neighbours: [dL, dR, dU, dD], far, k = 0.02): boolean`.
(Revised 2026-08-27: the first-difference rule lit every grazing surface.)

**hatch** — pen-and-ink cross-hatch on paper. Cell 6×12, sub 1×1. Level
`L = round((1 − shaped(bright(cellMean)))·7)` (0 = blank paper, 7 = densest).
Procedural atlas of 8 tiles 16×32: levels 1–4 draw "/" diagonals with
`4 · (5 − L)` px spacing (16, 12, 8, 4), levels 5–7 keep the 4-px "/" set
and add "\" diagonals with spacing 12, 8, 4; 1.5-px ink lines. Paper
`(0.96, 0.93, 0.86)`, ink `(0.13, 0.11, 0.10)`; output `mix(paper, ink, mask)`.
Pure: `hatchLevel(v): number`, `hatchSpacing(level): { fwd: number | null; back: number | null }`.

**matrix** — digital rain. Cell 6×12, sub 1×1, uses the `ascii` atlas
(`buildGlyphAtlas` import). `hash(a, b, c) = fract(sin(a·12.9898 + b·78.233 + c·37.719)·43758.5453)`.
The glyph carries the image like ASCII does: `idx = clamp(round(S·(glyphCount − 1) + (hash(cell.x, cell.y, window) − 0.5)·8), 0, glyphCount − 1)`
with `window = floor(time·2 + 7·hash(cell.x, cell.y, 0))` — the density ramp
position from `S` (below) plus a ±4-glyph jitter that re-rolls about twice a
second per cell (PM tune 2026-08-27: fully random glyphs made the city unreadable). Rain per column:
`speed = 0.3 + 0.7·hash(cell.x, 1, 0)`, `phase = hash(cell.x, 2, 0)`,
`trail = fract(phase − time·speed·0.25 − vUv.y)` (the minus on the time term
makes the head travel **down** the screen, toward `vUv.y = 0`), intensity
`I = pow(trail, 4)`, head when `trail > 0.96`. With `S = shaped(bright(scene))`
(0 in the sky): colour `= (0.2, 1.0, 0.3) · mask · (S·(0.7 + 0.3·I) + 0.25·I)`
— the city carries the brightness, the rain modulates it, and in the sky
only the trails themselves show faintly; head → `(0.9, 1.0, 0.9)·mask·(0.6 + 0.4·S)`
(contrast raised in the PM tune 2026-08-27 after the user found it too dim).
Pure: `hash3(a, b, c)`, `matrixGlyph(cellX, cellY, timeS, count, S = 0)`,
`rainIntensity(colX, y01, timeS)` (returns `I`), `matrixBrightness(S, I, head): [r, g, b]`.
(Revised 2026-08-27 after the first GPU review: rising rain, 35 % glyph floor in the sky.)

### 4.12 UI shell (wave 7): panels, gear menu, toggles, credits

Layout (all `position: fixed`, all above the canvas, none intercepting
pointer-lock clicks except their own controls):

- `#hud` — the NAVIGATION panel, **top-right** (as today, minus the minimap).
- `#mini` — a new standalone **top-left** panel holding the minimap canvas
  (`#minimap`, 180 px; 120 px under the 700 px breakpoint). `Minimap` itself
  is unchanged; only its mount moves.
- `#gear` — a 40×40 px "⚙" button, **bottom-right**, **touch devices only**
  (`'ontouchstart' in window || navigator.maxTouchPoints > 0`, the same test
  `TouchControls` uses; `display: none` otherwise — revised 2026-08-27: on
  desktop the pointer lock and the Esc overlay make it unreachable, and Esc
  is the path). It opens the pause/settings menu (below). It stops `pointerdown`/`click`
  propagation so `TouchControls` never sees it.
- `#credits` — a **real footer bar**, not an overlay (revised 2026-08-27,
  user): a 20 px black strip across the very bottom of the page, 11 px
  monospace, HUD green at 55 % opacity, text centred:
  `built by @ubyjvovk · github.com/ubyjvovk/asciicity`, the whole line a link
  to the repo (new tab; stops propagation). The canvas and every other
  fixed panel live in the remaining `100vh − 20px` (`#view` height and the
  `applySize()` height both subtract `CREDITS_BAR_PX = 20`, so the ASCII
  grid, the gear and the toast never overlap the bar). Text and
  URL come from **`src/credits.ts`**: `export const CREDITS = { author: '@ubyjvovk', url: 'https://github.com/ubyjvovk/asciicity' }`
  — the only file to edit to rebrand; `README.md` says so.
- `#toast` stays bottom-left.

Pause/settings menu (`#menu`, extends T-0046): rows in this order —
`HUD: ON/OFF` · `MINIMAP: ON/OFF` · `CRT: ON/OFF` (toggles, click flips and
re-labels) · `STYLE: <LABEL> ▸` (cycles `next(1)`) · `FLY: ON/OFF` (flips
`state.fly` exactly like `F`) · `LANDMARKS ▸` (§4.13 fast travel) ·
`COPY LINK TO HERE` · `SWITCH CITY`; `CLICK TO RESUME` above as today.
Keyboard: `H` toggles the HUD, `M` the minimap (no repeat). Toggling HUD or
minimap hides the whole panel (`display: none`) and skips its per-frame
update; CRT toggles the overlay element.

Persistence: `localStorage['asciicity.settings']` = JSON
`{ hud, minimap, crt, render, city }`, written on every change, read at
boot **after** URL parameters (URL wins, storage fills the gaps, defaults
last). Toggles also rewrite the current URL's `hud`/`minimap`/`crt`/`render`
params via `history.replaceState` so `COPY LINK TO HERE` carries them.
`window.__asciicity.settings` exposes the live object.

### 4.13 Landmarks (wave 7): height/colour overrides, extra buildings, per-city presets, fast travel

OSM heights for Kyiv's landmarks are unusable (Saint Sophia Cathedral 3 m,
Great Lavra Belltower 8 m, Arch 3 m; no Motherland Monument at all), so a
PM-curated table is applied to the loaded `CityData` before anything is built:

```ts
// src/world/landmarks.ts
export interface LandmarkFix { h?: number; color?: number; shape?: 'dome' | 'spire' | 'tower'; label?: string }
export interface ExtraBuilding { name: string; lon: number; lat: number; h: number; size: number /* square side, m */; color: number }
export const LANDMARK_FIXES: Readonly<Record<string /* city id */, Readonly<Record<string /* exact OSM name */, LandmarkFix>>>>
export const EXTRA_BUILDINGS: Readonly<Record<string, readonly ExtraBuilding[]>>
export function applyLandmarks(city: CityData, cityId: string): CityData   // pure: returns a new CityData; heights replaced by exact name; extras appended with ids −1000, −1001, … and a 4-point square footprint (projected via src/geo.ts); colours go through LANDMARK_COLORS (palette.ts) — this function also registers them via `registerLandmarkColors(map)` (new export in palette.ts; `colorFor` consults the registered map before the static table)
```

Kyiv table (heights in metres, real-world): Saint Sophia Cathedral 29 ·
Bell tower (30.5153, 50.4529 — Sophia's) 76 · St. Michael Golden-Domed
Cathedral 40 · Saint Andrew's Church 50 · Great Lavra Belltower 96 · Near
Cave's Belltower 27 · Bell Tower of Far Caves 41 · Arch of Freedom of the
Ukrainian people 35 · Verkhovna Rada of Ukraine 30 · St. Volodymyr's
Cathedral 49 · Golden Gate 16. Colours: gold `0xf7dc6f` for the churches and
bell towers (Sophia + Bell tower, St Michael's, Andrew's, the three Lavra
towers), ivory `0xe8e0c8` for Golden Gate, Arch, Rada, Volodymyr's, St.
Nicholas Cathedral. Extra: `Motherland Monument` at (30.5632, 50.4266),
h 102, size 20, colour silver `0xc0c0c0`. London: empty tables (no change).

Presets (`src/data/spawn.ts`): every `SpawnPreset` gains `city: 'london' | 'kyiv'`;
`presetsFor(cityId): [key, SpawnPreset][]` in table order. `landmarkSpawn`
prefers an **exact** (case-insensitive) name match before `includes`, and
its default distance scales with the target's height:
`targetDist = clamp(70 + 1.2·h, 70, 220)`. Kyiv presets become
building-based wherever the dataset has the building: `sophia` (Saint
Sophia Cathedral), `michael`, `andriyivskyy` (Saint Andrew's Church),
`lavra` (Great Lavra Belltower), `motherland` (Motherland Monument — the
extra), `goldengate`, `bessarabka` (Bessarabskyi market), new `rada`
(Verkhovna Rada of Ukraine), `volodymyr` (St. Volodymyr's Cathedral),
`arch` (Arch of Freedom of the Ukrainian people), `olimpiyskiy` (Olympic
National Sports Complex Stadium), `nicholas` (St. Nicholas Cathedral);
`mariinsky` is removed (not in the data); `maidan`, `podil` (Kontraktova
30.5151, 50.4658, bearing 180), `arsenalna`, `funicular`, `hydropark`,
`parkbridge`, `glassbridge`, `metrobridge` stay fixed-coordinate.

**Shapes (T-0062):** `shape` on a fix makes the building recognisable from
afar. `buildBuildingsMesh` emits, after the roof, a cap in the same colour
as the walls (group 0, so the window texture shades it): `dome` — a
hemisphere of radius `0.4·min(bboxW, bboxD)` (8 segments, 4 rings, UV
`(0,0)`) centred on the footprint centroid at roof height; `spire` — a
cone of base radius `0.3·min(bboxW, bboxD)` and height `0.6·h` (8 segments)
on the roof; `tower` — a second box of half the footprint size and `0.5·h`
extra height on the roof. Shapes are looked up by exact name through the
same `applyLandmarks` path: it sets `Building.shape` (a new optional field
on `Building`, PM-added) and the builder reads it. Kyiv: Sophia
Cathedral / St Michael's / St Volodymyr's / St Nicholas → `dome`; Bell tower
(Sophia), Great Lavra Belltower, Near Cave's / Far Caves bell towers,
Saint Andrew's Church → `spire`; Motherland Monument → `tower`. London:
St Paul's Cathedral → `dome`, Elizabeth Tower → `spire`. **Nelson's Column
(2026-08-27):** OSM's "Nelson's Column" polygon is the 338 m² plinth → fix
`{ h: 6, color: 0xe8e0c8, label: 'Trafalgar Square' }`; the column itself is
an extra `{ name: "Nelson's Column", lon: −0.12793, lat: 51.50776, h: 52, size: 5, color: 0xe8e0c8 }`
(no shape); the `trafalgar` preset becomes building-based on it.

**Labels (T-0063):** the `label` on a fix (default: the name) is drawn as a
floating DOM tag (`div.tag`, 11 px monospace, HUD green on black at 70 %)
above the building's roof centroid when the player is within **600 m** and
the point is in front of the camera: `main.ts` keeps one `<div id="tags">`
with at most 8 tags (nearest first), positioned each 4th frame by
projecting `(cx, roofY + 4, cz)` with `camera` (`Vector3.project`), hidden
when `z > 1` or off-screen. Tags never intercept pointer events. Only
buildings carrying a fix (or extra) get a label; `?tags=0` disables them.

Fast travel (menu `LANDMARKS ▸`): a scrollable list of `presetsFor(city)`
labels; choosing one resolves it exactly like `?at=` (`resolveSpawn` with
the city's collision) and teleports: `state.x/z/yaw` set, `state.y =
groundAt + EYE_HEIGHT`, `fly = false`, toast `→ <LABEL>`, overlay hidden
and pointer lock re-requested on desktop. `history.replaceState` sets
`at=<key>` so the URL stays shareable.

### 4.14 Trees (wave 7)

Data: `CityData.trees` / `CityData.woods` (types.ts; producer rules in
data-format.md §Trees). Runtime:

```ts
// src/world/trees.ts
export interface TreeInstances { count: number; matrices: Float32Array /* 16·count, column-major like THREE.Matrix4 */; colors: Float32Array /* 3·count, linear rgb */ }
export function buildTreeInstances(trees: readonly [number, number, number, number][], heightAt: HeightFn, seed = 5): TreeInstances   // pure
export class TreeField { constructor(trees, heightAt: HeightFn); readonly object: THREE.Object3D; readonly count: number }  // browser: two InstancedMeshes
```

- Per tree: `y0 = heightAt(x, z)`; **canopy** = `IcosahedronGeometry(1, 0)`
  scaled `(r, 0.8·r, r)` centred at `(x, y0 + h − 0.8·r, z)`; **trunk** =
  `CylinderGeometry(0.18, 0.28, 1, 5)` scaled to height `h − 0.8·r` with its
  base at `y0`. Two `InstancedMesh`es (canopies, trunks) with
  `MeshLambertMaterial({ vertexColors: false })`; canopy `instanceColor`
  from a seeded green range — HSL hue `95 + 35·rand`°, saturation
  `0.60 + 0.25·rand`, lightness `0.48 + 0.17·rand` (`THREE.Color.setHSL`,
  then `.convertSRGBToLinear()`); trunk colour fixed `0x6b4a2e`. (PM tune
  2026-08-27: the first olive range, L 0.22–0.38, was too dark for the glyph
  density curve — trees vanished into the floor.) No collision,
  no per-frame work (`update` is not needed; the field is static).
  `main.ts` adds `new TreeField(city.trees, groundAt).object` when
  `city.trees?.length`, before the buildings. Budget: ≤ 40 000 instances =
  two draw calls.
- Minimap (§Colours in docs/minimap.md): `woods` rings filled `#0b2f18` in
  the layer **between water and buildings**.

## 5. Bootstrap & frame loop (src/main.ts — T-0010)

1. Parse `location.search`: `synthetic=1` → `syntheticCity(seed, 12, hills)`
   (`hills=1` adds the synthetic terrain); else the city picker / `?city=`
   (§4.10) → `loadCity(import.meta.env.BASE_URL + city.file)`, falling back
   to `syntheticCity()` on error (log a console warning). `cell=WxH`
   overrides cell size.
2. Build: ground, roads, buildings (one mesh each) → scene. With
   `city.terrain`: `terrain = new Terrain(city.terrain)`,
   `decks = new BridgeDecks(city.roads, terrain.heightAt)`,
   `groundAt = makeGroundAt(terrain, decks)`; `makeTerrainObject` is added
   and the flat ground plane is lowered to `terrain.min − 0.5`; every builder
   and fleet receives `groundAt` (boats: `terrain.heightAt`). Without
   terrain `groundAt = FLAT_HEIGHT` and nothing changes. Camera at the
   spawn (`(x, groundAt(x, z) + 1.7, z)`); if the spawn is `blocked`, walk
   +x in 1 m steps until free (max 200 m).
3. `CollisionGrid`, `ZoneIndex`, `Controls(canvas)`, `Hud(hudRoot)`,
   `StyleRenderer(renderer, STYLES, { initial: opts.render, cellW?, cellH? })` (§4.11); `setSize` on load and on `resize`.
4. Overlay `<div id="overlay">` with the title and "CLICK TO ENTER"; hidden on
   the first click (which also requests pointer lock).
5. Loop: `requestAnimationFrame`; `dt = min(0.1, elapsed)`;
   `stepPlayer` → camera position/rotation (`camera.rotation.order = 'YXZ'`,
   `position.y = groundAt(x, z) + 1.7`, `rotation.y = −yaw`, `rotation.x = pitch`;
   the sky group is moved to the same point) → `ascii.render` →
   `hud.update` every 4th frame (sector/world/bearing/zone/fps; FPS is a
   1-second moving average).

## 6. Scene constants (src/render/scene.ts)

`WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true })` (the e2e test reads canvas pixels),
`setPixelRatio(1)`; `scene.background = new Color(0x000000)`;
`scene.fog = new FogExp2(0x000000, 0.0018)`; `AmbientLight(0xffffff, 0.6)`;
`DirectionalLight(0xffffff, 1.1)` at `(1, 2, 0.5)`; `HemisphereLight(0x223344,
0x080808, 0.4)`. `PerspectiveCamera(70, aspect, 0.3, 2000)`.

## 7. Performance budget

≥ 55 fps on an integrated GPU at 1080p with cell 6×12 (≈ 320×90 cells). The
whole city is five meshes (ground, terrain, roads, buildings, water) plus two
instanced fleets → ≤ 8 draw calls per frame plus the ASCII quad. Never
allocate per frame in the loop. The Kyiv heightfield is ≈ 87 k vertices /
170 k indexed triangles — one draw call, well inside budget.

## 8. Testing strategy

- Unit (vitest, node): every pure function/class above. `three` imports are
  fine in node as long as nothing touches WebGL/canvas (`ShapeUtils`,
  `Color`, `BufferGeometry`, `Vector2/3` all work).
- Browser-only modules (`textures.ts`, `Controls` DOM wiring,
  `AsciiRenderer`, `Hud`) are exercised by the Playwright smoke test
  (`e2e/smoke.spec.ts`, T-0011): loads `/?synthetic=1`, waits for
  `window.__asciicity.ready === true`, clicks, asserts the canvas has non-black
  pixels and the HUD shows `BEARING`, saves `e2e/__shots__/smoke.png`.
- `bash .tigerteam/scripts/run-tests.sh [tests/x.test.ts]` is the only way
  to run unit tests; `bash scripts/check.sh` is the full gate.
- **Headless-rendering caveat (verified 2026-08-24):** Chromium's SwiftShader
  software GL blanks the lower rows of any render target **≤ 64 px tall** —
  the default 6×12 cells at 720 px give a 60-row target, so screenshots
  taken with `--use-angle=swiftshader` show a black lower half. Real GPUs
  (and `--use-angle=gl-egl` on a GPU host) render every size correctly. For
  software-rendered screenshots use `?cell=3x6` (120 rows) or larger windows.
