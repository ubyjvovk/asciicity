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
| `src/render/punk/neonplace.ts` | pure: `placeSigns`, `NEON_PROFILE`, atlas slot maths (`NeonSlotTable`, `neonSlotUv`, `neonAtlasKey`), and `buildNeonMeshes` (the three merged cell meshes as typed arrays) — no `three/webgpu`, no DOM |
| `src/render/punk/neonatlas.ts` | browser-only 2048² glyph atlas (canvas drawing only) |
| `src/render/punk/neon.ts` | `createNeonLayer()` — wraps the arrays in `BufferGeometry`, materials, flicker, spill lights |

`id: 'neon'`, `rainPassThrough: true`. `CellStreamer` builds within 400 m and
drops cells past 550 m, one cell per frame. Placement sees only that cell's
`cell.roads`.

## Profiles (`NEON_PROFILE`, wave 23b)

| city | p per qualifying wall | min segment | cap per building | kinds |
|---|---|---|---|---|
| `tokyo` (dense) | 0.7 | 4 m | `min(8, 2 + floor(h / 15))` | blade 45 / stack 25 / panel 22 / screen 8 % |
| default (every other id) | 0.24 | 6 m | 2 | blade 60 / panel 40 % (v1 rule) |
| `minas-tirith` | 0 | — | 0 | — |

A qualifying wall is a segment of `exteriorWalls(b, heightAt)` (architecture
§4.2 "Tiers": culled tier walls, else the envelope edges) on a building with
`h ≥ 8`, whose midpoint is within 12 m of a same-cell road centreline. Seed is
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

Each qualifying segment is *active* with p 0.7. Then up to `cap × 6`
attempts go round-robin over the active segments (screens always take the
building's longest active segment) until the cap is reached. Each attempt
rolls a kind, a word and colours, the size, a storey slot and a position
along the wall, and is rejected if it does not fit:

- bottoms sit on 3.5 m storey slots above the building's wall base
  (`ringHeights(ring).base + minH`): 3.5, 7, 10.5, … up to `min(h − 2, 30)`;
  the slot is drawn among those where the sign lies inside the segment's
  `[base, top]`;
- no two signs within 1.2 m on one wall line (colinear segments share a
  line): their wall footprints (flat signs: width × height; blades: a 0.3 m
  attachment strip × height) must be ≥ 1.2 m apart along the wall or
  vertically;
- flat signs keep 0.2 m from the segment ends (their width is clamped to
  the segment, then rejected below the kind's minimum).

| kind | size (w × h) | off wall | notes |
|---|---|---|---|
| blade | 0.8–1.2 × 3–7 m | 0.6 m | perpendicular, two faces |
| stack | 1.6 m × (n·0.9 + (n−1)·0.1) m, n = 2–4 | 0.15 m | a column of 1.6 × 0.9 m panels, each its own word/colours (`Sign.panels`, top to bottom) |
| panel | 3–7 × 1–1.6 m | 0.15 m | flat |
| screen | 6–12 × 4–8 m | 0.15 m | only h ≥ 30 m, bottom ≥ 10 m; emissive ×3 |

Screens are only legal on the third of Tokyo's signs that sit on buildings
≥ 30 m, so on those buildings the screen roll is 35 % (the other three kinds
share the rest 45 : 25 : 22); after fit rejections the city-wide share on
tile `−6_−1` is ≈ 8 % (blade 43.7, stack 25.4, panel 22.7, screen 8.1 %).

Measured on tile `−6_−1` (`FLAT_HEIGHT`, node): Shinjuku East-Exit cell
`(−24, −4)` 166 signs / ≈ 16 k triangles; busiest cell 497 signs / ≈ 43 k
triangles; the whole tile 2 221 signs placed in ≈ 90 ms.

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
`#39ff14`, `#ff073a`, warm white `#fff1c1`, sodium `#ffcc33`. Every sign (and
every stack panel) has a `text` colour and a different `border` (tube)
colour. The spill light and the glow card use the text colour.

## Atlas

One sRGB 2048² `CanvasTexture`, **128** landscape slots of 256 × 128 px
(8 columns × 16 rows). `getSlotUv(kind, word, text, border)` keys the slot
by `kind|word|text|border` through the pure `NeonSlotTable`: the first 128
distinct keys are drawn in order; later keys reuse `hash(key) % 128`
(FNV-1a) without evicting. Each slot: near-black backing, a rounded tube
border in the border colour (glow + thin white core), the word stroked twice
(wide `shadowBlur` glow in the text colour, thin near-white core), glyphs
pre-squashed for the kind's nominal face aspect so they read upright.

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
   the wall, 2.2 × the sign's size (blades: at least 1 m wide), colour =
   linear text colour × 0.35 (per-vertex `glow` attribute), opacity =
   squared radial falloff × flicker; `MeshBasicNodeMaterial`, additive,
   `depthWrite: false`, fog on.

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
the v2 cases 1–8 on Tokyo `tiles/-6_-1.json` (counts, cap/spacing/storey
slots, kind shares, default ≈ 2× v1, words/colours, atlas slot table,
triangle and time budget, determinism). The WebGL2 graph is gated by
`e2e/cyberpunk.spec.ts` — zero console errors, exact scene restore on `R`.
