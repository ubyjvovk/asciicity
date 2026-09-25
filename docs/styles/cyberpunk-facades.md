# cyberpunk facades (wave 20b)

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

## Pure exports (`facademath.ts`)

Unit-tested in `tests/punk-facade.test.ts`. The shader hashes the same inputs
with `hash2Node`.

| export | what |
|---|---|
| `facadeHash(x, y)` | `hash2` alias |
| `buildingSeed(r, g, b)` | per-building seed |
| `isDarkBuilding(seed)` | 25 % dark |
| `windowLight(cellU, cellV, seed)` | `{ lit, intensity, tint: 0\|1\|2\|3, blinds }` |
| `shopfrontKind(segment, seed)` | `'shutter' \| 'shop'` (75 / 25 %) |
| `shutterAlbedo(segment, seed)` | shutter albedo 0.02–0.05 |
| `shopEmissive(segment, seed)` | shop-glass emissive 0.18–0.55 |
| `inShopLitSpan(uM)` | middle 3.6 m of each 6 m segment |
| `detailFade(d)` | `1 − smoothstep(15, 60, d)` |
| `WINDOW_TINTS`, `TINT_SHARES` | palette and 0.60 / 0.20 / 0.12 / 0.08 |
| `FLOOR_BAND_WIDTH_M`, `PANEL_SEAM_M`, `SEAM_BUMP`, … | band / seam / glass / roof sizes |

## Debug

`window.__asciicity.punk.stats()` / `.census()` / `.probe(x, z)`. Visual check
is the PM GPU review at London `bank` / `bigben`; this module is judged on
"no wall-of-windows" and "facades read as a material at 20 m".
