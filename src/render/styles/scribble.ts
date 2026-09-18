/**
 * `scribble` render style (docs/architecture.md §4.11, wave 17 T-0134, v2
 * T-0136, v3 T-0137): a coloured-ink scribble sketch on white paper — tone
 * carried by stroke *density*, long wobbly pen strokes that follow the
 * surface (vertical world-lines on walls, constant-depth on the ground, a
 * loose tangle on the sky dome), ink coloured by the object under it,
 * one-sided pencil outlines, far buildings sketched lighter. Cell 3×3, sub
 * 1×1, `needsDepth: true`, `groundGrid: false`. Strokes are drawn
 * **analytically per canvas pixel** from the world position
 * (`P = viewPos(vUv, dC, …)`, `W = viewToWorld · P`) so they stick to the
 * world; a nested power-of-two LOD keeps on-screen spacing constant. Only
 * the scene sample, the depth taps, the class and the outline are per cell
 * (`cell = floor(vUv · grid)`). Pure helpers (`SCRIBBLE_LAYERS`, `UP_K`,
 * `PAPER`, `INK`, `SKY_INK`, `hash2`, `viewPos`, `viewNormal`,
 * `surfaceClass`, `skyDensity`, `depthFade`, `strokeCoords`, `strokeScale`,
 * `lodOf`, `nestedStrokeInk`, `skyCoords`, `tangleInk`, `surfaceOutline`,
 * `inkColour`, `washColour`) mirror the shader term for term and are
 * unit-tested in node. v3 (T-0137) replaces the screen-space `strokeInk`
 * overlay with world-anchored nested LOD and sticks the sky tangle to the
 * dome; the v3.1 rework scales strokes from the screen gradient of `u`
 * (`strokeScale`) and maps the sky stereographically from the nadir.
 * Colour, outline, tone, thresholds, half-widths, lifts and the ground/wall
 * class rule stay as v2.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { isEdge } from './edges';
import { isNearSide } from './quest';

/** GLSL `fract(x)`: fractional part, in `[0, 1)` even for negative x. */
function fract(x: number): number {
  return x - Math.floor(x);
}

