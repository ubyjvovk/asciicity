/**
 * `retrocgi` render style (docs/architecture.md §4.11 "`retrocgi` (wave
 * 19)"): the 1981 wireframe-glider display from *Escape from New York* —
 * chunky glowing phosphor-green outlines of the city on a black tube, one
 * bright shoreline, and nothing else. Cell 2×2, sub 1×1, `needsDepth:
 * true`, `groundGrid: false`, target capped at 960×540. Every cell is
 * `BG` plus green line light; the scene colour is used only to find water
 * (the shoreline), never as a fill. The pure mirrors below reproduce the
 * shader term for term so node tests are the spec.
 */
import type { RenderStyle } from '../style';
import { isEdge } from './edges';

/** Phosphor-green line tint written on edge cells (RETRO_LINE, §4.11). */
export const RETRO_LINE: readonly [number, number, number] = [0.3, 1.0, 0.45];

/** Tube background — never pure black, the CRT glows (RETRO_BG, §4.11). */
export const RETRO_BG: readonly [number, number, number] = [0.0, 0.02, 0.0];

/** Glow contributed by a neighbouring line cell (HALO_GAIN, §4.11). */
export const HALO_GAIN = 0.3;

/** Distance (m) at which the fade begins: full brightness below this (FADE_NEAR, §4.11). */
export const FADE_NEAR = 150;

/** Distance (m) at which the fade bottoms out (FADE_FAR, §4.11). */
export const FADE_FAR = 900;

/** Smallest fade factor at distance (FADE_MIN, §4.11). */
export const FADE_MIN = 0.35;

/** Peak ± share of line intensity from the `time` flicker (FLICKER, §4.11). */
export const FLICKER = 0.04;

/**
 * True when an exposed scene colour reads as water: `b > 0.04` and
 * `b > 1.6·r` and `b > 1.25·g` (§4.11). `WATER_HEX` 0x163a6b = (22,58,107)
 * gives ratios 4.9 / 1.8, and because the fog is black and lighting grey
 * both ratios survive day, night and distance.
 */
export function isWaterColour(rgb: readonly [number, number, number]): boolean {
  const [r, g, b] = rgb;
  return b > 0.04 && b > 1.6 * r && b > 1.25 * g;
}

/** Shoreline gate: the colour test runs only where `|dot(n, viewUp)|` exceeds this (floors, water). */
export const SHORE_UP = 0.8;

/**
 * True when the cell is lit as a line: the depth edge test (`isEdge`,
 * imported — sky rule + inverse-depth second difference) OR a shoreline,
 * where the water/land state of the centre differs from any of the four
 * neighbours. `depths` is `[dC, dL, dR, dU, dD]` and `colours` the matching
 * exposed scene colours in the same order. The shoreline is skipped when
 * the centre is sky (`dC ≥ 0.98·far`) because water and land are coplanar
 * and only the colour test can see the coast — but sky has no coast — and
 * when `up` (`|dot(viewNormal, viewUp)|`, default 1) is ≤ {@link SHORE_UP}:
 * water is flat, blue window-lit facades are not.
 */
export function retroEdge(
  depths: readonly number[],
  colours: readonly (readonly [number, number, number])[],
  far: number,
  up = 1,
): boolean {
  const [dC, dL, dR, dU, dD] = depths;
  const [cC, cL, cR, cU, cD] = colours;
  if (isEdge(dC, [dL, dR, dU, dD], far)) return true;
  // Shoreline — skipped when the centre is sky.
  if (dC >= 0.98 * far) return false;
  // … and on anything but a horizontal surface: water is always flat, while a
  // blue facade with lit windows alternates water/not-water per texel (PM
  // GPU review 2026-09-19: stippled towers). `up` = |dot(viewNormal, viewUp)|.
  if (up <= SHORE_UP) return false;
  const wC = isWaterColour(cC);
  return (
    wC !== isWaterColour(cL) ||
    wC !== isWaterColour(cR) ||
    wC !== isWaterColour(cU) ||
    wC !== isWaterColour(cD)
  );
}

