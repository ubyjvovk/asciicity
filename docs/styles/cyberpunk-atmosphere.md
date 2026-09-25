# cyberpunk atmosphere (wave 20b, T-0157)

How light diffuses through the wet night air: analytic height fog, wide
fog-weighted halos from the emissive layer, horizon light pollution, and
drifting low ground mist. Sits on top of the upstream distance fog in
`punk/atmosphere.ts`. Contract and integration:
`docs/architecture.md` §4.11 "`cyberpunk` v2 (wave 20b)" → "Atmosphere".

## Files

| file | what |
|---|---|
| `punk/atmosphere.ts` (browser-only) | TSL graph: height fog, wide halo, horizon glow, ground mist, over the upstream distance fog |
| `punk/fogmath.ts` (pure, no `three/webgpu`) | analytic height-fog integral, ground-mist opacity, constants — the unit-testable mirror |
| `tests/punk-fog.test.ts` | unit tests for `fogmath.ts` |

`AtmosphereInputs` / `FogUniforms` / the `Atmosphere` return shape are
PM-owned (unchanged); `pipeline.ts` refreshes `cameraWorld` and
`projectionInverse` before `atmosphere.update(camera, timeS)`.

## Height fog

Density falls off exponentially with height above the camera ground:

```
ρ(y) = ρ0 · exp(−(y − y0)/H)      H = 18 m,  y0 = camera.y − 1.7 m
ρ0 = RHO0_BASE · fogAmount        RHO0_BASE = 0.006
```

Transmittance along the straight view ray is the closed form of ∫ρ ds
(`fogmath.heightFogTransmittance(camY, pY, dist, rho0, H, y0)`); the
horizontal limit `camY ≈ pY` is handled continuously. The height fog amount
`1 − T` is combined with the look's distance fog and the sky fog by `max()`,
then gated by `fogEnabled`/`fogAmount` exactly like the upstream fog. A lit
window at y0 + 10 m, 300 m away under neonNoir keeps ≈ 0.44 of its
emissive (≥ 0.35 floor, unit-tested).

## Light halos

The raw emissive attachment is blurred at ¼ resolution with a wide Gaussian
(`gaussianBlur(emissive, sigma≈3 % screen height, 4, { resolutionScale: 0.25 })`)
and added as a halo weighted `0.25 + fogAmountAtPixel` — far lights in fog
glow wider and softer. One ¼-res blur keeps the cost well under budget; no
per-pixel loop exceeds 8 taps.

## Horizon light pollution

For sky pixels (linear depth > 0.98) the blurred emissive is sampled a few
times along the horizon row of the current column and added, fading to 0 at
30° above the horizon (fade from the view ray's world up-component
`(pY − camY)/dist`, `sin 30° = 0.5`).

## Ground mist

Extra density only within `MIST_H = 2.5 m` above y0, a 2-octave value noise
(`fbm2Node`) drifting at `0.3 m/s`, opacity ≤ `MIST_MAX = 0.25`, tinted with
the fog colour. `fogmath.mistOpacity(y, y0, noise)` is the pure mirror.

## Stats

`__asciicity.punk.stats()` exposes `atmosphere.{h, rho0Base, mistH, mistMax,
camY}` plus the existing layer / renderer numbers.
