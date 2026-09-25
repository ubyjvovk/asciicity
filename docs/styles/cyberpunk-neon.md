# Neon signs (cyberpunk, experimental)

Street-facing tube signs for the cyberpunk night look: vertical **blade**
signs sticking out of the wall, flat **panel** signs over the shopfront, and
(in dense cities, wave 23b) **stacks** of small panels and big facade
**screens**, with glowing lettering, two-colour tubes, a little flicker,
coloured glow cards on the wall and point-light spill on the wet street.
Contract: `docs/architecture.md` §4.11 "`cyberpunk` v2" → "Neon signs" and
"Neon v2 — dense city profiles". The layer is experimental: on by default,
`N` / `?neon=0|1` toggles it (wiring is PM-owned).

## Modules

| file | role |
|---|---|
| `src/render/punk/neonplace.ts` | pure: `placeSigns`, `NEON_PROFILE`, `neonColours`, atlas slot maths (`NeonSlotTable`, `neonSlotUv`, `neonAtlasKey`), and `buildNeonMeshes` (the three merged cell meshes as typed arrays) — no `three/webgpu`, no DOM |
| `src/render/punk/neonatlas.ts` | browser-only 2048² glyph atlas (canvas drawing) and `withDrawnColours` |
| `src/render/punk/neon.ts` | `createNeonLayer()` — wraps the arrays in `BufferGeometry`, materials, flicker, spill lights |

`id: 'neon'`, `rainPassThrough: true`. `CellStreamer` builds within 400 m and
drops cells past 550 m, one cell per frame. Placement sees only that cell's
`cell.roads`.

## Profiles (`NEON_PROFILE`, wave 23b; neon v3 T-0169)

| city | p per qualifying wall | min segment | road reach | cap per building | sizes | kinds |
|---|---|---|---|---|---|---|
| `tokyo` (dense) | 1.0 | 4 m | 20 m | `min(10, 3 + floor(h / 12))` | scaled by `h` (v3) | blade 45 / stack 25 / panel 22 / screen 8 % |
| default (every other id) | 0.24 | 6 m | 12 m | 2 | fixed (v1) | blade 60 / panel 40 % (v1 rule) |
| `minas-tirith` | 0 | — | 12 m | 0 | — | — |

`NeonProfile` carries `reach` (road reach) and `scaled` (v3 height-scaled
sizes) next to `p`, `minEdge`, `dense` and `cap`. v2 tokyo was p 0.7, cap
`min(8, 2 + floor(h / 15))`, reach 12 m.

A qualifying wall is a segment of `exteriorWalls(b, heightAt)` (architecture
§4.2 "Tiers": culled tier walls, else the envelope edges) on a building with
`h ≥ 8`, whose midpoint is within the profile's road reach (12 m; tokyo
20 m) of a same-cell road centreline. Seed is
`mulberry32(id ^ 0x9e3779b9)` (the PRNG copied from `src/world/textures.ts`).
The outward normal of a CCW edge a→b is `(dz, −dx)/len`. Flicker (about 8 %)
has its own seed from building id, x and y.

### Default (v1 × 2)

Each qualifying edge is kept with p 0.24 until the cap of 2. The bottom offset
is measured from the segment's `base`; on tiered buildings a sign that would
poke above the segment's `top` is dropped (after its RNG draws). London tile
`0_0`: 204 signs in v1 → 410 in v2.

| | blade (60 %) | panel (40 %) |
|---|---|---|
| face | 0.9 m × 3–6 m | 3–7 m × 1–1.6 m |
| bottom above wall base | 3.5–5 m | 4–8 m |
| off the wall, along the normal | 0.6 m | 0.15 m |
| along the edge | 25–75 % | centred |

### Dense (tokyo)

