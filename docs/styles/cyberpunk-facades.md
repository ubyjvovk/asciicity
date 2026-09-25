# cyberpunk facades (wave 20b, OSM wave 21)

Dark weathered building walls and bitumen roofs for the `cyberpunk` style.
Contract: `docs/architecture.md` §4.11 "`cyberpunk` v2 (wave 20b)" → "Facades".
Code: `src/render/punk/facademath.ts` (pure decisions) and `src/render/punk/facade.ts`
(TSL `MeshStandardNodeMaterial`s). `WetDressing` assigns `[walls, roof]` to every
mesh tagged `userData.surface === 'buildings'`.

The look is the threejs-conference `preview.jpg` alley: ~90 % dark material,
sparse dim windows, a shopfront band at street level. Lit windows are a minority
accent, not a grid.

## Geometry facts

Wall UVs from `buildings.ts`: **u** = perimeter metres / 24, **v** = (y − wall
base) / 24. So `u·8`, `v·8` index **3 m × 3 m** cells. The window atlas occupies
px x∈[2, 6), y∈[1, 6) of each 8×8 cell (`textures.ts`). Vertex colour is
per-building — seed and a desaturated base tint. `windowTex === null` (stone
cities / Minas Tirith) skips windows and shopfronts; the weathered material
still runs.

## Algorithm (walls)

1. **Seed** `bs = hash2(r·97 + b·13, g·97 + b·13)` (`buildingSeed`). Hash is
   only `punk/noise.ts` (`hash2` / `hash2Node`).
2. **Base albedo** `mix(luma(vc), vc, 0.25) · (0.20 + 0.12·bs)` with Rec.709
   luma (PM GPU review: 0.10 + 0.08·bs made the skyline vanish at `bigben`). Dry roughness 0.62, metalness 0.18.
3. **Floor bands** every 3 m (`v·8` integer lines): a 0.22 m band 35 % darker
   with a bump ridge, centred on the line.
4. **Panel seams** every 1.5 m (`u·16`): bump only, strength ≤ 0.35; never
   across window glass.
5. **Grime / rain streaks** `vnoise(u·24, v·1.5)` (~1 m across, ~16 m down).
   Darkens albedo up to 35 %, drops roughness up to 0.25, strongest just below
   each floor band (cornice runoff).
6. **Windows** (when `windowTex` is set): mask from the atlas layout, not the
   baked-in lights. Unlit glass is albedo 0.015, roughness 0.08, metalness 0.6
   (SSR reads metalness). Per cell `(floor(u·8), floor(v·8))` + seed:
   - 25 % of buildings are **dark** (`isDarkBuilding`, lit fraction 0);
   - remaining buildings light **14.5 %** of cells → **~11 % overall** (8–14 %);
   - no lights below 4 m (`cellV·3 < 4`);
   - intensity `0.15 + 0.75·r³` (median ~0.24);
   - tints 60 % tungsten `(1.0, 0.62, 0.32)`, 20 % fluorescent `(0.75, 0.85, 1.0)`,
     12 % cyan `(0.1, 0.85, 1.0)`, 8 % magenta `(1.0, 0.12, 0.62)`;
   - 30 % of lit windows draw **3 horizontal blinds**;
   - ≤ 2 % of lit windows flicker.
   Emissive goes in `emissiveNode` (bloom MRT).
7. **Shopfront** (0–4 m above wall base), per 6 m of u: 75 % roll-down shutter
   (ridged dark metal, albedo 0.02–0.05 per segment via `shutterAlbedo`,
   0.12 m horizontal ridges via bump, **no emission**), 25 % lit shop glass
   (emissive 0.18–0.55 via `shopEmissive`, warm or neon, dark mullions every
   1.5 m). Only the middle 3.6 m of a shop segment is glass (`inShopLitSpan`);
   the 1.2 m each side is a dark wall pier, so the band is broken into
   separate shop windows rather than one strip (PM GPU review: 45 % at
   0.5–1.1 read as a continuous blown-out neon strip).
8. **Distance fade** — seams, mullions, blinds and shutter ridges multiply
   their contrast by `1 − smoothstep(15, 60, |positionView|)` (`detailFade`)
   so they never alias into fine vertical stripes; blinds are horizontal only.

Bump: view-normal perturb from the floor-band / seam / shutter-ridge height
(`normalView + (seam·0.35, band·0.2, ridge·0.25)`), not TSL `bumpMap`. Reason:
WebGL2 compile time — the screen-space `bumpMap` of this graph (it
re-evaluates the height graph with derivatives) blocked the WebGL2 fallback's
first compile for ~15 s, which also exposed the (since fixed) Minas Tirith
ground-grid restore race in `main.ts`.

