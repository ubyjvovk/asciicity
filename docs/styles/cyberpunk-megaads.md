# Mega-ads — skyline dressing (cyberpunk, T-0172)

Giant animated ad screens on highrise facades, landscape billboards on
mid-rise roofs, blinking red aviation beacons and roofline LED strips — the
Blade Runner / Ghost in the Shell skyline, readable from across the city.
Street-level neon is a different layer (`cyberpunk-neon.md`).

## Modules

| file | role |
|---|---|
| `src/render/punk/megaadsplace.ts` | pure: `placeMegaAds`, `megaMass`, geometry helpers, `buildMegaAdMeshes` (three merged cell meshes as typed arrays), `megaSlotUv`, all constants — no `three/webgpu`, no DOM |
| `src/render/punk/megaadsatlas.ts` | browser-only 2048² content atlas (`megaAdsAtlasTexture(cityId)`), drawn once |
| `src/render/punk/megaads.ts` | `createMegaAdsLayer()` — `BufferGeometry` wrappers, TSL materials, warm-up, `CellStreamer` |

Layer `id: 'ads'`, `rainPassThrough: true`, registered in `layers.ts` after
`neon` (always on, not experimental). `CellStreamer`: build radius 1600 m,
dispose radius 1900 m, 1 cell build per frame. Placement sees only the
cell's `cell.roads`.

## Placement (`placeMegaAds(buildings, roads, groundAt, cityId, seed = 0) → MegaAd[]`)

`MegaAd` = `MegaScreen` (`kind: 'screen' | 'billboard'`) | `MegaBeacon` |
`MegaStrip`. Every building rolls from its own `mulberry32(hash(id, seed))`
in a fixed order, so results are stable per building id and independent of
input order.

- **Mass** (`megaMass`): the envelope ring (`normalizeRing(poly)`), or for
  PLATEAU `tiers` the tallest tier's ring with `h = max tier top`. `wallTop`
  = ground top + h (minus `roof.h` for pitched OSM roofs), `wallBase` =
  ground base + `minH`. Parts with `minH ≥ 2.5` are skipped.
- **Facade screens** (h ≥ 45): h ≥ 150 → 2, h ≥ 80 → 1, else p 0.55.
  Candidate edges ≥ 10 m are ranked by the road distance of a probe 6 m
  outward from the edge midpoint (reach 120 m; no road → longest edge
  first). First screen: best edge that seats cleanly; second: best edge
  whose normal is more than ~93° from the first. Screen: centred on the
  edge, 0.8 m out, top 4–10 % of h below `wallTop`, height
  `clamp(0.3·h, 14, 70)`, width `min(edge − 2, height × aspect)`, aspect
  0.45–0.7 portrait; edges ≥ 40 m roll landscape (p 0.5, aspect 1.6–2.2)
  **only if the landscape width fits** (`edge − 2 ≥ height × aspect`) — see
  "Deviations". A screen is rejected if its centre is inside the ring or
  its bottom edge line comes within 0.6 m of any footprint edge (concave
  footprints).
- **Roof billboards** (25 ≤ h < 45, flat roof only): p 0.12 (`tokyo`,
  `nyc` 0.25). Landscape board 12–20 m wide (≤ edge − 1, edges ≥ 13 m),
  5–8 m tall, bottom 3 m above the roof, set 2 m in from the road-facing
  edge and facing out; both leg feet and a point 1.5 m behind must lie on
  the roof. Frame backplate + 2 (3 if > 16 m wide) legs in dark metal.
- **Aviation beacons** (h ≥ 60): 1–4 at the ring vertices farthest from the
  centroid (≥ 8 m apart, 0.6 m inset), box 0.9 m sitting on the roof, plus
  one on top of every other tier ≥ 60 m. 1 Hz blink (on 35 %), phase per
  building.
- **Roofline strips** (h ≥ 60, p 0.5): 0.35 m band 0.15 m below `wallTop`,
  0.06 m proud of every ring edge, colour from `NEON_TEXT_COLORS`. Steady.
- **Caps per 250 m cell** (cell of the first footprint vertex, as
  `bucketSources`): ≤ 24 screens + billboards, ≤ 64 beacons; tallest
  buildings first.

## Content (`megaadsatlas.ts`)

One 2048² canvas: 16 portrait slots of 256 × 512 (8 × 2, canvas top half)
and 8 landscape slots of 512 × 256 (4 × 2, from y = 1024); the bottom
quarter is unused. Drawn once at attach (redrawn only if the city id
changes), sRGB, mipmapped (screens are read from 50 m to 1.6 km).

