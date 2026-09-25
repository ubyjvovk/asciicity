# Neon signs (cyberpunk, experimental)

Street-facing tube signs for the cyberpunk night look: vertical **blade**
signs sticking out of the wall and flat **panel** signs over the shopfront,
with glowing lettering, a little flicker, and coloured light on the wall and
the wet street. Contract: `docs/architecture.md` §4.11 "`cyberpunk` v2" →
"Neon signs". The layer is experimental: on by default, `N` / `?neon=0|1`
toggles it (wiring is PM-owned).

## Modules

| file | role |
|---|---|
| `src/render/punk/neonplace.ts` | pure `placeSigns` — no `three/webgpu`, no DOM |
| `src/render/punk/neonatlas.ts` | browser-only 2048² glyph atlas |
| `src/render/punk/neon.ts` | `createNeonLayer()` — cell meshes, flicker, spill lights |

`id: 'neon'`, `rainPassThrough: true`. `CellStreamer` builds within 400 m and
drops cells past 550 m, one cell per frame. Placement sees only that cell's
`cell.roads`.

## Placement

Per building with `h ≥ 8`, each wall edge of length `≥ 6 m` whose midpoint is
within 12 m of a same-cell road centreline is kept with probability 0.12, at
most one sign (two when `h ≥ 20`). Seed is `mulberry32(id ^ 0x9e3779b9)` (the
PRNG copied from `src/world/textures.ts`). The ring is `normalizeRing`'d; the
outward normal of a CCW edge a→b is `(dz, −dx)/len`. The wall base is
`ringHeights(...).base + minH`, same as the wall meshes.

Wave 22 (T-0165): the candidate edges are the segments of
`exteriorWalls(b, heightAt)` (architecture §4.2 "Tiers") — for a tiered
building the culled tier walls, so no sign lands on an interior wall and
upper tiers get their own. The bottom offset is measured from the
segment's `base`; on tiered buildings a sign that would poke above the
segment's `top` is dropped (after its RNG draws). Without tiers the
segments are the envelope edges and the output is byte-identical
(sha256-tested on london `0_0`).

| | blade (60 %) | panel (40 %) |
|---|---|---|
| face | 0.9 m × 3–6 m | 3–7 m × 1–1.6 m |
| bottom above wall base | 3.5–5 m | 4–8 m |
| off the wall, along the normal | 0.6 m | 0.15 m |
| along the edge | 25–75 % | centred |

Words (no brand names): English for `london` / `sf` / `nyc` / `sydney` /
`synthetic` and any unknown id (`BAR`, `HOTEL`, `NOODLES`, `24H`, `KARAOKE`,
`PHARMACY`, `CINEMA`, `RAMEN`, `OPEN`, `CAFE`, `ARCADE`, `TATTOO`); Kyiv
`КАВА БАР АПТЕКА ГОТЕЛЬ КІНО ПИВО 24/7 ПЕКАРНЯ`; Tokyo
`ラーメン カラオケ 居酒屋 薬 ホテル 寿司 バー 喫茶`. About 8 % of signs flicker.
Colours: `#ff2a6d`, `#05d9e8`, `#b967ff`, `#ffb000`, `#39ff14`, `#ff073a`.

## Atlas and meshes

`getSlotUv(kind|word|color)` returns the slot rectangle on one sRGB
`CanvasTexture`. The first 64 distinct keys are drawn (near-black backing,
rounded tube border, text twice: a wide `shadowBlur` glow in the tube colour,
then a thin near-white core). Blade slots stack one glyph per row so Latin,
Cyrillic, and CJK all read top to bottom. Further keys reuse `hash % 64`
without evicting the slot. Each cell merges one face mesh (blade = two
faces, the back one U-mirrored) and one dark frame mesh (blades also get two
brackets back to the wall). The face is a `MeshStandardNodeMaterial` with
colour `0.02` and `emissiveNode = atlas × 4 × flicker`, where flicker is a
per-vertex seed times a time uniform (flickering signs are off about 5 % of
the time).

## Spill

Up to four `PointLight`s (sign colour, intensity 6, distance 14, decay 2)
retarget every 0.25 s to the nearest signs inside the camera frustum and
150 m. Intensity fades in or out over 0.3 s.

## Stats and tests

`punk.stats()` keys: `neon.signs`, `neon.visible`, `neon.lights`, `neon.slots`,
plus the streamer's `neon.cells`, `neon.pending`, `neon.buildMs`.

Unit: `tests/punk-neon.test.ts` (London `tiles/0_0.json` via `bucketSources`,
plus Kyiv/Tokyo word lists). The WebGL2 graph is gated by
`e2e/cyberpunk.spec.ts` — zero console errors, exact scene restore on `R`.
