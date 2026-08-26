/**
 * Matrix (digital rain) render style (docs/architecture.md §4.11).
 * Pure helpers (`hash3`, `matrixGlyph`, `rainIntensity`) are safe to import
 * from node — no top-level side effects touch DOM or WebGL. GPU work lives
 * in `makeUniforms` / `dispose`. The rain phase reads the common `time`
 * uniform, so there is no `update` hook.
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
 * Glyph index for a cell at `timeS`, in `[0, count)`. Constant on each
 * 1/8-second window (`floor(timeS · 8)`), then `floor(hash · count)`.
 */
export function matrixGlyph(
  cellX: number,
  cellY: number,
  timeS: number,
  count: number,
): number {
  return Math.floor(hash3(cellX, cellY, Math.floor(timeS * 8)) * count);
}

/**
 * Rain-trail intensity in [0, 1] at column `colX`, screen `y01` (`vUv.y`,
 * 0 = bottom) and time `timeS`. `pow(trail, 3)` of
 * `fract(phase + time·speed·0.25 − y01)`; the head is where this is max
 * (`trail > 0.97` in the shader).
 */
export function rainIntensity(colX: number, y01: number, timeS: number): number {
  const speed = 0.3 + 0.7 * hash3(colX, 1, 0);
  const phase = hash3(colX, 2, 0);
  const trail = fract(phase + timeS * speed * 0.25 - y01);
  return Math.pow(trail, 3);
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
void main() {
  vec2 cell = floor(vUv * grid);
  float idx = floor(hash3(cell.x, cell.y, floor(time * 8.0)) * glyphCount);
  vec2 inCell = fract(vUv * grid);
  float mask = texture2D(tAtlas, vec2((idx + inCell.x) / glyphCount, inCell.y)).r;
  vec3 scene = cellMean(cell);
  float dens = 0.35 + 0.65 * shaped(bright(scene));
  float speed = 0.3 + 0.7 * hash3(cell.x, 1.0, 0.0);
  float phase = hash3(cell.x, 2.0, 0.0);
  float trail = fract(phase + time * speed * 0.25 - vUv.y);
  float intensity = pow(trail, 3.0);
  vec3 rain = vec3(0.2, 1.0, 0.3) * mask * dens * (0.4 + 0.6 * intensity);
  vec3 head = vec3(0.9, 1.0, 0.9) * mask;
  vec3 outCol = trail > 0.97 ? head : rain;
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
