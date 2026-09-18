/**
 * `scribble` render style (docs/architecture.md §4.11, wave 17 T-0134, v2
 * T-0136, v3 T-0137, v4 T-0138): a coloured-ink scribble sketch on white
 * paper — tone carried by stroke *density*, long wobbly pen strokes that
 * follow the surface (vertical world-lines on walls, constant-depth on the
 * ground, short hair strokes on the sky dome), ink coloured by the object
 * under it, one-sided pencil outlines, far buildings sketched lighter.
 * Cell 3×3, sub 1×1, `needsDepth: true`, `groundGrid: false`. Strokes are
 * drawn **analytically per canvas pixel** from the world position
 * (`P = viewPos(vUv, dPix, …)`, `W = viewToWorld · P`) so they stick to the
 * world; a nested power-of-two LOD keeps on-screen spacing constant. Only
 * the scene sample, the depth taps, the class and the outline are per cell
 * (`cell = floor(vUv · grid)`). Pure helpers (`SCRIBBLE_LAYERS`, `UP_K`,
 * `PAPER`, `INK`, `SKY_INK`, `hash2`, `viewPos`, `viewNormal`,
 * `surfaceClass`, `skyDensity`, `depthFade`, `strokeCoords`, `strokeScale`,
 * `lodOf`, `nestedStrokeInk`, `wobble`, `vnoise1`, `lifted`, `skyCoords`,
 * `hairInk`, `hairDir`, `surfaceOutline`, `inkColour`, `washColour`) mirror
 * the shader term for term and are unit-tested in node. v4 (T-0138) feeds
 * per-pixel depth into the wall position, puts wobble and lifts in world
 * metres with screen-size fades (hand tremor is per-line value noise, not
 * a sine), soft-switches layers, widens the stroke core, and replaces the
 * sky tangle with short hair strokes. Stroke core is
 * `hw = mu·(0.30 + 0.20·tone)` with AA ±0.15·mu; sky mix is 0.85.
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

/** The sky hair-stroke ink (§4.11), a dim violet-grey. */
export const SKY_INK: readonly [number, number, number] = [0.15, 0.14, 0.18];

/** Ground/wall cut on `up = |dot(n, viewUp)|` (§4.11 v2): ground if `up > UP_K`. */
export const UP_K = 0.6;

/**
 * The three surface stroke layers, coarse to fine (§4.11):
 * `{ spacing, threshold }` — a layer only draws where `tone` crosses
 * `threshold` (v4: soft `smoothstep(t−0.08, t+0.08, tone)`).
 * v3 derives world spacing from the nested LOD (`S = 2^(L−k)`); the
 * `spacing` field is the v1/v2 screen-space leftover and is unused.
 */
export const SCRIBBLE_LAYERS: readonly { spacing: number; threshold: number }[] = [
  { spacing: 8, threshold: 0.1 },
  { spacing: 4, threshold: 0.4 },
  { spacing: 2, threshold: 0.7 },
];

/** Wobble octave periods in metres (§4.11 v4). */
const WOBBLE_P: readonly [number, number, number] = [0.9, 3.5, 14];
/** Wobble octave amplitudes (§4.11 v4, value-noise tremor). */
const WOBBLE_A: readonly [number, number, number] = [0.6, 0.4, 0.4];
/** Pen-lift gap lengths in metres (§4.11 v4). */
const LIFT_G: readonly [number, number, number] = [1.5, 6, 24];
/** Sky-hair cell size in cells (§4.11 v4). */
const HAIR_H = 8;

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

/** Sky-hair density (§4.11 v4 `skyDensity`): `mix(0.75, 0.45, daylight)`. */
export function skyDensity(daylight: number): number {
  return mix(0.75, 0.45, daylight);
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
 * Screen-size visibility of a world-metre period (§4.11 v4 `vis`): an
 * octave shows once its period spans ≥ 3 cells, fully by 8 cells.
 */
function vis(period: number, ma: number): number {
  return smoothstep(3, 8, period / ma);
}

/**
 * 1-D value noise in `[0, 1]` (§4.11 v4 `vnoise1`): interpolates
 * `hash2(floor(x), key)` → `hash2(floor(x)+1, key)` with a Hermite
 * `smoothstep` on `fract(x)`. The hand-tremor wobble is this, not a sine.
 */
export function vnoise1(x: number, key: number): number {
  const i = Math.floor(x);
  return mix(hash2(i, key), hash2(i + 1, key), smoothstep(0, 1, fract(x)));
}

/**
 * World-metre stroke wobble (§4.11 v4 `wobble`): three octaves at 0.9 /
 * 3.5 / 14 m of per-line value noise, faded by screen size so `ma` never
 * enters a phase. `key` is the line's world coordinate (the same `i·S`
 * nested LOD uses) so adjacent strokes do not corrugate in step.
 */
export function wobble(
  along: number,
  ph: number,
  mu: number,
  ma: number,
  key: number,
): number {
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const P = WOBBLE_P[k];
    const n = vnoise1(along / P + 3 * ph, key + 11 * k);
    sum += WOBBLE_A[k] * (2 * n - 1) * vis(P, ma);
  }
  return mu * sum;
}

