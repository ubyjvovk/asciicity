/**
 * `edges` render style (docs/architecture.md §4.11): depth-based wireframe
 * over a very dim floor. Cell 2×2, sub 1×1, `needsDepth: true`; the shader
 * reads `linearDepth` at the cell centre and one sub-sample away in each
 * cardinal direction and lights the cell green when any neighbour looks like
 * a silhouette. Pure `isEdge` mirrors the shader term for term so node tests
 * are the spec.
 */
import type { RenderStyle } from '../style';

/** Edge tint written when {@link isEdge} fires. */
export const EDGE_COLOUR: readonly [number, number, number] = [0.25, 1.0, 0.6];

/** Multiplier applied to the exposed scene colour on non-edge cells. */
export const FLOOR_GAIN = 0.12;

/** Sky cut-off as a fraction of `cameraFar`; anything at or past this is treated as sky. */
export const SKY_FRACTION = 0.98;

/**
 * True when the cell should be drawn as an edge. `dC` is `linearDepth` at
 * the cell centre and `neighbours` is the four one-sub-sample neighbour
 * depths (any order). A pair is an edge when exactly one side is sky (depth
 * ≥ {@link SKY_FRACTION} · `far`) or, with both sides non-sky, when the
 * absolute depth difference exceeds `k · min(dC, dN)`. Pure — the shader
 * runs the same test in `main()`.
 */
export function isEdge(
  dC: number,
  neighbours: readonly number[],
  far: number,
  k = 0.02,
): boolean {
  const skyThr = SKY_FRACTION * far;
  const cSky = dC >= skyThr;
  for (const dN of neighbours) {
    const nSky = dN >= skyThr;
    if (cSky && nSky) continue;
    if (cSky !== nSky) return true;
    const diff = Math.abs(dC - dN);
    if (diff > k * Math.min(dC, dN)) return true;
  }
  return false;
}

/**
 * §4.11 "edges" fragment. Reads five `linearDepth` samples (centre + 4
 * neighbours one sub-sample away in uv), applies the same sky/step logic as
 * {@link isEdge}, and outputs either {@link EDGE_COLOUR} or the exposed
 * scene colour dimmed by {@link FLOOR_GAIN}.
 */
const EDGES_FRAGMENT = `
const float EDGE_K = 0.02;
const float SKY_FRAC = 0.98;
void main() {
  vec2 cell = floor(vUv * grid);
  vec2 centreUv = (cell + 0.5) / grid;
  vec2 stepUv = 1.0 / sceneSize;
  float dC = linearDepth(centreUv);
  float dL = linearDepth(centreUv + vec2(-stepUv.x, 0.0));
  float dR = linearDepth(centreUv + vec2( stepUv.x, 0.0));
  float dU = linearDepth(centreUv + vec2(0.0,  stepUv.y));
  float dD = linearDepth(centreUv + vec2(0.0, -stepUv.y));
  float skyThr = SKY_FRAC * cameraFar;
  bool cSky = dC >= skyThr;
  bool edge = false;
  float dN;
  bool nSky;
  dN = dL; nSky = dN >= skyThr;
  if (cSky != nSky) edge = true;
  else if (!cSky && abs(dC - dN) > EDGE_K * min(dC, dN)) edge = true;
  dN = dR; nSky = dN >= skyThr;
  if (cSky != nSky) edge = true;
  else if (!cSky && abs(dC - dN) > EDGE_K * min(dC, dN)) edge = true;
  dN = dU; nSky = dN >= skyThr;
  if (cSky != nSky) edge = true;
  else if (!cSky && abs(dC - dN) > EDGE_K * min(dC, dN)) edge = true;
  dN = dD; nSky = dN >= skyThr;
  if (cSky != nSky) edge = true;
  else if (!cSky && abs(dC - dN) > EDGE_K * min(dC, dN)) edge = true;
  vec3 sceneCol = texture2D(tScene, centreUv).rgb * exposure;
  vec3 outCol = edge ? vec3(0.25, 1.0, 0.6) : sceneCol * 0.12;
  gl_FragColor = vec4(outCol, 1.0);
}
`;

/** Single-entry registry for the `edges` id (docs/architecture.md §4.11). */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'edges',
    label: 'EDGES',
    cellW: 2,
    cellH: 2,
    subX: 1,
    subY: 1,
    needsDepth: true,
    fragment: EDGES_FRAGMENT,
    makeUniforms(): Record<string, never> {
      return {};
    },
  },
];