- Invented brands only: NEUROCOLA, SYNTHLOVE, YUKI-TEC, ORBITAL AIR,
  DREAMCHIP, OMNIHEALTH, KAGE MOTORS, HELIX BANK, VOIDWAVE, MIRAI NOODLE,
  ZEROGRAV, PSYCORE — each with a slogan line.
- Katakana / kanji: ネオン, 未来, 夢, 愛, 電脳, 光速, 無限; city flavour:
  Kyiv НЕОН / МРІЯ / СВІТЛО, Tokyo 新宿 / 東京 / 渋谷.
- Designs: gradient background with a dark 6 px margin (the marquee wraps
  cleanly), big wordmark, geometric logo (circle / triangle / eye / wave),
  slogan; every fourth portrait (and landscape 1, 5) is a vertical CJK
  column / stylised geometric face profile. Palette: magenta, cyan, amber,
  acid green, hot red, violet, electric blue.

## Look (`megaads.ts`, TSL, all `MeshStandardNodeMaterial`, `fog = true`)

Per screen vertex `adInfo = (slot, phase, period, landscape)` and a local uv.
- Slot cycle: every `period` (7–12 s) the slot advances by 5 (coprime with
  16 and 8). The first 0.3 s of a cycle is the glitch: 18 horizontal bands
  jittered by up to ±15 % of the width, RGB split (R/B sampled ±1.2 % apart),
  +35 % flash; the previous slot shows for the first 0.15 s.
- Portrait marquee: v scrolls at 0.022 slot heights/s.
- Scanlines (one per atlas texel row) and an RGB subpixel mask (3 columns per
  texel) fade in within 60 m of the camera.
- Brightness pulse ×(0.9–1.1), emissive gain 2.6 (neon facade screens 3,
  tubes 7) — blooms, but the content stays readable.
- Frames / legs: dark metal (roughness 0.5, metalness 0.5).
- Beacons + strips share one material: per-vertex `glow` (linear RGB × gain:
  beacons 9, strips 3.5) × blink (`blink` phase, −1 = steady).

## Budgets & stutter rules

- Per cell ≤ 3 draw calls (screens, frames+legs, beacons+strips), merged
  geometry, no per-sign Object3D, Uint32 index, fixed attribute set per
  mesh kind. **No lights.**
- All three materials are created at the first attach and warmed: a
  degenerate (zero-area) triangle per material with the real attribute
  layout is drawn for 2 frames (`frustumCulled = false`) before the
  streamer builds the first cell (`ads.warming` counts down).
- Whole layer ≤ 150 k triangles; any cell build ≤ 8 ms.

## Stats (`__asciicity.punk.stats()`)

`ads.screens`, `ads.billboards`, `ads.beacons`, `ads.strips`,
`ads.triangles`, `ads.draws`, `ads.cells`, `ads.pending`, `ads.buildMs`,
`ads.warming` (plus the view's `ads.on` / `ads.objects`).

## Measured (T-0172)

Unit tests (`tests/punk-megaads.test.ts`, node, flat ground), per-cell
placement against cell roads, tiles overlapping 1.5 km:

| where | screens | billboards | beacons | strips |
|---|---|---|---|---|
| Sydney `harbourbridge` (−46, −919), r 1.5 km | 112 | 18 | 225 | 81 |
| Tokyo `shinjuku` (−5908, −944), r 1.5 km | 142 | 252 | 392 | 52 |
| London `bank` (0, 0), r 1.5 km | 133 | 62 | 347 | 79 |
| Kyiv `maidan` (43, 11), r 1.5 km | 25 | 29 | 65 | 26 |

Triangles within ~1.6 km: Sydney 10 566, Tokyo 21 292 (budget 150 k).
Cell build (placement + mesh) on Tokyo tile −6_−1 (28 cells): median
0.04 ms, max 0.87 ms. Browser numbers: see the T-0172 worker report.

## Deviations (flagged to the PM)

- The ticket asks for 16 portrait slots of 512 × 1024 + 8 landscape of
  1024 × 512 in one 2048² canvas — 12.6 M px in a 4.2 M px canvas. Slots
  are halved (256 × 512 / 512 × 256).
- Landscape screens are only chosen when the landscape aspect fits the edge;
  the literal rule (`width = min(edge − 2, height × aspect)` with a
  landscape aspect) squashes landscape content into portrait-shaped screens
  on 40–110 m edges.