/**
 * Pen-lift gate (§4.11 v4 `lifted`): true when any visible gap octave
 * (1.5 / 6 / 24 m) hashes below 0.06. `ma` never enters a segment index.
 */
export function lifted(key: number, along: number, ma: number): boolean {
  for (let k = 0; k < 3; k++) {
    const G = LIFT_G[k];
    if (vis(G, ma) > 0.5 && hash2(key, Math.floor(along / G) + 40 + k) < 0.06) {
      return true;
    }
  }
  return false;
}

/**
 * World-anchored nested-LOD stroke coverage in `[0, 1]` (§4.11 v3/v4
 * `nestedStrokeInk`). Level `j = L − k` has lines at `u = i·2^j` m; odd
 * lines fade with `1 − f` so the family never pops across a LOD boundary.
 * Each level takes the max over the nearest line and its neighbours
 * (`i0 ± 2`): stroke width + wobble can cover more than the nearest, and
 * a faded odd line must fall back to the even neighbour or the LOD
 * transition pops. v4: wobble/lifts in world metres ({@link wobble},
 * {@link lifted}), soft layer switching, wider stroke core with a tight
 * edge (`hw = mu·(0.30 + 0.20·tone)`, AA ±0.15·mu). `mu` / `ma` are
 * metres of `u` / `along` per screen cell from {@link strokeScale}.
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
    const tK = SCRIBBLE_LAYERS[k].threshold;
    const layerW = smoothstep(tK - 0.08, tK + 0.08, tone);
    if (layerW <= 0) continue;
    const j = L - k;
    const S = 2 ** j;
    const i0 = Math.floor(u / S + 0.5);
    const hw = mu * (0.30 + 0.20 * tone);
    for (let di = -2; di <= 2; di++) {
      const i = i0 + di;
      const key = i * S;
      const ph = hash2(key, 0) * 6.2832;
      if (lifted(key, along, ma)) continue;
      const wob = wobble(along, ph, mu, ma, key);
      const cov = 1 - smoothstep(hw - 0.15 * mu, hw + 0.15 * mu, Math.abs(u - key - wob));
      const weight = mod(i, 2) === 1 ? 1 - f : 1;
      ink = Math.max(ink, cov * weight * layerW);
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
 * Hair-stroke parameters for cell `c` and stroke index `s` (§4.11 v4).
 */
function hairParams(
  c: readonly [number, number],
  s: number,
): {
  r1: number;
  centre: [number, number];
  dir: [number, number];
  r5: number;
  r6: number;
} {
  const cid = c[0] * 7 + c[1] * 131 + s * 17;
  const r1 = hash2(cid, 1);
  const r2 = hash2(cid, 2);
  const r3 = hash2(cid, 3);
  const r4 = hash2(cid, 4);
  const r5 = hash2(cid, 5);
  const r6 = hash2(cid, 6);
  const centre: [number, number] = [(c[0] + r2) * HAIR_H, (c[1] + r3) * HAIR_H];
  const clen = Math.hypot(centre[0], centre[1]);
  const rx = clen < 1 ? 0 : -centre[0] / clen;
  const ry = clen < 1 ? 1 : -centre[1] / clen;
  const ang = (r4 - 0.5) * 0.6;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  return {
    r1,
    centre,
    dir: [rx * ca - ry * sa, rx * sa + ry * ca],
    r5,
    r6,
  };
}

/**
 * Direction of sky-hair stroke `s` in cell `c` (§4.11 v4), a unit vector
 * pointing toward the zenith (±17°). Used by the "hair points up" test.
 */
export function hairDir(c: readonly [number, number], s: number): [number, number] {
  return hairParams(c, s).dir;
}

