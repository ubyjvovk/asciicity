# cyberpunk — giant hologram (T-0173)

A 50 m dancing anime hologram (Blade Runner 2049 style) at a central
landmark of every real city, in the `cyberpunk` style only (wave 25,
`docs/architecture.md` §4.11 layer API + "Stutter rules"). Model:
`public/models/holo/mia.glb` — "Mia" by ChamberSu (CC BY-NC, attribution in
`public/models/holo/CREDITS.md`), 44.5 k triangles, 16 skinned meshes on one
61-joint skin, one Mixamo dance clip (4.10 s), 512² WebP textures, 2.5 MB.

## Modules

| file | what |
|---|---|
| `hologramplace.ts` (pure) | `HOLO_ANCHORS`, `HOLO_ORIGINS`, `holoStart`, `holoSpot`, `holoDiscClear`, `holoPlacement`, `holoYaw`, `holoTileKeys`, timing (`holoSway`, `holoFlicker`, `holoGlitchGap`, `holoHash`) and constants |
| `hologram.ts` (browser) | `HologramLayer` / `createHologramLayer`: GLTFLoader, TSL hologram materials, projector disc + light column, placement lifecycle, warm-up |
| `layers.ts` | layer id `holo`, registered after `props`; `rainPassThrough: true` |

Tests: `tests/punk-hologram.test.ts`.

## Placement

`HOLO_ANCHORS[cityId] = { preset, aheadM }`; no entry → no hologram (and the
GLB is never fetched): `synthetic`, `minas-tirith`.

1. `holoStart`: resolve the preset with `resolveSpawn(preset, origin, () =>
   false)` (fixed-coordinate presets; no `+x` walk), step `aheadM` = 40 m
   along its bearing → the *stepped start*.
2. `holoSpot(start, bearing, buildings)`: test the start, then rings every
   5 m out to 80 m (samples ≈ 5 m apart along each ring, the first in the
   bearing direction); the first point whose 14 m disc holds no footprint
   edge/vertex and whose centre is inside no footprint wins (nearest-first).
   `null` when all is built up. Only buildings whose bbox comes within 94 m
   are tested.
3. `holoYaw(spot, preset)`: game yaw (forward `(sin, −cos)`) toward the
   preset, so the preset view sees her front. The model faces +z, so the
   layer sets `rotation.y = π − yaw` (+ sway).

The layer context carries no city origin, so `HOLO_ORIGINS` mirrors each
`index.json` `origin`; a unit test fails if they drift.

Resolved on the committed data (tiles within 500 m of the start):

| city | preset | preset (x, z) | stepped start | spot (x, z) | offset | yaw |
|---|---|---|---|---|---|---|
| london | `bank` | (0, 0) | (−40, 0) | (−20.6, −4.8) | 20 m | 103° |
| kyiv | `maidan` | (42.5, 11.1) | (4.9, 24.7) | (9.9, 25.2) | 5 m | 66.5° |
| tokyo | `shibuya` | (−6015.5, 2419.7) | (−6043.8, 2391.4) | (−6035.3, 2396.6) | 10 m | 139.5° |
| sydney | `circularquay` | (−96.5, −436.0) | (−56.7, −440.2) | (−51.9, −449.0) | 10 m | −106.2° |
| sf | `unionsquare` | (0, 0) | (−28.3, −28.3) | (−28.3, −28.3) | 0 m | 135° |
| nyc | `timessquare` | (421.8, −2443.7) | (435.4, −2481.3) | (435.4, −2481.3) | 0 m | −160° |

