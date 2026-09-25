# cyberpunk (wave 20)

Rain-soaked neon noir on the real city maps: a port of
[ektogamat/threejs-conference](https://github.com/ektogamat/threejs-conference)
("Threejs-Punk", Anderson Mancini & Sunag, MIT) onto AsciiCity's scene. Contract and
integration: `docs/architecture.md` §4.11 "`cyberpunk` (wave 20)".

## Modules (`src/render/punk/`, browser-only unless noted)

| file | what | origin |
|---|---|---|
| `view.ts` | `PunkView`: `#punk` canvas, `WebGPURenderer`, scene swap, frame | new |
| `pipeline.ts` | TSL post graph: MRT, SSR, bloom, flare, grade, chroma, vignette, SMAA, grain | `post/postprocessing.js`, `post/look/cyberpunkLook.js`, `tsl/edgeChromaticAberration.js` (MIT) |
| `look.ts` (pure) | six colour-grade presets, `L` cycle | `cyberpunkLook.js` (MIT), fog ×5 for city scale |
| `rain.ts` | height pass + closed-form streaks and splashes | `weather/createCollisionHeight.js`, `createCollisionRain.js` (MIT), reworked |
| `rainmath.ts` (pure) | rain constants + CPU mirror of the drop maths | new |
| `ripples.ts` | ripple normals for wet horizontals | `tsl/rainRipples.js` (MIT) |
| `wet.ts` | neon windows, wet roads/roofs/terrain/water | `ground/createGround.js` ideas (MIT) |
| `glass.ts` | rain on the lens | `tsl/rainGlass.js` ← rocksdanister/rain (CC BY-NC-SA 3.0 → project licence 4.0) |

No upstream assets (`public/` models, textures, videos, audio — proprietary)
are used: the splash sprite, puddle mask and night env map are procedural.

## Differences from upstream

- **Rain without compute.** Each drop is a function of (instance, time): phase
  `f = fract(t·v/SPAN + h)`, new xz per cycle, wrapped into a 70 m box around
  the point ahead of the camera; hidden once `f` passes the collision height,
  then its own splash plays for 0.22 s. Same graph on WebGPU and WebGL2.
- **Height map orientation.** Render targets sample top-row-first on both
  backends; with the ortho camera's up = −z the lookup is
  `v = (z − c.z)/96 + 0.5`. Verified with `?punkdebug=height` (overlays the
  map in the top-left corner) against OSM footprints at London `?at=bank`.
- **Reflections.** SSR over every surface with metalness (puddles ~0.85,
  water 0.95) instead of one planar mirror — our streets are on hills.
  WebGPU backend only (SSRNode fails to compile on WebGL2).
- **Lens rain** is a steady, toggleable layer (`G`) over the sharp frame, not
  a blurred intro; fewer static beads.
- **Dropped:** GTAO, DoF, car droplets, billboards, smoke, planes, audio.

## Debug / tests

- `window.__asciicity.punk`: `status` (`off|loading|ready|failed`),
  `backend` (`WebGPU|WebGL2`), `look`, `glass`, `probe(x, z)` → collision
  height at a world point.
- `?punkdebug=height` — height-map overlay.
- Unit: `tests/punk.test.ts`. E2E: `e2e/cyberpunk.spec.ts` (SwiftShader →
  WebGL2 backend).
- Chrome with `--enable-unsafe-webgpu` (needed for WebGPU on Linux) rejects
  three r185's identity `swizzle: 'rgba'` view descriptor; `view.ts` strips
  it (`patchIdentitySwizzle`).

## Known gaps

- `P` postcard captures `#view`, i.e. the WebGL fallback frame, not `#punk`.