/** GLSL `mod(x, y) = x − y·floor(x/y)`. */
function mod(x: number, y: number): number {
  return x - y * Math.floor(x / y);
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

/**
 * Precision-safe hash in `[0, 1)` for |a|, |b| up to 1e5 (§4.11 v3).
 */
export function hash2(a: number, b: number): number {
  let px = fract(a * 0.1031);
  let py = fract(b * 0.1030);
  let pz = fract(a * 0.0973);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d;
  py += d;
  pz += d;
  return fract((px + py) * pz);
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
 * v3 derives world spacing from the nested LOD (`S = 2^(L−k)`); the
 * `spacing` field is the v1/v2 screen-space leftover and is unused.
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
 * Stroke coordinates in metres (§4.11 v3 `strokeCoords`): wall
 * `t = normalize(cross((0,1,0), nW))`, `u = W·t`, `along = W.y`; ground
 * `u = dC`, `along = W.x + W.z`.
 */
export function strokeCoords(
  W: readonly [number, number, number],
  nW: readonly [number, number, number],
  dC: number,
  up: number,
): { u: number; along: number } {
  if (up > UP_K) return { u: dC, along: W[0] + W[2] };
  const tx = nW[2];
  const tz = -nW[0];
  const len = Math.hypot(tx, tz);
  return { u: (W[0] * tx + W[2] * tz) / len, along: W[1] };
}

/**
 * Screen-space stroke scale from the four neighbour taps (§4.11 v3
 * `strokeScale`): `{ mu, ma }` metres of `u` / `along` per screen cell.
 * Wall uses the L/R pair of `u` and the U/D pair of `along`; ground uses
 * the U/D pair of `u` and the L/R pair of `along`. Each is floored at
 * `1e−4` so a degenerate (constant) tap never blows the LOD.
 */
export function strokeScale(
  uN: { L: number; R: number; U: number; D: number },
  alongN: { L: number; R: number; U: number; D: number },
  up: number,
): { mu: number; ma: number } {
  if (up > UP_K) {
    return {
      mu: Math.max(Math.abs(uN.U - uN.D) / 2, 1e-4),
      ma: Math.max(Math.abs(alongN.R - alongN.L) / 2, 1e-4),
    };
  }
  return {
    mu: Math.max(Math.abs(uN.R - uN.L) / 2, 1e-4),
    ma: Math.max(Math.abs(alongN.U - alongN.D) / 2, 1e-4),
  };
}

/**
 * Nested LOD for metres-of-`u`-per-cell `mu` (§4.11 v3): `lod = log2(8·mu)`,
 * `L = floor(lod)`, `f = fract(lod)`. Level `L` is 8 cells apart on screen.
 */
export function lodOf(mu: number): { L: number; f: number } {
  const lod = Math.log2(8 * mu);
  const L = Math.floor(lod);
  return { L, f: lod - L };
}

/**
 * World-anchored nested-LOD stroke coverage in `[0, 1]` (§4.11 v3
 * `nestedStrokeInk`). Level `j = L − k` has lines at `u = i·2^j` m; odd
 * lines fade with `1 − f` so the family never pops across a LOD boundary.
 * Each level takes the max over the nearest line and its neighbours
 * (`i0 ± 2`): stroke width + wobble can cover more than the nearest, and
 * a faded odd line must fall back to the even neighbour or the LOD
 * transition pops. `mu` / `ma` are metres of `u` / `along` per screen cell
 * from {@link strokeScale}; they replace a single facing-camera `m`.
 */
export function nestedStrokeInk(
  u: number,
  along: number,
  tone: number,
  mu: number,
  ma: number,
): number {
  const { L, f } = lodOf(mu);
  let ink = 0;
  for (let k = 0; k < SCRIBBLE_LAYERS.length; k++) {
    if (tone <= SCRIBBLE_LAYERS[k].threshold) continue;
    const j = L - k;
    const S = 2 ** j;
    const i0 = Math.floor(u / S + 0.5);
    const hw = mu * (0.28 + 0.22 * tone);
    for (let di = -2; di <= 2; di++) {
      const i = i0 + di;
      const key = i * S;
      const ph = hash2(key, 0) * 6.2832;
      const wob =
        mu *
        (0.5 * Math.sin((along / ma) * 0.16 + ph) +
          0.25 * Math.sin((along / ma) * 0.043 + 2 * ph));
      const lift = hash2(key, Math.floor(along / (24 * ma)) + 40) < 0.12;
      if (lift) continue;
      const cov = 1 - smoothstep(hw - 0.15 * mu, hw + 0.15 * mu, Math.abs(u - key - wob));
      const weight = mod(i, 2) === 1 ? 1 - f : 1;
      ink = Math.max(ink, cov * weight);
    }
  }
  return ink;
}

/**
 * Sky-dome coordinates in cells (§4.11 v3 `skyCoords`): stereographic
 * projection from the nadir, `K · (dirW.x, dirW.z) / (1 + dirW.y)`. The
 * only pole is straight down (never sky); there is no azimuthal seam.
 */
export function skyCoords(dirW: readonly [number, number, number], K: number): [number, number] {
  const den = 1 + dirW[1];
  return [(K * dirW[0]) / den, (K * dirW[2]) / den];
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
    const ph = hash2(idx, 30 + j) * 6.2832;
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
 * §4.11 "scribble" v3 fragment. Scene sample, depth taps, class and outline
 * are per cell (`cell = floor(vUv · grid)`). Strokes are per pixel: world
 * position `W` from `viewPos(vUv, dC)` (continuous `vUv`, cell depth) via
 * `viewToWorld`, nested-LOD ink in metres scaled by the screen gradient of
 * `u` (`mu`/`ma` from the four neighbour taps). Sky tangle uses
 * stereographic-from-nadir dome coordinates so it pans with the camera
 * without a zenith pole. Ground/wall is classified from the view-space
 * normal (`up = |dot(n, viewUp)| > UP_K`). `daylight` is the only style
 * uniform; `viewUp`, `tanHalfFov` and `viewToWorld` come from the prelude
 * and are never redeclared. GLSL ES 1.0: the three nested layers are an
 * `if` ladder; `exp2`/`log2`/`mod` are ES 1.0.
 */
const SCRIBBLE_FRAGMENT = `
uniform float daylight;
const float UP_K = 0.6;
const vec3 PAPER = vec3(0.98, 0.97, 0.94);
const vec3 INK = vec3(0.12, 0.10, 0.12);
const vec3 SKY_INK = vec3(0.15, 0.14, 0.18);

float hash2(float a, float b) {
  vec3 p = fract(vec3(a, b, a) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
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

vec2 strokeCoords(vec3 W, vec3 nW, float d, float up) {
  if (up > UP_K) return vec2(d, W.x + W.z);
  vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), nW));
  return vec2(dot(W, t), W.y);
}

vec2 strokeScale(vec2 scL, vec2 scR, vec2 scU, vec2 scD, float up) {
  if (up > UP_K) {
    return vec2(max(abs(scU.x - scD.x) * 0.5, 1e-4), max(abs(scR.y - scL.y) * 0.5, 1e-4));
  }
  return vec2(max(abs(scR.x - scL.x) * 0.5, 1e-4), max(abs(scU.y - scD.y) * 0.5, 1e-4));
}

float strokeLayer(float u, float along, float tone, float mu, float ma, float j, float f) {
  float S = exp2(j);
  float i0 = floor(u / S + 0.5);
  float hw = mu * (0.28 + 0.22 * tone);
  float ink = 0.0;
  for (int di = -2; di <= 2; di++) {
    float i = i0 + float(di);
    float key = i * S;
    float ph = hash2(key, 0.0) * 6.2832;
    float wob = mu * (0.50 * sin(along / ma * 0.16 + ph) + 0.25 * sin(along / ma * 0.043 + 2.0 * ph));
    if (hash2(key, floor(along / (24.0 * ma)) + 40.0) >= 0.12) {
      float cov = 1.0 - smoothstep(hw - 0.15 * mu, hw + 0.15 * mu, abs(u - key - wob));
      float weight = (mod(abs(i), 2.0) > 0.5) ? (1.0 - f) : 1.0;
      ink = max(ink, cov * weight);
    }
  }
  return ink;
}

float nestedStrokeInk(float u, float along, float tone, float mu, float ma) {
  float ink = 0.0;
  float lod = log2(8.0 * mu);
  float L = floor(lod);
  float f = fract(lod);
  if (tone > 0.10) ink = max(ink, strokeLayer(u, along, tone, mu, ma, L - 0.0, f));
  if (tone > 0.40) ink = max(ink, strokeLayer(u, along, tone, mu, ma, L - 1.0, f));
  if (tone > 0.70) ink = max(ink, strokeLayer(u, along, tone, mu, ma, L - 2.0, f));
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
  float aspect = sceneSize.x / sceneSize.y;

  // Sky: a loose ink tangle on the dome (v3) whose density falls with daylight.
  if (dC >= skyThr) {
    float density = mix(0.60, 0.30, daylight);
    vec3 dirW = normalize(mat3(viewToWorld) * viewPos(vUv, 1.0, tanHalfFov, aspect));
    float K = sceneSize.y / (2.0 * atan(tanHalfFov));
    vec2 ps = K * vec2(dirW.x, dirW.z) / (1.0 + dirW.y);
    float tang = tangleInk(ps.x, ps.y, density);
    gl_FragColor = vec4(mix(PAPER, SKY_INK, tang * 0.85), 1.0);
    return;
  }

  // Surface class by NORMAL (v2): up = |dot(n, viewUp)| — 1 for a floor/
  // roof, 0 for a wall, independent of camera pitch.
  vec3 n = viewNormal(uvL, uvR, uvU, uvD, dL, dR, dU, dD, tanHalfFov, aspect);
  float up = abs(dot(n, viewUp));

  float tone2 = tone * depthFade(dC);

  // World-anchored strokes (v3): per-pixel viewPos at the cell depth, then
  // viewToWorld. Stroke scale is the screen gradient of u (mu/ma from the
  // four neighbour taps) so oblique facades and the ground keep ~8/4/2
  // cells of on-screen spacing.
  vec3 P = viewPos(vUv, dC, tanHalfFov, aspect);
  vec3 W = (viewToWorld * vec4(P, 1.0)).xyz;
  vec3 nW = normalize(mat3(viewToWorld) * n);
  // Reconstruct a per-pixel depth from the one-cell taps so ground u
  // (metres of depth) varies inside the cell. The depth target is 1 sample
  // per cell, so linearDepth(vUv) equals dC everywhere inside it.
  vec2 o = p - (cell + 0.5);
  float gX = 0.5 * (dR - dL);
  float gY = 0.5 * (dU - dD);
  if (abs(dR - dC) > 0.35 * dC || abs(dL - dC) > 0.35 * dC) gX = 0.0;
  if (abs(dU - dC) > 0.35 * dC || abs(dD - dC) > 0.35 * dC) gY = 0.0;
  float dPix = dC + gX * o.x + gY * o.y;
  vec2 sc = strokeCoords(W, nW, dPix, up);
  float u = sc.x;
  float along = sc.y;
  vec2 scL = strokeCoords((viewToWorld * vec4(viewPos(uvL, dL, tanHalfFov, aspect), 1.0)).xyz, nW, dL, up);
  vec2 scR = strokeCoords((viewToWorld * vec4(viewPos(uvR, dR, tanHalfFov, aspect), 1.0)).xyz, nW, dR, up);
  vec2 scU = strokeCoords((viewToWorld * vec4(viewPos(uvU, dU, tanHalfFov, aspect), 1.0)).xyz, nW, dU, up);
  vec2 scD = strokeCoords((viewToWorld * vec4(viewPos(uvD, dD, tanHalfFov, aspect), 1.0)).xyz, nW, dD, up);
  vec2 scale = strokeScale(scL, scR, scU, scD, up);
  float ink = nestedStrokeInk(u, along, tone2, scale.x, scale.y);

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
 * world-anchored nested-LOD pen strokes (v3) scaled by the screen gradient
 * of `u`, following the surface (classed by view-space normal, v2),
 * stereographic sky-dome tangle, one-sided pencil outlines, far buildings
 * sketched lighter. Cell 3×3, sub 1×1, depth. `R` cycles, `?render=scribble`.
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
