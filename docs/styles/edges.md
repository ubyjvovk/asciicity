# `edges` — depth-based wireframe

Architecture: `docs/architecture.md` §4.11 "edges". One file
(`src/render/styles/edges.ts`), one fragment shader, one pure helper
(`isEdge`) tested in `tests/styles/edges.test.ts`.

## Look

A dim, near-black city with green silhouettes traced along every depth
discontinuity — building outlines, kerbs, the horizon where geometry meets
sky. The floor stays faintly visible so the player still perceives ground
motion.

| Field | Value |
|-------|-------|
| `id` | `edges` |
| `label` | `EDGES` |
| `cellW × cellH` | 2 × 2 px |
| `subX × subY` | 1 × 1 sample per cell |
| `needsDepth` | `true` (`linearDepth(uv)` is metres) |
| Atlas | none — the shader is analytic |

## Algorithm

Per cell:

1. Sample the linear depth at the cell centre `dC = linearDepth(centreUv)`
   and at four neighbours one sub-sample (`1 / sceneSize`) away —
   `dL`, `dR`, `dU`, `dD`.
2. Compute the sky threshold `skyThr = 0.98 · cameraFar` (any depth at or
   past that is treated as sky).
3. For each neighbour pair (`dC`, `dN`):
   - if both are sky → not an edge for this pair;
   - if exactly one is sky → edge;
   - otherwise → edge when `|dC − dN| > k · min(dC, dN)` with `k = 0.02`.
4. If any of the four pairs is an edge, output the green tint
   `(0.25, 1.0, 0.6)`; otherwise output the exposed scene colour multiplied
   by `0.12` so the ground grid stays faintly visible.

Because the tolerance is proportional to depth, distant surfaces need bigger
absolute steps to register — the horizon does not fizz with false positives.

## Exports

```ts
export const EDGE_COLOUR: readonly [number, number, number]  // [0.25, 1.0, 0.6]
export const FLOOR_GAIN: number                              // 0.12
export const SKY_FRACTION: number                            // 0.98
export function isEdge(
  dC: number,
  neighbours: readonly number[],  // any order; length ≥ 1
  far: number,
  k?: number,                     // default 0.02
): boolean
export const STYLES: readonly RenderStyle[]                  // one entry, id 'edges'
```

`isEdge` is the shader's spec: the four `if`/`else if` chains in the
fragment run the same test with `k = 0.02` hard-coded.

## Shader (per pixel, once per cell)

1. Snap `vUv` to the cell centre so all four neighbour reads are consistent
   across the pixels inside a 2×2 cell.
2. Read five `linearDepth` samples (centre + L/R/U/D one `stepUv = 1 /
   sceneSize` step away).
3. Run the same sky / step logic as `isEdge` in-line. GLSL ES 1.0 has no
   dynamic arrays; the four pairs are inlined.
4. On edge → `EDGE_COLOUR`; otherwise → `sceneCol · FLOOR_GAIN`.

## Notes

- `needsDepth: true` means `StyleRenderer` attaches a `THREE.DepthTexture`
  to the scene target and hooks up `tDepth`, `cameraNear`, `cameraFar` so
  the prelude helper `linearDepth(uv)` returns metres.
- Cell 2×2 puts the scene target at (up to) 640×360 at 1080p — the same
  budget as every other style.
- No `dispose` hook: `makeUniforms` returns `{}`, so there is no GPU
  resource to free.