/**
 * Ink coverage of the short sky-hair strokes at dome position `ps`
 * (§4.11 v4 `hairInk`). 3 × 3 cells of size 8 around `floor(ps / H)`, 3
 * strokes each (27 segment evaluations). Length is
 * `H·(0.9 + 2.0·r_5)` (7–23 cells); coverage is thinner
 * (`smoothstep(0.15, 0.40, |s⊥ − bend|)`). Returns coverage in `[0, 1]`.
 */
export function hairInk(ps: readonly [number, number], density: number): number {
  const c0x = Math.floor(ps[0] / HAIR_H);
  const c0y = Math.floor(ps[1] / HAIR_H);
  let ink = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c: [number, number] = [c0x + dx, c0y + dy];
      for (let s = 0; s < 3; s++) {
        const h = hairParams(c, s);
        if (h.r1 > density) continue;
        const len = HAIR_H * (0.9 + 2.0 * h.r5);
        const qx = ps[0] - h.centre[0];
        const qy = ps[1] - h.centre[1];
        const t = qx * h.dir[0] + qy * h.dir[1];
        const sPerp = qx * -h.dir[1] + qy * h.dir[0];
        const tt = Math.min(0.5, Math.max(-0.5, t / len));
        const bend = (h.r6 - 0.5) * 0.25 * HAIR_H * Math.sin(Math.PI * (tt + 0.5));
        const endF = 1 - smoothstep(len / 2 - 2, len / 2, Math.abs(t));
        const cov = (1 - smoothstep(0.15, 0.4, Math.abs(sPerp - bend))) * endF;
        ink = Math.max(ink, cov);
      }
    }
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
 * §4.11 "scribble" v4 fragment. Scene sample, depth taps, class and outline
 * are per cell (`cell = floor(vUv · grid)`). Strokes are per pixel: world
 * position `W` from `viewPos(vUv, dPix)` (continuous `vUv`, reconstructed
 * per-pixel depth) via `viewToWorld`, nested-LOD ink in metres scaled by
 * the screen gradient of `u` (`mu`/`ma` from the four neighbour taps).
 * Wobble and lifts live in world metres with screen-size fades. Sky hair
 * uses stereographic-from-nadir dome coordinates. Ground/wall is classified
 * from the view-space normal (`up = |dot(n, viewUp)| > UP_K`). `daylight`
 * is the only style uniform; `viewUp`, `tanHalfFov` and `viewToWorld` come
 * from the prelude and are never redeclared. GLSL ES 1.0: the three nested
 * layers are an `if` ladder; the hair loop is 3 × 3 × 3 constant-bound;
 * `exp2`/`log2`/`mod` are ES 1.0.
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

float vis(float P, float ma) {
  return smoothstep(3.0, 8.0, P / ma);
}

float vnoise1(float x, float key) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash2(i, key), hash2(i + 1.0, key), smoothstep(0.0, 1.0, f));
}

float wobble(float along, float ph, float mu, float ma, float key) {
  float s = 0.0;
  s += 0.60 * (2.0 * vnoise1(along / 0.9 + 3.0 * ph, key + 0.0) - 1.0) * vis(0.9, ma);
  s += 0.40 * (2.0 * vnoise1(along / 3.5 + 3.0 * ph, key + 11.0) - 1.0) * vis(3.5, ma);
  s += 0.40 * (2.0 * vnoise1(along / 14.0 + 3.0 * ph, key + 22.0) - 1.0) * vis(14.0, ma);
  return mu * s;
}

bool lifted(float key, float along, float ma) {
  return (vis(1.5, ma) > 0.5 && hash2(key, floor(along / 1.5) + 40.0) < 0.06)
      || (vis(6.0, ma) > 0.5 && hash2(key, floor(along / 6.0) + 41.0) < 0.06)
      || (vis(24.0, ma) > 0.5 && hash2(key, floor(along / 24.0) + 42.0) < 0.06);
}

