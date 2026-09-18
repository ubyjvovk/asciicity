/**
 * Render-style plug-in contract (docs/architecture.md §4.11). PM-owned: do
 * not change shapes without a ticket that says so. A style is a full-screen
 * fragment shader over the low-resolution scene target; `StyleRenderer`
 * (src/render/post.ts) owns the target, the quad and the common uniforms,
 * and swaps styles at runtime (`R` cycles, `?render=<id>` selects).
 */
import type * as THREE from 'three';

/** Facts a style needs when building its uniforms (atlases, palettes). */
export interface StyleContext {
  /** Cells across at the current canvas size. */
  cols: number;
  /** Cells down at the current canvas size. */
  rows: number;
  /**
   * Time-of-day factor from the sun's altitude (`daylightFactor` in
   * `world/sky.ts`): 0 at or below −6° (stars on), 1 at or above +6°,
   * linear between. Refreshed every 10 s by main.ts; read it in
   * `makeUniforms` and again in `update` for styles that react to it.
   */
  daylight: number;
  /** Fresh canvas for rasterising an atlas (browser only). */
  makeCanvas(width: number, height: number): HTMLCanvasElement;
}

/** One selectable look. Pure data + shader source; browser work only inside `makeUniforms`. */
export interface RenderStyle {
  /** URL id (`?render=<id>`), lower-case, unique across the registry. */
  id: string;
  /** Upper-case display name for the toast, e.g. `BRAILLE`. */
  label: string;
  /** Screen pixels per cell horizontally (default; `?cell=WxH` overrides). */
  cellW: number;
  /** Screen pixels per cell vertically. */
  cellH: number;
  /** Scene samples per cell horizontally — the target is `cols·subX` px wide. */
  subX: number;
  /** Scene samples per cell vertically — the target is `rows·subY` px tall. */
  subY: number;
  /** Attach a `THREE.DepthTexture`; the prelude then provides `linearDepth()`. */
  needsDepth: boolean;
  /**
   * Whether the world's perspective floor grid (`world/ground.ts`) should be
   * drawn under this style (wave 16b, T-0132). Absent = `true`. Painterly
   * styles (`quest`, `lowpoly`, `scribble` and the wave-18 sketch family) set `false`; main.ts swaps the ground map on
   * every style change.
   */
  groundGrid?: boolean;
  /**
   * Scene-target cap for this style (wave 18b, T-0145): `cols·subX ×
   * rows·subY` is clamped to it. Absent = the default 640×360
   * (`MAX_TARGET_W/H` in post.ts). The painterly sketch styles raise it to
   * 960×540 so 2×2 cells stay 2×2 at 1080p; nothing may exceed
   * `MAX_TARGET_CAP_W/H` (960×540) — the unit budget test enforces it.
   */
  targetCap?: { w: number; h: number };
  /**
   * GLSL ES 1.0 fragment shader body appended to `STYLE_PRELUDE` (which
   * declares the common uniforms, `vUv` and the helpers below). Must define
   * `void main()` writing `gl_FragColor`.
   */
  fragment: string;
  /** Style-specific uniforms (atlas textures, palettes). Called on activation; `{}` is fine. */
  makeUniforms(ctx: StyleContext): Record<string, THREE.IUniform>;
  /** Optional per-frame hook (`timeS` seconds since start) for animated styles. */
  update?(uniforms: Record<string, THREE.IUniform>, timeS: number, ctx: StyleContext): void;
  /** Optional: free GPU resources created by `makeUniforms`. */
  dispose?(uniforms: Record<string, THREE.IUniform>): void;
}

