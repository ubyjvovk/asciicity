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
| Data         | `public/data/city.json` — see `docs/data-format.md`         |

`package.json` / `package-lock.json` are **PM-owned after T-0001**: workers
never add or upgrade a dependency; if you need one, block with a question.

## 3. Coordinate system

Local metres relative to the origin (`docs/data-format.md`): `x` east,
`z` south, `y` up. **Yaw** (radians) is the player's heading: `0` faces north
(`−z`), `+π/2` faces east (`+x`). Forward vector:
`(sin(yaw), 0, −cos(yaw))`; right vector `(cos(yaw), 0, sin(yaw))`.
Bearing in degrees for the HUD: `((yaw · 180/π) % 360 + 360) % 360`.
Pitch is clamped to `±60°`. Eye height is `1.7` m.

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
src/world/palette.ts       PALETTE, LANDMARK_PALETTE (readonly number[] hex), colorFor(b: Building): number
src/world/textures.ts      makeWindowTexture(): THREE.CanvasTexture (browser-only)
src/world/mesh.ts          MeshData, MeshBuilder, toGeometry (PM-owned; already written — use MeshBuilder)
src/world/buildings.ts     buildBuildingsMesh(buildings: Building[]): MeshData (pure); makeBuildingsObject(buildings, windowTex): THREE.Mesh
src/world/roads.ts         ROAD_WIDTH: Record<RoadClass, number>; buildRoadsMesh(roads: Road[]): MeshData (pure); makeRoadsObject(roads): THREE.Mesh
src/world/ground.ts        makeGridTexture(): THREE.CanvasTexture; makeGround(size?: number): THREE.Mesh (plane at y=0 with the grid texture)
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
- **Walls**: for each edge `a→b` of the normalised ring emit one quad (two
  triangles, 6 vertices) from `y=0` to `y=h`. Outward normal
  `n = normalize(b.z − a.z, 0, −(b.x − a.x))`. Triangle winding must be
  counter-clockwise seen from outside (`cross(v1−v0, v2−v0) · n > 0`).
  UVs: `u = cumulativeDistanceAlongRing / 24`, `v = y / 24` (one texture tile
  = 24 m × 24 m = 8 × 8 windows of 3 m).
- **Roofs**: `THREE.ShapeUtils.triangulateShape(ring, [])`; normal `(0,1,0)`,
  winding so `cross(...).y > 0`; uv `(0,0)`.
- Colour: `colorFor(building)` (§4.3) → `new THREE.Color(hex)`; write the
  linear `.r .g .b` for every vertex of that building.
- Groups: all wall triangles first (group 0), then all roof triangles (group 1).
- `makeBuildingsObject` = one `THREE.Mesh(toGeometry(data), [wallMat, roofMat])`
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
- `buildRoadsMesh`: for each segment `p→q` emit one flat quad at `y = 0.05`,
  normal `(0,1,0)`, uv `(0,0)`, colour `0x585858` for primary/secondary,
  `0x404040` otherwise. Corners are not mitred (overlap is fine).
- `makeGround(size = 6000)`: `PlaneGeometry(size, size)` rotated to lie on
  `y = 0`, `MeshBasicMaterial({ map: makeGridTexture() })`, texture `repeat`
  set to `size / 40`.

### 4.6 Collision (src/world/collision.ts)

- `pointInPolygon(p: Vec2, poly: Vec2[]): boolean` — ray casting.
- `distToSegment(p: Vec2, a: Vec2, b: Vec2): number`.
- `class CollisionGrid { constructor(buildings: Building[], cell = 25) }`
  buckets each footprint into every grid cell its bounding box touches.
- `blocked(p, r = 0.6)`: true when `p` is inside any nearby footprint or
  within `r` of any of its edges.
- `resolve(from, to, r = 0.6): Vec2`: returns `to` if not blocked; else tries
  `[to.x, from.z]` then `[from.x, to.z]` (wall sliding); else `from`.

### 4.7 Player (src/player/controls.ts)

```ts
export interface PlayerState { x: number; z: number; yaw: number; pitch: number }
export interface InputState { forward: number /* -1..1 */; strafe: number /* -1..1 */; turn: number /* -1..1 */; sprint: boolean; lookDx: number; lookDy: number /* px since last read */ }
export const WALK_SPEED = 3, SPRINT_SPEED = 9, TURN_SPEED = Math.PI / 2 /* rad/s */, MOUSE_SENS = 0.0025 /* rad/px */;
export function stepPlayer(s: PlayerState, i: InputState, dt: number, resolve: (from: Vec2, to: Vec2) => Vec2): PlayerState
export function yawToBearingDeg(yaw: number): number   // 0 ≤ result < 360
export class Controls { constructor(target: HTMLElement); readInput(): InputState; dispose(): void }
```

`stepPlayer` is pure: yaw += turn·TURN_SPEED·dt + lookDx·MOUSE_SENS; pitch −=
lookDy·MOUSE_SENS (clamped ±π/3); speed = sprint ? SPRINT : WALK; move along
forward/right (§3) by `speed·dt`, normalising the (forward, strafe) vector when
both are non-zero; position = `resolve(from, to)`. `Controls` maps
`KeyW/ArrowUp`→forward 1, `KeyS/ArrowDown`→−1, `KeyA/KeyD`→strafe ∓1,
`ArrowLeft/ArrowRight`→turn ∓1, `ShiftLeft/ShiftRight`→sprint; requests
pointer lock on click of `target`, accumulates `movementX/Y` while locked, and
`readInput()` returns the accumulated deltas and zeroes them.

### 4.8 ASCII renderer (src/render/ascii.ts) — the core of the look

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

## 5. Bootstrap & frame loop (src/main.ts — T-0010)

1. Parse `location.search`: `synthetic=1` → `syntheticCity()`; else
   `loadCity(import.meta.env.BASE_URL + 'data/city.json')`, falling back to
   `syntheticCity()` on error (log a console warning). `cell=WxH` overrides
   cell size.
2. Build: ground, roads, buildings (one mesh each) → scene. Camera at the
   spawn (`(0, 1.7, 0)`, yaw = `−π/2` i.e. facing west); if `(0,0)` is
   `blocked`, walk +x in 1 m steps until free (max 200 m).
3. `CollisionGrid`, `ZoneIndex`, `Controls(canvas)`, `Hud(hudRoot)`,
   `AsciiRenderer(renderer)`; `setSize` on load and on `resize`.
4. Overlay `<div id="overlay">` with the title and "CLICK TO ENTER"; hidden on
   the first click (which also requests pointer lock).
5. Loop: `requestAnimationFrame`; `dt = min(0.1, elapsed)`;
   `stepPlayer` → camera position/rotation (`camera.rotation.order = 'YXZ'`,
   `rotation.y = −yaw`, `rotation.x = pitch`) → `ascii.render` →
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
whole city is four meshes (ground, roads, buildings, water) → ≤ 6 draw calls per
frame plus the ASCII quad. Never allocate per frame in the loop.

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