Each qualifying segment is *active* with the profile's p (tokyo 1.0: every one). Then up to `cap × 6`
attempts go round-robin over the active segments (screens always take the
building's longest active segment) until the cap is reached. Each attempt
rolls a kind, a word, the size, a position along the wall and a storey slot
(colours follow from `kind|word`, below), and is rejected if no slot fits:

- bottoms sit on 3.5 m storey slots above the building's wall base
  (`ringHeights(ring).base + minH`): 3.5, 7, 10.5, … up to `min(h − 2, 30)`;
  only slots where the sign lies inside the segment's `[base, top]` count;
- **eye-level bias** (PM rework 1 — from the street at 1.7 m eye height and a
  70° fov, signs above ~9 m at 10 m distance are out of frame): blades take
  the lowest free slot with bottom in [3, 7] m (3.5 or 7 m); stacks and
  panels fill the [3, 12] m slots (3.5, 7, 10.5 m) bottom-up for the first
  `ceil(0.75 · cap)` signs of the building, then up to `cap − that` of them go
  above 12 m (from a random slot, falling back to the low band when nothing
  higher fits); screens keep a random slot with bottom ≥ 10 m;
- no two signs within 1.2 m on one wall line (colinear segments share a
  line): their wall footprints (flat signs: width × height; blades: a 0.3 m
  attachment strip × height) must be ≥ 1.2 m apart along the wall or
  vertically;
- flat signs keep 0.2 m from the segment ends (their width is clamped to
  the segment, then rejected below the kind's minimum).

Sizes (neon v3, `profile.scaled`, `neonSignSize(h)` for building height
`h`; blades and stacks are deterministic in `h`, panels and screens roll):

| kind | size (w × h) | off wall | notes |
|---|---|---|---|
| blade | `clamp(0.9 + h/40, 0.9, 2.2)` × `clamp(3 + h/6, 3, 10)` m | `neonBladeOffset(w)` = max(0.6, w/2 + 0.1) m | perpendicular, two faces; bottom still 3.5 or 7 m |
| stack | `clamp(1.6 + h/50, 1.6, 2.8)` × (n·ph + (n−1)·0.1) m, ph = `clamp(0.9 + h/120, 0.9, 1.4)`, n = 2–4 | 0.15 m | a column of panels, each its own word/colours (`Sign.panels`, top to bottom) |
| panel | 3–9 × 1–1.6 m | 0.15 m | flat |
| screen | 6–12 × 4–8 m | 0.15 m | only h ≥ 30 m, bottom ≥ 10 m; emissive ×3 (unchanged) |

The ticket gives the stack panel height only as the range 0.9–1.4 m; it
scales with `h` on the same slope family (`0.9 + h/120` reaches 1.4 at
60 m, where the width reaches 2.8 m). A dense profile with `scaled: false`
keeps the v2 sizes (blade 0.8–1.2 × 3–7 m, stack 1.6 × 0.9 m, panel 3–7 m).
The blade offset grows with its width so a 2.2 m blade does not cut into the
wall; for the default 0.9 m blade it stays 0.6 m.

Screens are only legal on the third of Tokyo's signs that sit on buildings
≥ 30 m, so on those buildings the screen roll is 35 % (the other three kinds
share the rest 45 : 25 : 22); after fit rejections the city-wide share on
tile `−6_−1` is ≈ 8 % (blade 43.7, stack 25.4, panel 22.7, screen 8.1 %).

Measured on tile `−6_−1` (`FLAT_HEIGHT`, node), neon v3: Shinjuku
East-Exit cell `(−24, −4)` 299 signs / 26 944 triangles; busiest cell 851
signs / 73 498 triangles (budget 1 500 signs / 120 k); the whole tile 4 178
signs placed in ≈ 25 ms (budget 400 ms; v2 was 2 227 signs). Kind shares
blade 42.5, stack 25.6, panel 22.3, screen 9.6 %. 86 % of sign bottoms are
≤ 12 m; 51 signs with bottom ≤ 8 m lie within 60 m of the Shinjuku spawn
(−5908.3, −943.9). 1 719 signs sit on walls 12–20 m from a road (the v3
reach). Around the v3 presets (3×3 tiles): `kabukicho` (−5978.0, −1386.5)
75 and `centergai` (−6060.9, 2356.3) 51 signs with bottom ≤ 10 m within
60 m; the busiest cell of tile −6_−2's 3×3 is 1 084 signs / ≈ 100 k
triangles.

## Words and colours

No brand names. English for `london` / `sf` / `nyc` / `sydney` / `synthetic`
and any unknown id (`BAR`, `HOTEL`, `NOODLES`, `24H`, `KARAOKE`, `PHARMACY`,
`CINEMA`, `RAMEN`, `OPEN`, `CAFE`, `ARCADE`, `TATTOO`); Kyiv
`КАВА БАР АПТЕКА ГОТЕЛЬ КІНО ПИВО 24/7 ПЕКАРНЯ`; Tokyo 50 generic words
(`ラーメン カラオケ 居酒屋 焼肉 寿司 薬 ホテル バー 喫茶 パチンコ ゲーム 酒 麻雀 占い
質屋 中華 定食 牛丼 本 電気 カメラ スナック 24時間 営業中 歯科 美容室 クラブ 餃子
天ぷら そば うどん 酒場 漫画 カフェ 古着 整体 マッサージ 両替 立ち飲み 焼き鳥 占星術
薬局 串カツ 眼鏡 時計 雀荘 洋食 和食 空室 鮮魚`).

Colours (`NEON_COLORS`): `#ff2a6d`, `#05d9e8`, `#b967ff`, `#ffb000`,
`#39ff14`, `#ff073a`, warm white `#fff1c1`, sodium `#ffcc33`. Lettering uses
`NEON_TEXT_COLORS` (all but warm white — warm-white text read as white on the
GPU); warm white is a border option only. Every sign (and every stack panel)
has a `text` colour and a different `border` (tube) colour, and the pair is a
pure function of the atlas key: `neonColours(kind, word)` seeds mulberry32
with `neonKeyHash("kind|word")`, picks the text from the seven, then a warm
white border with p 0.1 (measured 12.3 % of Tokyo borders, cap 15 %), else
one of the six other text colours. The spill light and the glow card use the
text colour. The stack's `text`/`border` are its top panel's.

## Atlas

One sRGB 2048² `CanvasTexture`, **128** landscape slots of 256 × 128 px
(8 columns × 16 rows). `getSlotUv(kind, word)` keys the slot by
`kind|word` through the pure `NeonSlotTable` (≤ 50 words × 4 kinds = 200
keys): the first 128 distinct keys are drawn in order; a later key reuses a
drawn slot without evicting — one of the same kind *and* colour pair if any
(then only the word differs), else one of the same kind (so a blade never
gets a landscape glyph line), else `hash(key) % 128`; among candidates it takes
`hash(key) % count` (FNV-1a). `neon.ts` passes every placed sign through
`withDrawnColours` (neonatlas.ts), which replaces its colours by the ones its
slot actually shows — identity except for the last case — so face, glow card
and spill light always agree. On tile `−6_−1`, 165 of the 200 keys land on a
slot of their own look.

Each slot: near-black backing, a rounded tube border in the border colour
(glow + a thin white core ≈ 22 % of the tube), the word as a tube: a blurred
full-saturation fill + stroke in the text colour, then a near-white fill
whose edges are overdrawn by a text-colour stroke 0.6 × the bold glyph stroke
(taken as 0.13 × font size) wide, leaving a white core ≤ 40 % of the glyph
stroke. Glyphs are pre-squashed for the kind's nominal face aspect so they
read upright.

- **blade**: the glyph column is rotated into the landscape slot (each glyph
  turned −90°); the mesh maps face top → slot left and face right → slot top
  (`SlotUv.rot`), so the portrait face shows the column upright.
- **panel / stack**: the word in one line.
- **screen**: a dimmed diagonal gradient block (text → border colour) behind
  a big word, thinner border.

Font stack: `"Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP",
"Yu Gothic", "DejaVu Sans", sans-serif` — generic, nothing bundled.

## Meshes (3 draw calls per cell)

`buildNeonMeshes(signs, uvFor)` returns exactly three merged meshes; the
layer adds them as `neon-face`, `neon-frame`, `neon-glow`:

1. **faces** — `MeshStandardNodeMaterial`, colour 0.02, `emissiveNode =
   atlas × gain × flicker`; per-vertex `gain` is 7 for tubes (PM tune) and 3
   for screens; per-vertex `flicker` seed times a time uniform (flickering
   signs are off about 5 % of the time). Blades have two faces (the back one
   U-mirrored); stacks one face per panel.
2. **frames** — dark metal frame around every face (per stack panel), plus
   two brackets from each blade back to the wall.
3. **glow** — the fake spill: one additive card per sign 0.05 m in front of
   the wall, 3 × the sign's size (blades: at least 1 m wide), colour =
   linear text colour × 0.45 (per-vertex `glow` attribute), opacity =
   squared radial falloff × flicker; `MeshBasicNodeMaterial`, additive,
   `depthWrite: false`, fog on. (Neon v3: was 2.2 × / × 0.35. The mesh
   builder is shared, so London's glow cards grow too; its placement and
   sign sizes do not change.)

## Spill lights

Up to four `PointLight`s (sign text colour, intensity 6, distance 14, decay 2)
retarget every 0.25 s to the nearest signs inside the camera frustum and
150 m. Intensity fades in or out over 0.3 s. No new lights in v2.

## Stats and tests

`punk.stats()` keys: `neon.signs`, `neon.visible`, `neon.lights`, `neon.slots`,
`neon.triangles` (sum over built cells), plus the streamer's `neon.cells`,
`neon.pending`, `neon.buildMs`.

Unit: `tests/punk-neon.test.ts` — the v1 cases on London `tiles/0_0.json`
(via `bucketSources`) re-pinned to the default profile, the tier cases, and
the v2 cases 2–8 on Tokyo (v2 case 1's counts moved into v3 case 3) `tiles/-6_-1.json` (counts, cap/spacing/storey
slots + eye-level bias and the Shinjuku-spawn count, kind shares, default
≈ 2× v1, words/colours incl. no warm-white text and ≤ 15 % warm borders,
atlas slot table incl. overflow look matching, triangle and time budget,
determinism) and "colour pair is a function of the atlas key", and the v3
cases 1–5 (height-scaled sizes, tokyo cap/p + 20 m / 12 m reach, cell
budgets, sign counts at the `kabukicho` / `centergai` presets, default
profile unchanged — London's sign sha256 stays pinned). The WebGL2 graph is gated by
`e2e/cyberpunk.spec.ts` — zero console errors, exact scene restore on `R`.