**Tiled runtime.** The spot is computed once the start's own tile is in
`ctx.sources` and either every tile within 400 m of the start is resident
or the resident set has been unchanged for 2 s (a tile beyond the dataset,
or beyond the player's 2 km streaming square, never arrives). Buildings
come from `base` + those tiles. After that the spot stays fixed — with one
exception: when a tile that was missing at placement streams in later and
one of its footprints cuts the 14 m disc, the placement is recomputed over
all anchor tiles and the hologram moves (`holo.moves`). Example: London's
default Big Ben spawn is 2.3 km from Bank, so tiles `0_−1` / `0_0` are not
resident at boot (`holo.missing` 2) — the partial placement is already the
full-data spot, so nothing moves.

## Model & animation

- Loaded lazily on the first `attach` in an anchored city (`GLTFLoader`,
  `EXT_texture_webp`), cached for the layer's lifetime. The GLB's own
  materials are replaced and disposed.
- `AnimationMixer`, the clip looping at 0.85×, advanced with `dtS` in
  `update`.
- Uniform scale so the posed (clip t = 0) bbox height is 50 m; feet on
  `groundAt(x, z)`, bbox centred on the disc. Skinned meshes are
  `frustumCulled = false` (bind-pose bounds do not follow the dance).
- Sway: yaw ± 20° sine, 40 s period, around the facing.
- Draws: 16 skinned meshes (not merged — they are split by material and
  share one skeleton) + disc + column = 18. Materials: one hologram material
  per distinct base-colour texture (hair, suit/jewellery, face, body) + one
  for the untextured face-screen part = 5.

## Hologram shader (TSL, `MeshBasicNodeMaterial`)

All parts: `transparent`, `depthWrite false`, `AdditiveBlending`,
`DoubleSide`, `fog false` (skips the scene height fog).

- **Colour** = texture luminance (`lum^0.8 · 1.3 + 0.12`, keeps face / hair /
  clothes readable) × tint over world height (cyan `0x3ef2ff` at the feet →
  magenta `0xff3ad8` at the head, `smoothstep(0.1, 0.95, h/50)`) + fresnel
  rim (`(1 − |n·v|)^2.5`, tint lifted 30 % toward white, ×1.4).
- **Scanlines**: world-y sine, period 0.35 m, scrolling up 0.6 m/s,
  modulating 0.55–1.0. **Shimmer**: per-pixel hash re-rolled 24×/s, ×0.92–1.08.
- **Flicker** (CPU, `holoFlicker`): 0.75 ± 0.08 from 1.3 Hz + 2.7 Hz sines,
  drives both brightness and opacity.
- **Glitch** (CPU schedule, `holoGlitchGap`): every 6–14 s (hashed gaps) a
  0.15 s glitch: vertices in 1.5 m world-y bands shift ±0.6 m in world x
  (`positionNode`: skinned local → world → shift → back), brightness × 0.45,
  opacity × 0.6.
- **Distance gain**: `smoothstep(20, 400, dist)` blends colour ×0.55 (close)
  → ×1.2 (far); per-fragment colour clamped to 1.4, so additive overdraw and
  bloom keep the silhouette legible up close, and she stays visible over the
  rooftops from 0.5–2 km.
- **Bloom**: a material `mrtNode` writes the `emissive` MRT target (the bloom
  source) with colour × 0.15 (close) → × 0.6 (far) at the hologram's alpha,
  and writes alpha-0 into `normal` / `metalrough` so SSR under her is
  unchanged. The post atmosphere still hazes her by the depth behind her
  (at most `fogEnabled · fogAmount` = 0.28 with the default looks) — that
  pass is PM-owned (`pipeline.ts` / `atmosphere.ts`).

**Projector disc**: radius 9 m, draped on the terrain (8 × 64 grid,
ground + 0.08 m), cyan ring at r = 0.93 + faint inner ring + radial glow;
blooms. **Light column**: open cylinder r 7 m, 55 m tall, opacity
`0.06 · (1 − v)^1.5` fading upward, cyan → magenta, no bloom. No real lights.

## Stutter rules

No lights; no light toggles. Nothing shows while loading. On the first
frame with both model and spot, the whole hologram is added at scale 1e-4
(everything collapses to a point but is drawn through the real MRT
pipeline, compiling all 7 materials); the next frame sets scale 1. Detach
keeps the built hologram (and its compiled materials) for the next
activation.

## Budgets & stats

44 520 triangles, 18 draws, one skeleton (61 joints). GLB ≤ 3 MB (unit
test). `__asciicity.punk.stats()` → `holo.on`, `ready` (1 once revealed),
`loaded`, `placed` (1 / 0 pending / −1 no spot or no anchor), `x`, `z`, `y`
(ground), `yawDeg`, `height` (measured, m), `triangles`, `draws`, `loadMs`,
`glitches`, `moves`, `missing` (anchor tiles not yet resident).