/**
 * Distance fade: `mix(1, FADE_MIN, smoothstep(FADE_NEAR, FADE_FAR, dNear))`
 * — 1 at ≤ 150 m, FADE_MIN at ≥ 900 m, smooth in between (§4.11).
 */
export function retroFade(dNear: number): number {
  const t = smoothstep(FADE_NEAR, FADE_FAR, dNear);
  return 1 + (FADE_MIN - 1) * t;
}

/** GLSL `smoothstep` (Hermite), used by {@link retroFade}. */
function smoothstep(e0: number, e1: number, x: number): number {
  if (x <= e0) return 0;
  if (x >= e1) return 1;
  const t = (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

/**
 * Final line intensity: a line cell (e0) is full brightness; otherwise a
 * halo cell carries `HALO_GAIN · (haloCount / 4)`. `dNear` and `flick` are
 * applied as `· fade · flick` (§4.11). The halo never adds to a line cell.
 */
export function retroIntensity(
  e0: boolean,
  haloCount: number,
  dNear: number,
  flick: number,
): number {
  const core = e0 ? 1 : HALO_GAIN * (haloCount / 4);
  return core * retroFade(dNear) * flick;
}

/**
 * Output colour for intensity `i`: `RETRO_BG + RETRO_LINE · i`, each
 * channel clamped to [0, 1] (§4.11). `i = 0` is exactly `RETRO_BG`.
 */
export function retroColour(i: number): [number, number, number] {
  return [
    Math.min(1, RETRO_BG[0] + RETRO_LINE[0] * i),
    Math.min(1, RETRO_BG[1] + RETRO_LINE[1] * i),
    Math.min(1, RETRO_BG[2] + RETRO_LINE[2] * i),
  ];
}

/**
 * §4.11 "retrocgi" fragment. Every cell is `RETRO_BG` plus green line light
 * `RETRO_LINE · I`; the scene colour is read only to test for water. Five
 * `edgeAt` calls (centre + the four cells two texels away) feed the halo
 * count; the centre's five depth samples feed the distance fade.
 */
const RETROCGI_FRAGMENT = `
const vec3 RETRO_LINE = vec3(0.30, 1.00, 0.45);
const vec3 RETRO_BG = vec3(0.00, 0.02, 0.00);
const float HALO_GAIN = 0.30;
const float FADE_NEAR = 150.0;
const float FADE_FAR = 900.0;
const float FADE_MIN = 0.35;
const float FLICKER = 0.04;
const float SKY_FRAC = 0.98;
const float EDGE_K = 0.02;
const float SHORE_UP = 0.8;

vec3 retroViewPos(vec2 uv, float d) {
  float asp = sceneSize.x / sceneSize.y;
  return vec3((uv.x * 2.0 - 1.0) * tanHalfFov * asp * d, (uv.y * 2.0 - 1.0) * tanHalfFov * d, -d);
}

bool isWater(vec3 rgb) {
  return rgb.b > 0.04 && rgb.b > 1.6 * rgb.r && rgb.b > 1.25 * rgb.g;
}

bool edgeAt(vec2 uv) {
  vec2 stepUv = 1.0 / sceneSize;
  float dC = linearDepth(uv);
  float dL = linearDepth(uv + vec2(-stepUv.x, 0.0));
  float dR = linearDepth(uv + vec2( stepUv.x, 0.0));
  float dU = linearDepth(uv + vec2(0.0,  stepUv.y));
  float dD = linearDepth(uv + vec2(0.0, -stepUv.y));
  float skyThr = SKY_FRAC * cameraFar;
  bool cSky = dC >= skyThr;
  bool depthEdge = false;
  if (cSky != (dL >= skyThr)) depthEdge = true;
  if (cSky != (dR >= skyThr)) depthEdge = true;
  if (cSky != (dU >= skyThr)) depthEdge = true;
  if (cSky != (dD >= skyThr)) depthEdge = true;
  if (!depthEdge && !cSky) {
    float wC = 1.0 / dC;
    float wL = 1.0 / dL;
    float wR = 1.0 / dR;
    float wU = 1.0 / dU;
    float wD = 1.0 / dD;
    if (abs(wL + wR - 2.0 * wC) > EDGE_K * wC) depthEdge = true;
    if (abs(wU + wD - 2.0 * wC) > EDGE_K * wC) depthEdge = true;
  }
  // Shoreline — skipped when the centre is sky.
  if (dC >= skyThr) return depthEdge;
  if (depthEdge) return true;
  // Horizontal surfaces only (no depth edge here, so the four neighbours span one plane).
  vec3 ta = retroViewPos(uv + vec2(stepUv.x, 0.0), dR) - retroViewPos(uv - vec2(stepUv.x, 0.0), dL);
  vec3 tb = retroViewPos(uv + vec2(0.0, stepUv.y), dU) - retroViewPos(uv - vec2(0.0, stepUv.y), dD);
  if (abs(dot(normalize(cross(ta, tb)), viewUp)) <= SHORE_UP) return false;
  vec3 cC = texture2D(tScene, uv).rgb * exposure;
  vec3 cL = texture2D(tScene, uv + vec2(-stepUv.x, 0.0)).rgb * exposure;
  vec3 cR = texture2D(tScene, uv + vec2( stepUv.x, 0.0)).rgb * exposure;
  vec3 cU = texture2D(tScene, uv + vec2(0.0,  stepUv.y)).rgb * exposure;
  vec3 cD = texture2D(tScene, uv + vec2(0.0, -stepUv.y)).rgb * exposure;
  bool wC = isWater(cC);
  if (wC != isWater(cL)) return true;
  if (wC != isWater(cR)) return true;
  if (wC != isWater(cU)) return true;
  if (wC != isWater(cD)) return true;
  return depthEdge;
}

void main() {
  vec2 cell = floor(vUv * grid);
  vec2 centreUv = (cell + 0.5) / grid;
  vec2 stepUv = 1.0 / sceneSize;

  bool e0 = edgeAt(centreUv);
  bool eL = edgeAt(centreUv + vec2(-2.0 * stepUv.x, 0.0));
  bool eR = edgeAt(centreUv + vec2( 2.0 * stepUv.x, 0.0));
  bool eU = edgeAt(centreUv + vec2(0.0,  2.0 * stepUv.y));
  bool eD = edgeAt(centreUv + vec2(0.0, -2.0 * stepUv.y));
  float halo = HALO_GAIN * (float(int(eL) + int(eR) + int(eU) + int(eD)) / 4.0);

  // Distance fade from the centre's five depth samples (sky ignored; all-sky → FADE_FAR).
  float dC = linearDepth(centreUv);
  float dL = linearDepth(centreUv + vec2(-stepUv.x, 0.0));
  float dR = linearDepth(centreUv + vec2( stepUv.x, 0.0));
  float dU = linearDepth(centreUv + vec2(0.0,  stepUv.y));
  float dD = linearDepth(centreUv + vec2(0.0, -stepUv.y));
  float skyThr = SKY_FRAC * cameraFar;
  float dNear = FADE_FAR;
  if (dC < skyThr) dNear = min(dNear, dC);
  if (dL < skyThr) dNear = min(dNear, dL);
  if (dR < skyThr) dNear = min(dNear, dR);
  if (dU < skyThr) dNear = min(dNear, dU);
  if (dD < skyThr) dNear = min(dNear, dD);

  float fade = mix(1.0, FADE_MIN, smoothstep(FADE_NEAR, FADE_FAR, dNear));
  float flick = 1.0 - FLICKER + FLICKER * sin(time * 37.0);
  float I = (e0 ? 1.0 : halo) * fade * flick;
  vec3 outCol = RETRO_BG + RETRO_LINE * I;
  gl_FragColor = vec4(min(outCol, vec3(1.0)), 1.0);
}
`;

/** Single-entry registry for the `retrocgi` id (docs/architecture.md §4.11). */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'retrocgi',
    label: 'RETRO CGI',
    cellW: 2,
    cellH: 2,
    subX: 1,
    subY: 1,
    needsDepth: true,
    groundGrid: false,
    targetCap: { w: 960, h: 540 },
    fragment: RETROCGI_FRAGMENT,
    makeUniforms(): Record<string, never> {
      return {};
    },
  },
];
