/**
 * Matrix (digital rain) render style (docs/architecture.md §4.11).
 * Pure helpers (`hash3`, `matrixGlyph`, `rainIntensity`, `matrixBrightness`)
 * are safe to import from node — no top-level side effects touch DOM or WebGL.
 * GPU work lives in `makeUniforms` / `dispose`. The rain phase reads the common
 * `time` uniform, so there is no `update` hook.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { buildGlyphAtlas, DEFAULT_RAMP } from './ascii';

/** Canvas `ctx.font` used when rasterising the shared ASCII glyph atlas. */
const ATLAS_FONT = 'bold 24px "DejaVu Sans Mono", "Courier New", monospace';

/** GLSL `fract`: `x − floor(x)`, always in [0, 1) for finite inputs. */
function fract(x: number): number {
  return x - Math.floor(x);
}

/**
 * Deterministic hash in [0, 1). Mirrors the fragment
 * `fract(sin(a·12.9898 + b·78.233 + c·37.719)·43758.5453)`.
 */
export function hash3(a: number, b: number, c: number): number {
  return fract(Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453);
}

/**
 * Glyph index for a cell at `timeS`, in `[0, count)`. Window is
 * `floor(timeS · 2 + 7 · hash(cellX, cellY, 0))` — about twice a second,
 * with a per-cell phase — then `floor(hash · count)`.
 */
export function matrixGlyph(
  cellX: number,
  cellY: number,
  timeS: number,
  count: number,
  S = 0,
): number {
  const window = Math.floor(timeS * 2 + 7 * hash3(cellX, cellY, 0));
  const base = S * (count - 1);
  const jitter = (hash3(cellX, cellY, window) - 0.5) * 8;
  return Math.min(count - 1, Math.max(0, Math.round(base + jitter)));
}

/**
 * Rain-trail intensity `I = pow(trail, 4)` in [0, 1] at column `colX`,
 * screen `y01` (`vUv.y`, 0 = bottom) and time `timeS`.
 * `trail = fract(phase − time · speed · 0.25 − y01)`; the minus on the
 * time term sends the head toward `y01 = 0`. Head when `trail > 0.96`.
 */
export function rainIntensity(colX: number, y01: number, timeS: number): number {
  const speed = 0.3 + 0.7 * hash3(colX, 1, 0);
  const phase = hash3(colX, 2, 0);
  const trail = fract(phase - timeS * speed * 0.25 - y01);
  return Math.pow(trail, 4);
}

/**
 * Body / head RGB (no glyph mask) for scene density `S` and rain `I`.
 * Body: `(0.2, 1.0, 0.3) · (S · (0.7 + 0.3 · I) + 0.25 · I)`.
 * Head: `(0.9, 1.0, 0.9) · (0.6 + 0.4 · S)`.
 */
export function matrixBrightness(
  S: number,
  I: number,
  head: boolean,
): [number, number, number] {
  if (head) {
    const k = 0.6 + 0.4 * S;
    return [0.9 * k, 1.0 * k, 0.9 * k];
  }
  const k = S * (0.7 + 0.3 * I) + 0.25 * I;
  return [0.2 * k, 1.0 * k, 0.3 * k];
}

/**
 * §4.11 matrix fragment. Prelude already declares tScene/grid/exposure/gamma
 * /time/vUv and the helpers; only tAtlas/glyphCount are extra. Local names
 * avoid clashing with `shaped` / `bright`.
 */
const MATRIX_FRAGMENT = `
uniform sampler2D tAtlas;
uniform float glyphCount;
float hash3(float a, float b, float c) {
  return fract(sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453);
}
vec3 matrixBrightness(float S, float I, bool head) {
  if (head) return vec3(0.9, 1.0, 0.9) * (0.6 + 0.4 * S);
  return vec3(0.2, 1.0, 0.3) * (S * (0.7 + 0.3 * I) + 0.25 * I);
}
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 scene = cellMean(cell);
  float S = shaped(bright(scene));
  float window = floor(time * 2.0 + 7.0 * hash3(cell.x, cell.y, 0.0));
  float jitter = (hash3(cell.x, cell.y, window) - 0.5) * 8.0;
  float idx = clamp(floor(S * (glyphCount - 1.0) + jitter + 0.5), 0.0, glyphCount - 1.0);
  vec2 inCell = fract(vUv * grid);
  float mask = texture2D(tAtlas, vec2((idx + inCell.x) / glyphCount, inCell.y)).r;
  float speed = 0.3 + 0.7 * hash3(cell.x, 1.0, 0.0);
  float phase = hash3(cell.x, 2.0, 0.0);
  float trail = fract(phase - time * speed * 0.25 - vUv.y);
  float I = pow(trail, 4.0);
  vec3 outCol = matrixBrightness(S, I, trail > 0.96) * mask;
  gl_FragColor = vec4(outCol, 1.0);
}
`;

/**
 * Digital-rain style: ASCII atlas, cell 6×12, sub 1×1, no depth texture.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'matrix',
    label: 'MATRIX',
    cellW: 6,
    cellH: 12,
    subX: 1,
    subY: 1,
    needsDepth: false,
    fragment: MATRIX_FRAGMENT,
    makeUniforms(ctx: StyleContext): Record<string, THREE.IUniform> {
      const canvas = ctx.makeCanvas(1, 1);
      const built = buildGlyphAtlas(DEFAULT_RAMP, 16, 32, ATLAS_FONT, canvas);
      const atlas = new THREE.CanvasTexture(built.canvas);
      atlas.minFilter = THREE.LinearFilter;
      atlas.magFilter = THREE.LinearFilter;
      atlas.flipY = true;
      atlas.needsUpdate = true;
      return {
        tAtlas: { value: atlas },
        glyphCount: { value: built.count },
      };
    },
    dispose(uniforms: Record<string, THREE.IUniform>): void {
      const tex = uniforms.tAtlas?.value as THREE.Texture | undefined;
      tex?.dispose();
    },
  },
];
