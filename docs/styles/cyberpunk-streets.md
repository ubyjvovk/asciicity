# cyberpunk streets v2 (T-0153)

The wet-street materials of the `cyberpunk` style, reworked from the wave-20
"uniform glitter" prototype toward the reference's rain-soaked asphalt.
Contract: `docs/architecture.md` §4.11 "`cyberpunk` v2 (wave 20b)" →
"Streets" (and "Plumbing"). The puddle mask, asphalt albedo and every material
constant live in the **pure** module `src/render/punk/streetmath.ts` (no
`three/webgpu` import) so the shader and the unit tests share numbers.

## Modules

| file | what |
|---|---|
| `streetmath.ts` (pure) | locked puddle mask + asphalt albedo + all constants |
| `street.ts` (browser) | `makeStreetMaterials(u)` → `{ road, ground, terrain, water }` |
| `tests/punk-street.test.ts` | coverage / blob-ness / albedo-band / determinism |

The API is unchanged and owned by `WetDressing` (`wet.ts`, PM): the returned
`MeshStandardNodeMaterial`s are assigned to meshes tagged `userData.surface`
`'road' | 'ground' | 'terrain' | 'water'`.

## Puddle mask (locked)

```
puddle = smoothstep(0.54, 0.62, fbm2(x·0.07, z·0.07))   // world xz
```

`puddleAt(x, z)` in `streetmath.ts` is the JS mirror; `street.ts` uses the TSL
`fbm2Node` with the same constants. Measured coverage (200 m window @ 0.5 m
steps) at offsets (0,0) / (1000,−700) / (−3000,2500): **0.344 / 0.283 / 0.262**
(mean ≈ 0.30) — the locked 25–35 % band. Puddles read as blobs (mean run
length along x ≥ 6 samples).

## Surfaces

- **Road** — dry asphalt `asphaltAlbedo` (base grey 0.0475 ± fine grain
  `vnoise(x·3, z·3)` ±0.01 ± patch `vnoise(x·0.3, z·0.3)` ±0.012, clamped to
  the 0.035–0.06 band), vertex colour kept only as a ±15 % class tint; dry
  roughness 0.52, metalness 0.12. Puddles: albedo 0.02, roughness 0.03,
  **metalness 0.9** (drives the SSR mirror in `pipeline.ts`), ripple 1.2;
  damp asphalt ripple 0.12. Ripple scale 4.2.
- **Ground (pavement)** — 1.5 m concrete tiles with 0.02 m seam bumps (normal
  perturb via finite differences), albedo 0.05–0.07, puddles at about half the
  road coverage (`smoothstep(0.60, 0.68, …)`).
- **Terrain** — the pavement look multiplied by slope darkening
  `1 − 0.5·(1 − normalWorld.y)`.
- **Water** — albedo 0.006, roughness 0.02, metalness 0.95; ripple scale 2.2
  strength 0.7 (halved in rework 1) plus a slow 2-octave wave normal (period
  8 m, drifting 0.2 m/s).

Metalness is the SSR switch (`pipeline.ts`, PM-owned): puddles/water mirror
the neon, dry asphalt (0.12) does not.

## Specular anti-aliasing (rework 1)

Full-strength ripple / wave / tile-seam normals alias into blocky
white/magenta sparkle under the half-resolution SSR beyond ~25 m. `street.ts`
fades that detail and hides the residual roughness with distance, using the
pure helpers `rippleFade(d)` and `distanceRoughness(r, d)` from
`streetmath.ts` (unit-tested):

1. `d = length(positionView)` (TSL). Normal detail — ripples, water waves,
   tile seams — is multiplied by
   `fade = 1 − smoothstep(RIPPLE_FADE_NEAR = 12, RIPPLE_FADE_FAR = 45, d)`.
2. Roughness is raised with distance to hide the residual:
   `rough = mix(rough, max(rough, ROUGH_FLOOR = 0.35), smoothstep(20, 80, d))`
   for puddles and water; dry asphalt / pavement are unchanged.
3. Grazing-angle guard: normal detail is additionally scaled by
   `smoothstep(0.05, 0.25, abs(dot(normalView, normalize(positionView))))`.
4. Water ripple strength is halved (1.4 → 0.7) and its waves are faded by
the same distance fade.

`rippleFade(d)` is 1 at d ≤ 12, 0 at d ≥ 45, monotone; `distanceRoughness(r, d)`
is unchanged at d ≤ 20, reaches `ROUGH_FLOOR` by d ≥ 80 for r < 0.35, and never
lowers roughness. The SSR half-resolution blockiness itself lives in
`pipeline.ts` (PM-owned).

## PBR detail textures (wave 23, T-0167)

`makeStreetMaterials(u, pbr?)`; without `pbr` the graphs are unchanged.
Contract: architecture.md §4.11 "PBR detail textures"; loader in `punk/pbr.ts`
(see cyberpunk-facades.md).

- Road → asphalt (3 m per repeat), ground and terrain → paving (2 m); water none.
- World xz → uv with u = x, v = −z (`horizontalUv`); anti-tiling: a second
  sample at `rotate(uv, 37°) · 0.43` (`antiTileUv`), blended by
  `vnoise(xz · 0.05)` (`antiTileBlend`) — the only double sampling (6 maps).
  The rotated sample's tangent normal is rotated back by −37°.
- Albedo × `clamp(tex / mean, 0.45, 1.8)`, pattern → mean over 15 → 60 m;
  dry roughness = mix(procedural, tex.r, 0.6); the normal (explicit TBN
  T = +x, B = −z, N = +y, `horizontalTbn`) is added to the ripple / tile-seam
  normal at strength 0.8 × fade. Under puddles the texture fades out
  (albedo is replaced by the puddle, normal × (1 − puddle), roughness →
  puddle roughness): puddles stay mirror-smooth.
- Pure mirrors (streetmath.ts): `horizontalUv`, `rotate2`, `antiTileUv`,
  `antiTileBlend`, `horizontalTbn`, `PBR_ASPHALT_M`, `PBR_PAVING_M`,
  `PBR_ROT_DEG`, `PBR_ROT_SCALE`, `PBR_BLEND_FREQ`; tested in `tests/punk-pbr.test.ts`.

## Testing

`tests/punk-street.test.ts` runs the pure `streetmath.ts` in plain node:
puddle coverage bounds per window and mean, blob run length, the asphalt
albedo band, `puddleAt` range + determinism, and the specular anti-aliasing
helpers (`rippleFade` endpoints + monotonicity, `distanceRoughness`
unchanged-at-20 / floor-by-80 / never-lowers). `street.ts` itself is
browser-only and covered by `e2e/cyberpunk.spec.ts` (zero console errors on
the WebGL2 fallback → a TSL graph that fails to compile shows up there).
