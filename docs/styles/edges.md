# `edges` — depth-based wireframe

Architecture: `docs/architecture.md` §4.11 "edges". One file
(`src/render/styles/edges.ts`), one fragment shader, one pure helper
(`isEdge`) tested in `tests/styles/edges.test.ts`.

## Look

A dim, near-black city with green silhouettes and creases traced along every
depth bend — building outlines, kerbs, floor↔wall creases, the horizon where
geometry meets sky. The floor stays faintly visible so the player still
perceives ground motion.

| Field | Value |
|-------|-------|
| `id` | `edges` |
| `label` | `EDGES` |
| `cellW × cellH` | 2 × 2 px |
| `subX × subY` | 1 × 1 sample per cell |
| `needsDepth` | `true` (`linearDepth(uv)` is metres) |
| Atlas | none — the shader is analytic |

## Algorithm (revised 2026-08-27)

Per cell:

1. Sample the linear depth at the cell centre `dC = linearDepth(centreUv)`
   and at four neighbours one sub-sample (`1 / sceneSize`) away, in the
   order `dL, dR, dU, dD`.
2. Compute the sky threshold `skyThr = 0.98 · cameraFar` (any depth at or
   past that is treated as sky).
3. **Sky rule** (unchanged): if the centre and any neighbour disagree on
   `sky`, the cell is an edge; all samples sky is never an edge.
4. **Inverse-depth second difference** (all samples non-sky). Let
   `w = 1 / d`, which is exactly linear across any plane in screen space.
   The cell is an edge when the inverse depth *bends* along either cardinal:

   ```
   |wL + wR − 2·wC| > k · wC   or   |wU + wD − 2·wC| > k · wC
   ```

   with `k = 0.02`. Flat ground and long walls give zero response at every
   distance (no false positives on grazing surfaces), while silhouettes and
   creases (floor↔wall, building corners, wall-in-front-of-ground) fire
   because their inverse-depth profile is not linear.

5. If the cell is an edge, output the green tint `(0.25, 1.0, 0.6)`;
   otherwise output the exposed scene colour multiplied by `0.12` so the
   ground grid stays faintly visible.

The previous first-difference rule (`|dC − dN| > k · min(dC, dN)`) lit every
grazing surface — neighbouring depth samples on a plane differ by more than
2 % at distance — which is why the second difference of inverse depth
replaced it.

## Exports

```ts
export const EDGE_COLOUR: readonly [number, number, number]  // [0.25, 1.0, 0.6]
export const FLOOR_GAIN: number                              // 0.12
export const SKY_FRACTION: number                            // 0.98
export const EDGE_K: number                                  // 0.02
export function isEdge(
  dC: number,
  neighbours: readonly [number, number, number, number],  // [dL, dR, dU, dD]
  far: number,
  k?: number,                                             // default EDGE_K
): boolean
export const STYLES: readonly RenderStyle[]                 // one entry, id 'edges'
```

`isEdge` is the shader's spec: the fragment runs the same sky rule and the
same two inverse-depth second-difference tests with `k = 0.02` hard-coded
as `EDGE_K`.

## Shader (per pixel, once per cell)

1. Snap `vUv` to the cell centre so all four neighbour reads are consistent
   across the pixels inside a 2×2 cell.
2. Read five `linearDepth` samples (centre + L/R/U/D one `stepUv = 1 /
   sceneSize` step away).
3. Run the same sky rule as `isEdge` in-line (four `cSky != (dN >= skyThr)`
   tests).
4. If not already an edge and the centre is non-sky, compute `w = 1/d` for
   the five samples and test the two cardinal second differences against
   `EDGE_K · wC`. GLSL ES 1.0 has no dynamic arrays, so these are inlined.
5. On edge → `EDGE_COLOUR`; otherwise → `sceneCol · FLOOR_GAIN`.

## Notes

- `needsDepth: true` means `StyleRenderer` attaches a `THREE.DepthTexture`
  to the scene target and hooks up `tDepth`, `cameraNear`, `cameraFar` so
  the prelude helper `linearDepth(uv)` returns metres.
- Cell 2×2 puts the scene target at (up to) 640×360 at 1080p — the same
  budget as every other style.
- No `dispose` hook: `makeUniforms` returns `{}`, so there is no GPU
  resource to free.
