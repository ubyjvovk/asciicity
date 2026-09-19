# `retrocgi` — 1981 wireframe-glider display

Architecture: `docs/architecture.md` §4.11 "retrocgi (wave 19)". One file
(`src/render/styles/retrocgi.ts`), one fragment shader, five pure helpers
(`isWaterColour`, `retroEdge`, `retroFade`, `retroIntensity`,
`retroColour`) tested in `tests/styles/retrocgi.test.ts`.

## Look

The glider display from *Escape from New York* (1981): chunky glowing
phosphor-green outlines of the city on a black tube, one bright shoreline,
and nothing else. The scene colour is used **only** to find water; every
cell is `RETRO_BG` plus green line light.

| Field | Value |
|-------|-------|
| `id` | `retrocgi` |
| `label` | `RETRO CGI` |
| `cellW × cellH` | 2 × 2 px |
| `subX × subY` | 1 × 1 sample per cell |
| `needsDepth` | `true` (`linearDepth(uv)` is metres) |
| `groundGrid` | `false` (the floor grid is hidden under this style) |
| `targetCap` | 960 × 540 |
| Atlas | none — the shader is analytic |

## Algorithm (per cell)

1. Snap `vUv` to the cell centre `centreUv` so all reads are consistent
   across the pixels inside a 2×2 cell; `stepUv = 1 / sceneSize`.
2. **Edge test** at the centre via `edgeAt(centreUv)`. `edgeAt(uv)` samples
   five `linearDepth` values (centre + L/R/U/D one `stepUv` away) and runs
   the same sky-rule + inverse-depth second-difference test as `edges.ts`
   `isEdge` (imported — not copied), **plus** a shoreline term: water/land
   are coplanar, so depth cannot see the coast; the cell is an edge when the
   centre's `isWaterColour` state differs from any of the same four
   neighbours'. The shoreline is skipped when the centre is sky
   (`dC ≥ 0.98·cameraFar`).
3. **Halo count**: call `edgeAt` at the four cells **two** target texels
   away (left, right, up, down) and count how many are edges.
4. **Distance fade**: `dNear = min` of the centre's five depth samples
   ignoring sky (all-sky → `FADE_FAR`); `fade = mix(1, FADE_MIN,
   smoothstep(FADE_NEAR, FADE_FAR, dNear))`.
5. **Flicker**: `flick = 1 − FLICKER + FLICKER · sin(time · 37.0)`.
6. **Intensity**: `I = (e0 ? 1 : HALO_GAIN · halo) · fade · flick`, where
   `halo = haloCount / 4`.
7. **Output**: `out = RETRO_BG + RETRO_LINE · I`, clamped to 1.

## Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `RETRO_LINE` | `(0.30, 1.00, 0.45)` | phosphor green line tint |
| `RETRO_BG` | `(0.00, 0.02, 0.00)` | never pure black — the tube glows |
| `HALO_GAIN` | `0.30` | glow contributed by a neighbouring line cell |
| `FADE_NEAR` | `150 m` | fade starts at full brightness below here |
| `FADE_FAR` | `900 m` | fade bottoms out at/ past here |
| `FADE_MIN` | `0.35` | smallest fade factor at distance |
| `FLICKER` | `0.04` | ± share of line intensity from the `time` flicker |
| water test | `b > 0.04 && b > 1.6·r && b > 1.25·g` | `WATER_HEX` 0x163a6b = (22,58,107) → ratios 4.9/1.8; fog is black, lighting grey, so both survive day, night and distance |

## Exports

```ts
export const RETRO_LINE: readonly [number, number, number]  // [0.30, 1.00, 0.45]
export const RETRO_BG: readonly [number, number, number]    // [0.00, 0.02, 0.00]
export const HALO_GAIN: number                              // 0.30
export const FADE_NEAR: number                              // 150
export const FADE_FAR: number                               // 900
export const FADE_MIN: number                               // 0.35
export const FLICKER: number                                // 0.04
export function isWaterColour(rgb: readonly [number, number, number]): boolean
export function retroEdge(
  depths: readonly number[],                                // [dC, dL, dR, dU, dD]
  colours: readonly (readonly [number, number, number])[],  // same order, exposed scene colours
  far: number,
): boolean
export function retroFade(dNear: number): number
export function retroIntensity(
  e0: boolean,
  haloCount: number,       // 0–4
  dNear: number,
  flick: number,
): number
export function retroColour(i: number): [number, number, number]
export const STYLES: readonly RenderStyle[]                 // one entry, id 'retrocgi'
```

`retroEdge`, `retroFade`, `retroIntensity` and `retroColour` are the
shader's spec: the fragment runs the same shoreline test, the same
`smoothstep` fade, and the same line-arithmetic term for term.

## Shader (per pixel, once per cell)

1. Snap to the cell centre; `stepUv = 1 / sceneSize`.
2. `edgeAt(centreUv)` — the five-sample depth test (sky rule +
   inverse-depth second difference, inlined `EDGE_K = 0.02` as in
   `edges.ts`) OR the shoreline colour test, skipped when the centre is
   sky.
3. `edgeAt` at the four cells two texels away → `halo`.
4. The centre's five depth samples → `dNear`, `fade`.
5. `flick`, then `I`, then `RETRO_BG + RETRO_LINE · I`, clamped.
6. GLSL ES 1.0: no `!=` on `bvec` (only scalar `bool` compares, which are
   fine), no dynamic loops — the four neighbours and four halo cells are
   unrolled.

## Notes

- `needsDepth: true` means `StyleRenderer` attaches a `THREE.DepthTexture`
  so `linearDepth(uv)` returns metres; `tDepth`, `cameraNear`,
  `cameraFar` come from the prelude and are never redeclared.
- 25 depth taps + 25 colour taps per cell on a ≤ 960×540 target — below the
  sketch family's cost. No noise, no world anchoring: nothing here is a
  screen-space pattern, lines sit on geometry.
- `isEdge` is imported from `./edges` rather than copied so the two styles
  can never drift on the depth rule.
- No `dispose` hook: `makeUniforms` returns `{}`, so there is no GPU
  resource to free.