/**
 * Shared shader prelude every style is compiled with (`STYLE_PRELUDE + style.fragment`).
 *
 * Common uniforms (set by `StyleRenderer` every frame):
 *   tScene     — the scene target, `sceneSize` px, NearestFilter
 *   grid       — (cols, rows) cells
 *   sub        — (subX, subY) samples per cell
 *   sceneSize  — (cols·subX, rows·subY) px
 *   exposure   — 1.7, gamma — 0.45 (architecture §4.8), time — seconds
 *   tDepth, cameraNear, cameraFar — only meaningful when `needsDepth`
 *   viewUp     — world +Y expressed in view space (unit vec3; wave 17 v2), so a
 *                depth style can tell floors from walls at any camera pitch
 *   tanHalfFov — tan(vertical fov / 2) of the scene camera (0.7002 at 70°);
 *                view-space position of a texel = (ndc.x·tanHalfFov·aspect·d,
 *                ndc.y·tanHalfFov·d, −d) with d = linearDepth, aspect = sceneSize.x/sceneSize.y
 *   viewToWorld — mat4, the scene camera's `matrixWorld` (wave 17 v3): world
 *                position of a texel = (viewToWorld · vec4(P, 1)).xyz, world
 *                direction of a view vector = mat3(viewToWorld) · v
 * Helpers:
 *   sampleSub(cell, sx, sy) — exposed scene colour of sub-sample (sx, sy) of
 *     `cell` (0-based, cell (0,0) bottom-left; (sx, sy) = (0, 0) is the
 *     bottom-left sample of the cell — flip `sy` for top-first bit orders)
 *   cellMean(cell)  — mean exposed colour over all sub-samples of the cell
 *   bright(c)       — hue-independent brightness: clamp(max channel, 0, 1)
 *   shaped(v)       — pow(v, gamma): the perceptual density curve
 *   tintOf(c)       — hue at full brightness (c / max(bright, 0.02))
 *   linearDepth(uv) — view-space distance in metres from `tDepth` (needsDepth)
 */
export const STYLE_PRELUDE = `
precision highp float;
uniform sampler2D tScene;
uniform vec2 grid;
uniform vec2 sub;
uniform vec2 sceneSize;
uniform float exposure;
uniform float gamma;
uniform float time;
uniform sampler2D tDepth;
uniform float cameraNear;
uniform float cameraFar;
uniform vec3 viewUp;
uniform float tanHalfFov;
uniform mat4 viewToWorld;
varying vec2 vUv;
vec3 sampleSub(vec2 cell, float sx, float sy) {
  vec2 px = cell * sub + vec2(sx, sy) + 0.5;
  return texture2D(tScene, px / sceneSize).rgb * exposure;
}
vec3 cellMean(vec2 cell) {
  vec3 acc = vec3(0.0);
  for (int y = 0; y < 8; y++) {
    if (float(y) >= sub.y) break;
    for (int x = 0; x < 8; x++) {
      if (float(x) >= sub.x) break;
      acc += sampleSub(cell, float(x), float(y));
    }
  }
  return acc / (sub.x * sub.y);
}
float bright(vec3 c) { return clamp(max(max(c.r, c.g), c.b), 0.0, 1.0); }
float shaped(float v) { return pow(clamp(v, 0.0, 1.0), gamma); }
vec3 tintOf(vec3 c) { return c / max(bright(c), 0.02); }
float linearDepth(vec2 uv) {
  float z = texture2D(tDepth, uv).r;
  float ndc = z * 2.0 - 1.0;
  return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - ndc * (cameraFar - cameraNear));
}
`;

/** The trivial full-screen vertex shader shared by every style. */
export const STYLE_VERTEX = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Registry order = `R` cycle order = `?render=` ids (architecture §4.11). */
export const STYLE_ORDER = [
  'ascii',
  'gloom',
  'solarized',
  'amber',
  'braille',
  'blocks',
  'teletext',
  'dither',
  'gameboy',
  'pico8',
  'edges',
  'hatch',
  'matrix',
  'lowpoly',
  // 'quest' — disabled 2026-09-18 (user: coloured pencil replaces it); the
  // module stays (scribble imports `isNearSide`), re-add the id to re-enable.
  'scribble',
  'pencil',
  'crayon',
  'pastel',
  'watercolor',
] as const;
export type StyleId = (typeof STYLE_ORDER)[number];
