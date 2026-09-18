/**
 * `scribble` render style (docs/architecture.md §4.11, wave 17 T-0134, v2
 * T-0136): a coloured-ink scribble sketch on white paper — tone carried by
 * stroke *density*, long wobbly pen strokes that follow the surface
 * (vertical on walls, horizontal on the ground, a loose tangle in the sky),
 * ink coloured by the object under it, one-sided pencil outlines, far
 * buildings sketched lighter. Cell 3×3, sub 1×1, `needsDepth: true`,
 * `groundGrid: false`. Strokes are drawn **analytically per canvas pixel**
 * in continuous cell space (`p = vUv · grid`, NOT floored) so a line runs
 * unbroken across many cells like a real pen; only the scene sample, the
 * depth taps and the class are per cell (`cell = floor(p)`). Pure helpers
 * (`SCRIBBLE_LAYERS`, `UP_K`, `PAPER`, `INK`, `SKY_INK`, `hash2`,
 * `viewPos`, `viewNormal`, `surfaceClass`, `skyDensity`, `depthFade`,
 * `strokeInk`, `tangleInk`, `surfaceOutline`, `inkColour`, `washColour`)
 * mirror the shader term for term and are unit-tested in node. v2 (T-0136)
 * classifies ground/wall from the **view-space normal** (with clamped depth
 * taps) instead of the vertical slope, and lightens the wash / darkens the
 * ink / densifies the sky tangle.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { isEdge } from './edges';
import { isNearSide } from './quest';

/** GLSL `fract(x)`: fractional part, non-negative for non-negative x. */
function fract(x: number): number {
  return x - Math.floor(x);
}

/** GLSL `mix(a, b, t) = a + (b − a)·t`. */
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** GLSL `smoothstep(edge0, edge1, x)`: clamped, Hermite-smoothed 0→1. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** GLSL `clamp(x, lo, hi)`: saturate `x` into `[lo, hi]`. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Deterministic hash in `[0, 1)`; mirrors the matrix hash (c = 0). */
export function hash2(a: number, b: number): number {
  return fract(Math.sin(a * 12.9898 + b * 78.233) * 43758.5453);
}

/**
 * The white paper ground of the sketch (§4.11). `[r, g, b]` in `[0, 1]`.
 */
export const PAPER: readonly [number, number, number] = [0.98, 0.97, 0.94];

/** The neutral pen ink (§4.11); surfaces mix toward this for grey things. */
export const INK: readonly [number, number, number] = [0.12, 0.1, 0.12];

/** The loose sky tangle ink (§4.11), a dim violet-grey. */
export const SKY_INK: readonly [number, number, number] = [0.15, 0.14, 0.18];

/** Ground/wall cut on `up = |dot(n, viewUp)|` (§4.11 v2): ground if `up > UP_K`. */
export const UP_K = 0.6;

/**
 * The three surface stroke layers, coarse to fine (§4.11):
 * `{ spacing, threshold }` — a layer only draws where `tone > threshold`.
 */
export const SCRIBBLE_LAYERS: readonly { spacing: number; threshold: number }[] = [
  { spacing: 8, threshold: 0.1 },
  { spacing: 4, threshold: 0.4 },
  { spacing: 2, threshold: 0.7 },
];

/**
 * View-space position of a texel (§4.11 v2 `viewPos`):
 * `((uv.x·2 − 1)·tanHalfFov·aspect·d, (uv.y·2 − 1)·tanHalfFov·d, −d)` with
 * `d` the linear depth and `aspect = sceneSize.x/sceneSize.y` — mirrors the
 * STYLE_PRELUDE position formula.
 */
export function viewPos(
  uv: readonly [number, number],
  d: number,
  tanHalfFov: number,
  aspect: number,
): [number, number, number] {
  return [
    (uv[0] * 2 - 1) * tanHalfFov * aspect * d,
    (uv[1] * 2 - 1) * tanHalfFov * d,
    -d,
  ];
}

/**
 * Unit view-space surface normal (§4.11 v2 `viewNormal`):
 * `normalize(cross(P(uvR, dR) − P(uvL, dL), P(uvU, dU) − P(uvD, dD)))` over
 * the four L/R/U/D depth taps, each via {@link viewPos}.
 */
