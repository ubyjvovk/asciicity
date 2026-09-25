# cyberpunk — vehicles (T-0170)

Real car models on the passenger-car fleet in the `cyberpunk` style (wave
23c, `docs/architecture.md` §4.11 "Vehicles — real car models in
cyberpunk"). The traffic simulation is untouched: the layer reads the live
`CarFleet` `InstancedMesh` through `PunkLayerContext.traffic()` and redraws
every car with one of 11 GLB models (`public/models/cars/`, attribution in
`CREDITS.md` there).

## Modules

| file | what |
|---|---|
| `vehiclemath.ts` (pure) | `parseManifest`, `pickModel`, `lodFor`, `normaliseTransform` / `normalisePoint` / `rotatedBox` / `rotateY`, `lightAnchors`, constants (`LOD0_DIST` 45, `LOD1_DIST` 350, `LOD_HIDDEN`, `LIGHT_X_FRAC` 0.38, `LIGHT_Y_FRAC` 0.45, `FLEET_YAW` π) |
| `vehicles.ts` (browser) | `VehiclesLayer` / `createVehiclesLayer`: GLTFLoader, merge + normalise, instancing, lights, fleet box hiding |
| `layers.ts` | registered after `props` |

Tests: `tests/punk-vehicles.test.ts`.

## Loading

- Lazily on the first `attach`: `manifest.json`, then both LODs of every
  model in parallel (`GLTFLoader`, WebP textures via `EXT_texture_webp`).
  Loaded assets are cached for the layer's lifetime (re-activations are free).
- A small loader plugin implements the legacy
  `KHR_materials_pbrSpecularGlossiness` (the Century requires it; three no
  longer ships it): `diffuseFactor` / `diffuseTexture` → colour / map,
  `roughness = 1 − glossiness`, metalness 0.
- A model that fails to load is `console.warn`ed and gets weight 0; if none
  load, the fleet keeps its boxes.
- Until everything is loaded the fleet boxes stay visible (`vehicles.ready`
  is 0, nothing is drawn by the layer).

## Normalisation and merging

Per (model, LOD), in `prepare()`:

1. World-space bbox of all mesh vertices (node transforms applied).
2. `normaliseTransform(bbox, yaw + FLEET_YAW, length)` → uniform scale so the
   z extent (after the manifest `yaw`) equals the real `length`, origin at the
   bbox bottom-centre. `FLEET_YAW = π` because the manifest convention is
   "front at +z" while a fleet instance travels along its local −z
   (`rotation.y = −heading`, heading 0 = north = −z). If a car drives
   backwards in game, flip its manifest `yaw` by π — the code only honours it.
3. Missing normals are computed (`computeVertexNormals`) on the transformed
   piece; mirrored node transforms get their winding flipped.
4. Materials collapse into ≤ 3 parts (≤ 3 draws per (model, LOD)):
   - **body** — the opaque material with the largest triangle area, cloned
     with its maps (uv channel 0 only; aoMap/lightMap dropped) and the paint
     rule: `metalness = max(m, 0.4)`, `roughness = min(r, 0.45)`;
   - **rest** — every other opaque material, baked to vertex colours: base
     colour × the base-colour texture sampled at the vertex UV (≤ 64² nearest
     downsample, `KHR_texture_transform` honoured) × COLOR_0. The pixels are
     read through an `OffscreenCanvas` 2D context with
     `willReadFrequently: true` (CPU-backed) — the default GPU canvas made
     the readback ~117 s of main-thread time under SwiftShader. Palette
     textures (most of these models) reproduce exactly. One shared material;
   - **glass** — materials with transmission or opacity < 0.9 → one shared
     dark tinted glass (opacity 0.6).
   Line primitives are skipped. Source geometries/materials are disposed.

## Per frame

For each fleet car `i` (no allocation):

- model = `pickModel(i, weights)` — a golden-ratio Weyl sequence through the
  cumulative weights: stable per index, matches the weights to < 1 % over any
  20 000 cars (cached per fleet);
- LOD = `lodFor(distance to camera)`: < 45 m → lod0, < 350 m → lod1, else
  hidden (costs one distance test);
- the fleet matrix is copied into the (model, LOD) instance buffer, with
  `y −= halfHeight` (fleet boxes are centred; the half height is read from the
  fleet's own box geometry). All parts of a (model, LOD) share one
  `InstancedBufferAttribute`; `count` is set per frame, only the written range
  is uploaded, meshes with 0 instances are invisible (no draw).
- Lights: 2 headlight quads (warm white, emissive 6, facing forward) and 2
  taillight quads (red, emissive 4) per drawn car at `lightAnchors` (x centre
  ± 0.38·width, y 0.45·height, on the bbox ends, 2 cm outside), or the
  manifest `lights` if present; one additive road beam (1.6 × 4 m, opacity
  0.15 fading ahead) for lod0 cars. Three instanced meshes in total.

## Fleet boxes

While the layer is attached and the models are ready, the fleet's boxes are
hidden by setting its **material** `visible = false` (restored on detach, on
fleet change and when `traffic()` turns null). Not `mesh.visible`: `main.ts`
only advances the fleet while `cars.object.visible` is true, so hiding the
mesh would freeze the traffic.

## Stats (`__asciicity.punk.stats()`)

`vehicles.lod0`, `vehicles.lod1`, `vehicles.hidden` (cars), `vehicles.triangles`
(drawn, incl. light quads), `vehicles.models` (loaded), `vehicles.loading`,
`vehicles.ready`, `vehicles.loadMs` (manifest → all models ready, wall
time), `vehicles.prepMs` (summed synchronous merge/normalise time),
`vehicles.draws` (visible meshes under the layer root).

Measured at `/?city=london&at=bank&render=cyberpunk&glass=0` (headless
SwiftShader, WebGL2 fallback): lod0 1, lod1 11, hidden 238, triangles
57 791, models 11, draws 21, loadMs ≈ 65 000, prepMs ≈ 3 200.

## Known deviations / notes for the PM

- architecture.md says assets live at `public/models/cars/<id>/lod0.glb`; the
  committed files are `<id>.lod0.glb` next to `manifest.json`. The code
  follows the manifest's `lod0` / `lod1` file names.
- `CAR_HALF_HEIGHT` is not exported from `traffic.ts` (out of scope); the
  half height is derived from the fleet geometry's bounding box instead.
- `three/addons/loaders/GLTFLoader.js` is not in `vite.config.ts`
  `optimizeDeps.include`; the e2e run on the dev server was clean, but adding
  it there would guarantee a single pre-bundled three copy in dev.