float strokeLayer(float u, float along, float tone, float mu, float ma, float j, float f) {
  float S = exp2(j);
  float i0 = floor(u / S + 0.5);
  float hw = mu * (0.30 + 0.20 * tone);
  float ink = 0.0;
  for (int di = -2; di <= 2; di++) {
    float i = i0 + float(di);
    float key = i * S;
    float ph = hash2(key, 0.0) * 6.2832;
    if (!lifted(key, along, ma)) {
      float wob = wobble(along, ph, mu, ma, key);
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
  float w0 = smoothstep(0.02, 0.18, tone);
  float w1 = smoothstep(0.32, 0.48, tone);
  float w2 = smoothstep(0.62, 0.78, tone);
  if (w0 > 0.0) ink = max(ink, strokeLayer(u, along, tone, mu, ma, L - 0.0, f) * w0);
  if (w1 > 0.0) ink = max(ink, strokeLayer(u, along, tone, mu, ma, L - 1.0, f) * w1);
  if (w2 > 0.0) ink = max(ink, strokeLayer(u, along, tone, mu, ma, L - 2.0, f) * w2);
  return ink;
}

float hairInk(vec2 ps, float density) {
  float H = 8.0;
  vec2 c0 = floor(ps / H);
  float ink = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 c = c0 + vec2(float(dx), float(dy));
      for (int s = 0; s < 3; s++) {
        float cid = c.x * 7.0 + c.y * 131.0 + float(s) * 17.0;
        float r1 = hash2(cid, 1.0);
        if (r1 <= density) {
          float r2 = hash2(cid, 2.0);
          float r3 = hash2(cid, 3.0);
          float r4 = hash2(cid, 4.0);
          float r5 = hash2(cid, 5.0);
          float r6 = hash2(cid, 6.0);
          vec2 centre = (c + vec2(r2, r3)) * H;
          vec2 radial;
          float clen = length(centre);
          if (clen < 1.0) radial = vec2(0.0, 1.0);
          else radial = normalize(-centre);
          float ang = (r4 - 0.5) * 0.6;
          float ca = cos(ang);
          float sa = sin(ang);
          vec2 dir = vec2(radial.x * ca - radial.y * sa, radial.x * sa + radial.y * ca);
          float len = H * (0.9 + 2.0 * r5);
          vec2 q = ps - centre;
          float t = dot(q, dir);
          float sperp = dot(q, vec2(-dir.y, dir.x));
          float tt = clamp(t / len, -0.5, 0.5);
          float bend = (r6 - 0.5) * 0.25 * H * sin(3.14159265 * (tt + 0.5));
          float endF = 1.0 - smoothstep(len * 0.5 - 2.0, len * 0.5, abs(t));
          float cov = (1.0 - smoothstep(0.15, 0.40, abs(sperp - bend))) * endF;
          ink = max(ink, cov);
        }
      }
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

  // Sky: short hair strokes on the dome (v4) whose density falls with daylight.
  if (dC >= skyThr) {
    float density = mix(0.75, 0.45, daylight);
    vec3 dirW = normalize(mat3(viewToWorld) * viewPos(vUv, 1.0, tanHalfFov, aspect));
    float K = sceneSize.y / (2.0 * atan(tanHalfFov));
    vec2 ps = K * vec2(dirW.x, dirW.z) / (1.0 + dirW.y);
    float hair = hairInk(ps, density);
    gl_FragColor = vec4(mix(PAPER, SKY_INK, hair * 0.85), 1.0);
    return;
  }

  // Surface class by NORMAL (v2): up = |dot(n, viewUp)| — 1 for a floor/
  // roof, 0 for a wall, independent of camera pitch.
  vec3 n = viewNormal(uvL, uvR, uvU, uvD, dL, dR, dU, dD, tanHalfFov, aspect);
  float up = abs(dot(n, viewUp));

  float tone2 = tone * depthFade(dC);

  // World-anchored strokes (v4): per-pixel viewPos at reconstructed dPix
  // (walls and ground), then viewToWorld. Stroke scale is the screen
  // gradient of u (mu/ma from the four neighbour taps) so oblique facades
  // and the ground keep ~8/4/2 cells of on-screen spacing. Wobble/lifts
  // live in world metres with screen-size fades.
  vec2 o = p - (cell + 0.5);
  float gX = 0.5 * (dR - dL);
  float gY = 0.5 * (dU - dD);
  if (abs(dR - dC) > 0.35 * dC || abs(dL - dC) > 0.35 * dC) gX = 0.0;
  if (abs(dU - dC) > 0.35 * dC || abs(dD - dC) > 0.35 * dC) gY = 0.0;
  float dPix = dC + gX * o.x + gY * o.y;
  vec3 P = viewPos(vUv, dPix, tanHalfFov, aspect);
  vec3 W = (viewToWorld * vec4(P, 1.0)).xyz;
  vec3 nW = normalize(mat3(viewToWorld) * n);
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
 * per-pixel wall depth and world-metre value-noise wobble/lifts (v4),
 * stereographic sky-dome hair, one-sided pencil outlines, far buildings
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