export function viewNormal(
  uvs: {
    L: readonly [number, number];
    R: readonly [number, number];
    U: readonly [number, number];
    D: readonly [number, number];
  },
  depths: { L: number; R: number; U: number; D: number },
  tanHalfFov: number,
  aspect: number,
): [number, number, number] {
  const pL = viewPos(uvs.L, depths.L, tanHalfFov, aspect);
  const pR = viewPos(uvs.R, depths.R, tanHalfFov, aspect);
  const pU = viewPos(uvs.U, depths.U, tanHalfFov, aspect);
  const pD = viewPos(uvs.D, depths.D, tanHalfFov, aspect);
  const ax = pR[0] - pL[0];
  const ay = pR[1] - pL[1];
  const az = pR[2] - pL[2];
  const bx = pU[0] - pD[0];
  const by = pU[1] - pD[1];
  const bz = pU[2] - pD[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  return [nx / len, ny / len, nz / len];
}

/**
 * Surface class of a cell (§4.11 v2): `0` sky | `1` ground | `2` wall.
 * Sky if `dC ≥ 0.98·far`, else ground when `up > UP_K` (`up = |dot(n,
 * viewUp)|`), wall otherwise.
 */
export function surfaceClass(dC: number, far: number, up: number): 0 | 1 | 2 {
  if (dC >= 0.98 * far) return 0;
  return up > UP_K ? 1 : 2;
}

/** Sky-tangle density (§4.11 v2 `skyDensity`): `mix(0.60, 0.30, daylight)`. */
export function skyDensity(daylight: number): number {
  return mix(0.6, 0.3, daylight);
}

/**
 * Far-depth fade for non-sky tone (§4.11): `1 − 0.45·smoothstep(120, 900,
 * d)` — far blocks sketch lighter.
 */
export function depthFade(d: number): number {
  return 1 - 0.45 * smoothstep(120, 900, d);
}

/**
 * Ink coverage of the surface strokes at continuous position `u` across,
 * `along` down a stroke, for a tone in `[0, 1]` (§4.11 `strokeInk`). The
 * three {@link SCRIBBLE_LAYERS} are coarse-to-fine families of long wobbly
 * lines; each layer draws only where `tone` exceeds its threshold. Returns
 * coverage in `[0, 1]`.
 */
export function strokeInk(u: number, along: number, tone: number): number {
  let ink = 0;
  for (let k = 0; k < SCRIBBLE_LAYERS.length; k++) {
    const { spacing: S, threshold: t } = SCRIBBLE_LAYERS[k];
    if (tone <= t) continue;
    const idx = Math.floor(u / S);
    const ph = hash2(idx, k) * (2 * Math.PI);
    const jit = (hash2(idx, k + 7) - 0.5) * 0.5 * S;
    const wob = 0.5 * Math.sin(along * 0.16 + ph) + 0.25 * Math.sin(along * 0.043 + 2 * ph);
    const centre = (idx + 0.5) * S + jit + wob;
    const lift = hash2(idx, Math.floor(along / 24) + 3 * k + 40) < 0.12;
    if (lift) continue;
    const hw = 0.28 + 0.22 * tone;
    const cov = 1 - smoothstep(hw - 0.15, hw + 0.15, Math.abs(u - centre));
    ink = Math.max(ink, cov);
  }
  return ink;
}

/**
 * Ink coverage of the loose sky tangle at sky pixel position `(px, py)`
 * (§4.11 `tangleInk`). Three wavy families at fixed angles, each line
 * present with probability `density`; the near-vertical one is dominant
 * (family 0 spacing 2.5 cells, v2). Returns coverage in `[0, 1]`.
 */
export function tangleInk(px: number, py: number, density: number): number {
  const ANGLES: readonly number[] = [0.12, 1.25, 2.3];
  const SPACINGS: readonly number[] = [2.5, 9, 7];
  let ink = 0;
  for (let j = 0; j < 3; j++) {
    const th = ANGLES[j];
    const S = SPACINGS[j];
    const u = px * Math.cos(th) + py * Math.sin(th);
    const along = -px * Math.sin(th) + py * Math.cos(th);
    const idx = Math.floor(u / S);
    if (hash2(idx, 20 + j) > density) continue;
    const ph = hash2(idx, 30 + j) * (2 * Math.PI);
    const wob = 2.0 * Math.sin(along * 0.09 + ph) + 1.2 * Math.sin(along * 0.31 + 2 * ph);
    const cov = 1 - smoothstep(0.15, 0.45, Math.abs(u - (idx + 0.5) * S - wob));
    ink = Math.max(ink, cov);
  }
  return ink;
}

/**
 * One-sided outline gate (§4.11): true when the cell is a depth
 * discontinuity (`isEdge`, term for term) AND the nearer side of it
 * (`isNearSide` for at least one of the four neighbours `[dL, dR, dU, dD]`).
 * Such cells are fully inked in the surface ink colour; sky cells never
 * carry an outline.
 */
export function surfaceOutline(
  dC: number,
  neighbours: readonly [number, number, number, number],
  far: number,
): boolean {
  if (!isEdge(dC, neighbours, far)) return false;
  const skyThr = 0.98 * far;
  return (
    isNearSide(dC, neighbours[0], skyThr) ||
    isNearSide(dC, neighbours[1], skyThr) ||
    isNearSide(dC, neighbours[2], skyThr) ||
    isNearSide(dC, neighbours[3], skyThr)
  );
}

/**
 * Surface ink colour for a full-brightness tint (§4.11 v2 `inkColour`):
 * `mix(INK, tint · 0.50, 0.85·satF)` where
 * `satF = smoothstep(0.10, 0.45, sat)` — grey things get neutral black ink,
 * red things red ink.
 */
export function inkColour(tint: readonly [number, number, number]): readonly [number, number, number] {
  const sat = Math.max(tint[0], tint[1], tint[2]) - Math.min(tint[0], tint[1], tint[2]);
  const satF = smoothstep(0.1, 0.45, sat);
  return [
    mix(INK[0], tint[0] * 0.5, 0.85 * satF),
    mix(INK[1], tint[1] * 0.5, 0.85 * satF),
    mix(INK[2], tint[2] * 0.5, 0.85 * satF),
  ];
}

/**
 * Pale flat wash colour under the strokes (§4.11 v2 `washColour`):
 * `mix(PAPER, tint, 0.14·satF·min(1, tone·1.5))` — a light tint so most of
 * the paper stays white.
 */
export function washColour(
  tint: readonly [number, number, number],
  tone: number,
): readonly [number, number, number] {
  const sat = Math.max(tint[0], tint[1], tint[2]) - Math.min(tint[0], tint[1], tint[2]);
  const satF = smoothstep(0.1, 0.45, sat);
  const f = 0.14 * satF * Math.min(1, tone * 1.5);
  return [mix(PAPER[0], tint[0], f), mix(PAPER[1], tint[1], f), mix(PAPER[2], tint[2], f)];
}

/**
 * §4.11 "scribble" fragment. Strokes are drawn per pixel in continuous cell
 * space `p = vUv · grid`; the scene sample, depth taps and class are per
 * cell `cell = floor(p)`. The depth taps are ONE CELL apart at texel centres
 * (exactly as `lowpoly` v2), CLAMPED so the bottom/edge rows get a real
 * one-sided normal. Ground/wall is classified from the **view-space normal**
 * (`viewPos`/`viewNormal`, `up = |dot(n, viewUp)| > UP_K` — v2), so walls
 * stay vertical strokes even when the camera looks up. A loose tangle covers
 * the sky, and one-sided pencil outlines (`isEdge` + `isNearSide`) ink depth
 * discontinuities. `daylight` is the only style uniform (drives the sky
 * tangle density); `viewUp` and `tanHalfFov` come from the prelude. GLSL ES
 * 1.0 unrolls the constant-bound layer loops, so the three stroke layers and
 * three tangle families are written out as literal blocks.
 */
const SCRIBBLE_FRAGMENT = `
uniform float daylight;
const float UP_K = 0.6;
const vec3 PAPER = vec3(0.98, 0.97, 0.94);
const vec3 INK = vec3(0.12, 0.10, 0.12);
const vec3 SKY_INK = vec3(0.15, 0.14, 0.18);

float hash2(float a, float b) {
  return fract(sin(a * 12.9898 + b * 78.233) * 43758.5453);
}

float depthFade(float d) {
  return 1.0 - 0.45 * smoothstep(120.0, 900.0, d);
}

vec3 viewPos(vec2 uv, float d, float thf, float asp) {
  return vec3((uv.x * 2.0 - 1.0) * thf * asp * d, (uv.y * 2.0 - 1.0) * thf * d, -d);
}

vec3 viewNormal(vec2 uvL, vec2 uvR, vec2 uvU, vec2 uvD, float dL, float dR, float dU, float dD, float thf, float asp) {
  vec3 a = viewPos(uvR, dR, thf, asp) - viewPos(uvL, dL, thf, asp);
  vec3 b = viewPos(uvU, dU, thf, asp) - viewPos(uvD, dD, thf, asp);
  return normalize(cross(a, b));
}

float strokeInk(float u, float along, float tone) {
  float ink = 0.0;
  if (tone > 0.10) {
    float S = 8.0;
    float idx = floor(u / S);
    float ph = hash2(idx, 0.0) * 6.2832;
    float jit = (hash2(idx, 7.0) - 0.5) * 0.5 * S;
    float wob = 0.50 * sin(along * 0.16 + ph) + 0.25 * sin(along * 0.043 + 2.0 * ph);
    float centre = (idx + 0.5) * S + jit + wob;
    if (hash2(idx, floor(along / 24.0) + 40.0) >= 0.12) {
      float hw = 0.28 + 0.22 * tone;
      float cov = 1.0 - smoothstep(hw - 0.15, hw + 0.15, abs(u - centre));
      ink = max(ink, cov);
    }
  }
  if (tone > 0.40) {
    float S = 4.0;
    float idx = floor(u / S);
    float ph = hash2(idx, 1.0) * 6.2832;
    float jit = (hash2(idx, 8.0) - 0.5) * 0.5 * S;
    float wob = 0.50 * sin(along * 0.16 + ph) + 0.25 * sin(along * 0.043 + 2.0 * ph);
    float centre = (idx + 0.5) * S + jit + wob;
    if (hash2(idx, floor(along / 24.0) + 43.0) >= 0.12) {
      float hw = 0.28 + 0.22 * tone;
      float cov = 1.0 - smoothstep(hw - 0.15, hw + 0.15, abs(u - centre));
      ink = max(ink, cov);
    }
  }
  if (tone > 0.70) {
    float S = 2.0;
    float idx = floor(u / S);
    float ph = hash2(idx, 2.0) * 6.2832;
    float jit = (hash2(idx, 9.0) - 0.5) * 0.5 * S;
    float wob = 0.50 * sin(along * 0.16 + ph) + 0.25 * sin(along * 0.043 + 2.0 * ph);
    float centre = (idx + 0.5) * S + jit + wob;
    if (hash2(idx, floor(along / 24.0) + 46.0) >= 0.12) {
      float hw = 0.28 + 0.22 * tone;
      float cov = 1.0 - smoothstep(hw - 0.15, hw + 0.15, abs(u - centre));
      ink = max(ink, cov);
    }
  }
  return ink;
}

float tangleInk(float px, float py, float density) {
  float ink = 0.0;
  {
    float th = 0.12;
    float S = 2.5;
    float u = px * cos(th) + py * sin(th);
    float along = -px * sin(th) + py * cos(th);
    float idx = floor(u / S);
    if (hash2(idx, 20.0) <= density) {
      float ph = hash2(idx, 30.0) * 6.2832;
      float wob = 2.0 * sin(along * 0.09 + ph) + 1.2 * sin(along * 0.31 + 2.0 * ph);
      float cov = 1.0 - smoothstep(0.15, 0.45, abs(u - (idx + 0.5) * S - wob));
      ink = max(ink, cov);
    }
  }
  {
    float th = 1.25;
    float S = 9.0;
    float u = px * cos(th) + py * sin(th);
    float along = -px * sin(th) + py * cos(th);
    float idx = floor(u / S);
    if (hash2(idx, 21.0) <= density) {
      float ph = hash2(idx, 31.0) * 6.2832;
      float wob = 2.0 * sin(along * 0.09 + ph) + 1.2 * sin(along * 0.31 + 2.0 * ph);
      float cov = 1.0 - smoothstep(0.15, 0.45, abs(u - (idx + 0.5) * S - wob));
      ink = max(ink, cov);
    }
  }
  {
    float th = 2.30;
    float S = 7.0;
    float u = px * cos(th) + py * sin(th);
    float along = -px * sin(th) + py * cos(th);
    float idx = floor(u / S);
    if (hash2(idx, 22.0) <= density) {
      float ph = hash2(idx, 32.0) * 6.2832;
      float wob = 2.0 * sin(along * 0.09 + ph) + 1.2 * sin(along * 0.31 + 2.0 * ph);
      float cov = 1.0 - smoothstep(0.15, 0.45, abs(u - (idx + 0.5) * S - wob));
      ink = max(ink, cov);
    }
  }
  return ink;
}

void main() {
  vec2 p = vUv * grid;
  vec2 cell = floor(p);

  vec3 c = sampleSub(cell, 0.0, 0.0);
  float v = shaped(bright(c));
  float tone = 1.0 - v;
  vec3 tint = tintOf(c);
  float sat = max(max(tint.r, tint.g), tint.b) - min(min(tint.r, tint.g), tint.b);
  float satF = smoothstep(0.10, 0.45, sat);

  // Depth taps ONE CELL apart at texel centres (exactly as lowpoly v2),
  // CLAMPED to [0.5·texel, 1 − 0.5·texel] so the bottom/edge rows get a real
  // one-sided normal instead of an off-texture sample.
  vec2 texel = 1.0 / sceneSize;
  vec2 centreUv = (cell * sub + 0.5) * texel;
  vec2 stepUv = sub * texel;
  vec2 lo = 0.5 * texel;
  vec2 hi = 1.0 - 0.5 * texel;
  vec2 uvL = clamp(centreUv - vec2(stepUv.x, 0.0), lo, hi);
  vec2 uvR = clamp(centreUv + vec2(stepUv.x, 0.0), lo, hi);
  vec2 uvU = clamp(centreUv + vec2(0.0, stepUv.y), lo, hi);
  vec2 uvD = clamp(centreUv - vec2(0.0, stepUv.y), lo, hi);
  float dC = linearDepth(centreUv);
  float dL = linearDepth(uvL);
  float dR = linearDepth(uvR);
  float dU = linearDepth(uvU);
  float dD = linearDepth(uvD);

  float skyThr = 0.98 * cameraFar;

  // Sky: a loose ink tangle whose density falls with daylight.
  if (dC >= skyThr) {
    float density = mix(0.60, 0.30, daylight);
    float tang = tangleInk(p.x, p.y, density);
    gl_FragColor = vec4(mix(PAPER, SKY_INK, tang * 0.85), 1.0);
    return;
  }

  // Surface class by NORMAL (v2): up = |dot(n, viewUp)| — 1 for a floor/
  // roof, 0 for a wall, independent of camera pitch. Ground strokes stay
  // horizontal, wall strokes vertical.
  float aspect = sceneSize.x / sceneSize.y;
  vec3 n = viewNormal(uvL, uvR, uvU, uvD, dL, dR, dU, dD, tanHalfFov, aspect);
  float up = abs(dot(n, viewUp));

  float tone2 = tone * depthFade(dC);
  float u = (up > UP_K) ? p.y : p.x;
  float along = (up > UP_K) ? p.x : p.y;
  float ink = strokeInk(u, along, tone2);

  // One-sided pencil outline: a depth discontinuity whose nearer side this
  // cell is (isEdge AND isNearSide) inks the whole cell.
  float wC = 1.0 / dC;
  float wL = 1.0 / dL;
  float wR = 1.0 / dR;
  float wU = 1.0 / dU;
  float wD = 1.0 / dD;
  bool skyL = dL >= skyThr;
  bool skyR = dR >= skyThr;
  bool skyU = dU >= skyThr;
  bool skyD = dD >= skyThr;
  bool jump = skyL || skyR || skyU || skyD;
  bool crease = (abs(wL + wR - 2.0 * wC) > 0.02 * wC) ||
                (abs(wU + wD - 2.0 * wC) > 0.02 * wC);
  bool nearSide = (dL > dC || (skyL && dC < skyThr)) ||
                  (dR > dC || (skyR && dC < skyThr)) ||
                  (dU > dC || (skyU && dC < skyThr)) ||
                  (dD > dC || (skyD && dC < skyThr));
  if ((jump || crease) && nearSide) ink = 1.0;

  vec3 inkCol = mix(INK, tint * 0.50, 0.85 * satF);
  vec3 washCol = mix(PAPER, tint, 0.14 * satF * min(1.0, tone2 * 1.5));
  gl_FragColor = vec4(mix(washCol, inkCol, ink), 1.0);
}
`;

/**
 * Coloured-ink scribble sketch on white paper — tone by stroke density,
 * long wobbly pen strokes following the surface (classed by view-space
 * normal, v2), loose sky tangle, one-sided pencil outlines, far buildings
 * sketched lighter. Cell 3×3, sub 1×1, depth. `R` cycles,
 * `?render=scribble`.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'scribble',
    label: 'SCRIBBLE',
    cellW: 3,
    cellH: 3,
    subX: 1,
    subY: 1,
    needsDepth: true,
    groundGrid: false,
    fragment: SCRIBBLE_FRAGMENT,
    makeUniforms(ctx: StyleContext): Record<string, THREE.IUniform> {
      return {
        daylight: { value: ctx.daylight },
      };
    },
    update(
      uniforms: Record<string, THREE.IUniform>,
      _timeS: number,
      ctx: StyleContext,
    ): void {
      uniforms.daylight.value = ctx.daylight;
    },
  },
];