## Roof

Dark bitumen 0.03–0.05 (`vnoise` variation). Puddles as streets:
`smoothstep(0.54, 0.62, fbm2(xz·0.07))`, albedo 0.02, roughness 0.03,
metalness 0.9. Ripples `rippleNormal(u, 4.8, mix(0.12, 1.2, puddle))`.

## Facades × OSM (wave 21, T-0161)

Contract: architecture.md §4.11 "Facades × OSM". Buildings with OSM facade
data carry an `extra` vec4 (T-0159): linear rgb of `building:colour` on walls
/ `roof:colour` on roofs (−1 when absent) and the `building:material` code in
w (0 none, 1 brick, 2 stone, 3 concrete, 4 glass, 5 metal, 6 wood, 7 plaster).

A material that reads a missing attribute must never go on a mesh without it,
so `makeFacadeMaterials` returns **two variants**: `walls` / `roof` (T-0152,
attribute-free, graph unchanged) and `wallsOsm` / `roofOsm` (read
`attribute('extra', 'vec4')`). `wet.ts` picks per mesh:
`geometry.hasAttribute('extra') ? [wallsOsm, roofOsm] : [walls, roof]`.
Inside the OSM variant every rgb < 0 vertex falls back to the procedural look.

- **Colour** — rgb ≥ 0: base albedo `osm · 0.18` (`nightAlbedo`), with 25 %
  of the procedural floor-band / streak darkening (and the bands' bump and the
  streaks' roughness drop) kept on top. Roofs: `roofColor · 0.15`
  (`nightRoofAlbedo`) instead of the bitumen; puddles / ripples unchanged.
- **Pattern** by material code (`FACADE_PATTERNS`, one entry per code):

  | code | pattern | size | look |
  |---|---|---|---|
  | 0 none, 3 concrete | `panels` | 1.5 m seams | T-0152 panels |
  | 1 brick | `brick` | 0.075 m courses, 0.225 m bricks | running bond (half-brick offset every other course), recessed 12 mm mortar (−35 % albedo + bump), ±15 % per-brick tone |
  | 2 stone | `ashlar` | 0.6 m courses, 1.2 m blocks | offset ashlar, 20 mm joints, ±12 % per-block tone |
  | 4 glass | `curtain` | 1.5 m mullions + 3 m transoms | albedo 0.02, roughness 0.05, metalness 0.9; every pane between mullions is window glass; lit fraction ×1.5 capped at 0.3 (`windowLitP`) → ~16 % overall |
  | 5 metal | `seams` | 0.5 m standing seams | raised seams (+25 % albedo, bump), roughness 0.4, metalness 0.7 |
  | 6 wood | `boards` | 0.2 m vertical boards | ±20 % per-board tone, dark 12 mm gaps |
  | 7 plaster | `smooth` | — | no joints; broad low-contrast stains `vnoise(u_m·0.35, v_m·0.2)` −12 % |

  Masks are float `isMat(code, k)` weights summed per property, so the graph
  has no branches. Brick joints (sub-pixel past ~20 m) fade over 6 → 25 m
  (`BRICK_FADE_*`); the other joints and per-unit tone use the T-0152 15 → 60 m
  fade. Bump goes through the same view-normal perturb as T-0152 (vertical
  joints into x, horizontal joints + bands into y). Windows (outside glass) and
  the shopfront band are unchanged over every material.

Compile check: with a throwaway `wet.ts` edit that forces `[wallsOsm, roofOsm]`
on every building mesh (synthesising an `extra` over all codes / with and
without colour), `e2e/cyberpunk.spec.ts` passes on the WebGL2 fallback (zero
console errors, exact restore). The edit was not committed.

## PBR detail textures (wave 23, T-0167)

Contract: architecture.md §4.11 "PBR detail textures". `makeFacadeMaterials(windowTex, u, pbr?)`
takes the optional `PbrSets` from `punk/pbr.ts` (`loadPbrSets(renderer)`); without
it every graph is the procedural one above, node for node.

- **Loader (`pbr.ts`, browser-only).** One `THREE.Texture` per map for the six
  CC0 sets under `public/textures/cc0/` (`RepeatWrapping`, trilinear mipmaps,
  anisotropy `min(8, renderer max)`, colour `SRGBColorSpace`, normal / rough
  `NoColorSpace`, URLs from `import.meta.env.BASE_URL`). Per set two uniforms:
  `mean` — the colour map's mean linear rgb (`TEX_MEAN`), measured at load by
  drawing the image into a 32² canvas (`linearMeanRgb`), so no constants are
  baked from the image files — and `ready` (0 until all three maps load; the
  texture weight is × `ready`, so the procedural look shows meanwhile).
  `disposePbrSets(sets)` frees them.
- **Walls.** uv = wall uv × 6 (4 m per repeat) + a per-building offset; the
  isotropic sets (concrete, plaster) also take the 0/90° u↔v swap (bricks and
  standing seams would turn on their side — a deliberate narrowing of the
  locked "per-building swap", flagged to the PM). Set per fragment
  (`PBR_WALL_SETS` index): concrete default, OSM brick / metal / plaster,
  stone → concrete × (0.9, 0.87, 0.8), glass / wood → none, shutters → metal.
  Glass (windows, the lit shop span) is untextured (`texMask`).
- **One set per fragment, 3 samples.** `makeWallSamplers` builds three TSL
  functions (colour, rough, normal), each an `If` chain on the set index with
  `textureGrad` samples; the uv gradients are assigned *before* the chain
  (a bare `.toVar()` is emitted lazily inside the branch — invalid WGSL), and
  the swap uses `mix`, not `select` (a select compiles to an if/else that
  nests and duplicates the chain). Verified on the generated GLSL: 12
  `textureGrad` (4 sets × 3 maps), all three chains at top level.
- **Normal.** The decoded tangent xy × 0.8 × fade on a cotangent frame from
  screen derivatives of the (unswapped) wall uv (`uvPerturbNormal`; the
  swap is undone in tangent space), then the seam / band / ridge nudges on top.
- **Roofs.** Concrete at 6 m per repeat on world xz (u = x, v = −z), explicit
  horizontal TBN (`horizontalPbrNormal`: T = +x, B = −z, N = +y) added to the
  ripple normal; albedo / roughness / normal fade under puddles.
- **Blend.** Albedo × `clamp(tex / mean, 0.45, 1.8)` pulled to 1 over 15 → 60 m;
  roughness = mix(procedural, tex.r, 0.6).

Pure mirrors (facademath.ts, `tests/punk-pbr.test.ts`): `pbrAlbedoMod`,
`pbrFade`, `pbrAntiTile`, `pbrWallUv`, `pbrFacadeSet`, `pbrWallIndex`,
`PBR_WALL_SETS`, `srgbByteToLinear`, `linearMeanRgb`, `PBR_*` constants.

## Pure exports (`facademath.ts`)

Unit-tested in `tests/punk-facade.test.ts`. The shader hashes the same inputs
with `hash2Node`.

| export | what |
|---|---|
| `facadeHash(x, y)` | `hash2` alias |
| `buildingSeed(r, g, b)` | per-building seed |
| `isDarkBuilding(seed)` | 25 % dark |
| `windowLight(cellU, cellV, seed, code?)` | `{ lit, intensity, tint: 0\|1\|2\|3, blinds }`; glass code lights ×1.5 |
| `shopfrontKind(segment, seed)` | `'shutter' \| 'shop'` (75 / 25 %) |
| `shutterAlbedo(segment, seed)` | shutter albedo 0.02–0.05 |
| `shopEmissive(segment, seed)` | shop-glass emissive 0.18–0.55 |
| `inShopLitSpan(uM)` | middle 3.6 m of each 6 m segment |
| `detailFade(d)` | `1 − smoothstep(15, 60, d)` |
| `nightAlbedo(rgb)` / `nightRoofAlbedo(rgb)` | OSM rgb · 0.18 / · 0.15, `null` when rgb < 0 |
| `FACADE_PATTERNS`, `facadePattern(code)` | per-material pattern table (codes 0–7) |
| `windowLitP(seed, code?)` | lit probability; glass ×1.5 capped 0.3 |
| `MAT_*`, `OSM_*`, `GLASS_LIT_*`, `BRICK_FADE_*` | material codes and OSM constants |
| `WINDOW_TINTS`, `TINT_SHARES` | palette and 0.60 / 0.20 / 0.12 / 0.08 |
| `FLOOR_BAND_WIDTH_M`, `PANEL_SEAM_M`, `SEAM_BUMP`, … | band / seam / glass / roof sizes |

## Debug

`window.__asciicity.punk.stats()` / `.census()` / `.probe(x, z)`. Visual check
is the PM GPU review at London `bank` / `bigben`; this module is judged on
"no wall-of-windows" and "facades read as a material at 20 m".
