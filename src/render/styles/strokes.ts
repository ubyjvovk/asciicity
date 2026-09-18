/**
 * Shared stroke chunk (docs/architecture.md §4.11 "Shared stroke chunk
 * (T-0139)"): the world-anchored stroke machinery extracted, byte-for-byte
 * in behaviour, from `scribble.ts` so the wave-18 sketch family (`pencil`,
 * `crayon`, `pastel`, `watercolor`) can reuse it.
 *
 * `STROKE_GLSL` is a GLSL ES 1.0 chunk a style prepends to its own
 * fragment (`fragment: STROKE_GLSL + SCRIBBLE_FRAGMENT`), which is itself
 * appended to `STYLE_PRELUDE` — the chunk therefore defines only
 * constants, functions, the `Surf` struct and `surfaceAt(vec2 uv)`, and
 * never redeclares prelude uniforms (`tScene`, `tDepth`, `viewUp`,
 * `tanHalfFov`, `viewToWorld`, …). `surfaceAt` computes everything
 * `scribble`'s old `main()` computed before colouring: the five clamped
 * one-cell depth taps, the sky test, the class, the reconstructed per-
 * pixel depth `dPix`, world `W` / `nW`, `strokeCoords` + `strokeScale`,
 * and the one-sided outline test; for sky cells it fills `dirW` / `ps`
 * and zeroes the rest.
 *
 * The TS pure mirrors of the chunk (`UP_K`, `SCRIBBLE_LAYERS`, `hash2`,
 * `viewPos`, `viewNormal`, `strokeCoords`, `strokeScale`, `lodOf`,
 * `vnoise1`, `wobble`, `lifted`, `nestedStrokeInk`, `skyCoords`,
 * `hairInk`, `hairDir`, `anchoredNoise`, `vnoiseA`, `toothOf`,
 * `blotchA`, `bloomA`) mirror the shader term for term and are
 * unit-tested in node. `nestedStrokeInk` takes explicit stroke widths:
 * `hw = mu·(wBase + wTone·tone)` with an edge of `± aa·mu`; `scribble`
 * passes its v4 values `(0.30, 0.20, 0.15)`. The GLSL `toothOf` /
 * `blotchA` / `bloomA` take a `Surf` (sky branch: `s.ps` with
 * `mx = my = 1`); the TS mirrors take `(u, along, mu, ma)`.
 */

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
 * Far-depth fade for non-sky tone (§4.11): `1 − 0.45·smoothstep(120, 900,
 * d)` — far blocks sketch lighter.
 */
export function depthFade(d: number): number {
  return 1 - 0.45 * smoothstep(120, 900, d);
}

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
 * {@link lifted}), soft layer switching, stroke core
 * `hw = mu·(wBase + wTone·tone)` with a tight edge of `± aa·mu` —
 * `scribble` passes its v4 values `(0.30, 0.20, 0.15)`. `mu` / `ma` are
 * metres of `u` / `along` per screen cell from {@link strokeScale}.
 */
export function nestedStrokeInk(
  u: number,
  along: number,
  tone: number,
  mu: number,
  ma: number,
  wBase: number,
  wTone: number,
  aa: number,
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
    const hw = mu * (wBase + wTone * tone);
    for (let di = -2; di <= 2; di++) {
      const i = i0 + di;
      const key = i * S;
      const ph = hash2(key, 0) * 6.2832;
      if (lifted(key, along, ma)) continue;
      const wob = wobble(along, ph, mu, ma, key);
      const cov = 1 - smoothstep(hw - aa * mu, hw + aa * mu, Math.abs(u - key - wob));
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
 * Hash grain of `cells` on-screen cells, in world units, blended across
 * the two nearest power-of-two levels (§4.11 "anchored tooth"):
 * `lx = log2(cells·mx)`, `Lx = floor(lx)`, `fx = fract(lx)` (same for
 * `y`); `n(L) = hash2(floor(x / 2^Lx) + 7·key, floor(y / 2^Ly) + 13·key)`;
 * result `mix(n(Lx, Ly), n(Lx+1, Ly+1), max(fx, fy))` in `[0, 1]`.
 * Sky pass uses `mx = my = 1` (`ps` is already in cells).
 */
export function anchoredNoise(
  x: number,
  y: number,
  mx: number,
  my: number,
  cells: number,
  key: number,
): number {
  const lx = Math.log2(cells * mx);
  const ly = Math.log2(cells * my);
  const Lx = Math.floor(lx);
  const Ly = Math.floor(ly);
  const n = (LvX: number, LvY: number): number =>
    hash2(Math.floor(x / 2 ** LvX) + 7 * key, Math.floor(y / 2 ** LvY) + 13 * key);
  return mix(n(Lx, Ly), n(Lx + 1, Ly + 1), Math.max(lx - Lx, ly - Ly));
}

/**
 * Bilinear value noise on one power-of-two level of the anchored
 * lattice: corner hashes of `n(L)` at the four floor/ceil corners,
 * Hermite `smoothstep` weights.
 */
function vnoiseALevel(x: number, y: number, Lx: number, Ly: number, key: number): number {
  const px = x / 2 ** Lx;
  const py = y / 2 ** Ly;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const ux = smoothstep(0, 1, fract(px));
  const uy = smoothstep(0, 1, fract(py));
  const a = hash2(ix + 7 * key, iy + 13 * key);
  const b = hash2(ix + 1 + 7 * key, iy + 13 * key);
  const c = hash2(ix + 7 * key, iy + 1 + 13 * key);
  const d = hash2(ix + 1 + 7 * key, iy + 1 + 13 * key);
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

/**
 * Bilinear value noise on the same anchored lattice as
 * {@link anchoredNoise} (§4.11 "anchored tooth"): corner hashes from
 * `n(L)` at the four floor/ceil corners of the level-`Lx`/`Ly` cell,
 * smoothstep weights, blended across the two nearest power-of-two
 * levels. Result in `[0, 1]`.
 */
export function vnoiseA(
  x: number,
  y: number,
  mx: number,
  my: number,
  cells: number,
  key: number,
): number {
  const lx = Math.log2(cells * mx);
  const ly = Math.log2(cells * my);
  const Lx = Math.floor(lx);
  const Ly = Math.floor(ly);
  return mix(
    vnoiseALevel(x, y, Lx, Ly, key),
    vnoiseALevel(x, y, Lx + 1, Ly + 1, key),
    Math.max(lx - Lx, ly - Ly),
  );
}

/**
 * Paper tooth in `[0.80, 1.20]` (§4.11 `toothOf`):
 * `0.80 + 0.40 · anchoredNoise(u, along, mu, ma, 0.67, 1)` — ≈ 2 px
 * grain, world-anchored. The GLSL twin takes a `Surf` and uses `s.ps`
 * with `mx = my = 1` on sky.
 */
export function toothOf(u: number, along: number, mu: number, ma: number): number {
  return 0.8 + 0.4 * anchoredNoise(u, along, mu, ma, 0.67, 1);
}

/**
 * Granulation blotches in `[0, 1]` (§4.11 `blotchA`):
 * `0.5 · vnoiseA(u, along, mu, ma, 6, 2) + 0.5 · vnoiseA(u, along, mu, ma, 17, 3)`.
 * The GLSL twin takes a `Surf` and uses `s.ps` with scale 1 on sky.
 */
export function blotchA(u: number, along: number, mu: number, ma: number): number {
  return 0.5 * vnoiseA(u, along, mu, ma, 6, 2) + 0.5 * vnoiseA(u, along, mu, ma, 17, 3);
}

/**
 * Backruns / bloom factor in `[0, 1]` (§4.11 `bloomA`):
 * `smoothstep(0.60, 0.90, vnoiseA(u, along, mu, ma, 40, 4))`. The GLSL
 * twin takes a `Surf`; on sky it is the cloud-gap field
 * `smoothstep(0.55, 0.80, vnoiseA(ps.x, ps.y, 1, 1, 30, 5))`.
 */
export function bloomA(u: number, along: number, mu: number, ma: number): number {
  return smoothstep(0.6, 0.9, vnoiseA(u, along, mu, ma, 40, 4));
}

/**
 * The shared stroke GLSL chunk (§4.11 "Shared stroke chunk (T-0139)" +
 * "anchored tooth" T-0144): `hash2`, `depthFade`, `viewPos`,
 * `viewNormal`, `strokeCoords`, `strokeScale`, `vis`, `vnoise1`,
 * `wobble`, `lifted`, `strokeLayer`, `nestedStrokeInk` (parameterised
 * stroke widths `wBase`/`wTone`/`aa`), `hairInk`, `skyCoords`,
 * `anchoredNoise`, `vnoiseA`, the `Surf` struct,
 * `Surf surfaceAt(vec2 uv)`, `toothOf(s)`, `blotchA(s)`, `bloomA(s)`.
 * A style prepends it to its own fragment, which is appended to
 * `STYLE_PRELUDE` — nothing here redeclares a prelude uniform. GLSL
 * ES 1.0: the three nested layers are an `if` ladder; the hair loop is
 * 3 × 3 × 3 constant-bound; `exp2`/`log2`/`mod` are ES 1.0.
 */
export const STROKE_GLSL = `
const float UP_K = 0.6;

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

// One nested-LOD level: lines at u = i·2^j metres; hw = mu·(wBase +
// wTone·tone) with edge ± aa·mu; odd lines fade with (1 − f) (no-pop).
float strokeLayer(float u, float along, float tone, float mu, float ma, float j, float f,
                  float wBase, float wTone, float aa) {
  float S = exp2(j);
  float i0 = floor(u / S + 0.5);
  float hw = mu * (wBase + wTone * tone);
  float ink = 0.0;
  for (int di = -2; di <= 2; di++) {
    float i = i0 + float(di);
    float key = i * S;
    float ph = hash2(key, 0.0) * 6.2832;
    if (!lifted(key, along, ma)) {
      float wob = wobble(along, ph, mu, ma, key);
      float cov = 1.0 - smoothstep(hw - aa * mu, hw + aa * mu, abs(u - key - wob));
      float weight = (mod(abs(i), 2.0) > 0.5) ? (1.0 - f) : 1.0;
      ink = max(ink, cov * weight);
    }
  }
  return ink;
}

// Three soft layers (SCRIBBLE_LAYERS thresholds 0.10 / 0.40 / 0.70 ± 0.08).
float nestedStrokeInk(float u, float along, float tone, float mu, float ma,
                      float wBase, float wTone, float aa) {
  float ink = 0.0;
  float lod = log2(8.0 * mu);
  float L = floor(lod);
  float f = fract(lod);
  float w0 = smoothstep(0.02, 0.18, tone);
  float w1 = smoothstep(0.32, 0.48, tone);
  float w2 = smoothstep(0.62, 0.78, tone);
  if (w0 > 0.0) ink = max(ink, strokeLayer(u, along, tone, mu, ma, L - 0.0, f, wBase, wTone, aa) * w0);
  if (w1 > 0.0) ink = max(ink, strokeLayer(u, along, tone, mu, ma, L - 1.0, f, wBase, wTone, aa) * w1);
  if (w2 > 0.0) ink = max(ink, strokeLayer(u, along, tone, mu, ma, L - 2.0, f, wBase, wTone, aa) * w2);
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

vec2 skyCoords(vec3 dirW, float K) {
  return K * vec2(dirW.x, dirW.z) / (1.0 + dirW.y);
}

// Hash grain of a given on-screen cell count, in world units, blended across
// the two nearest power-of-two levels (§4.11 "anchored tooth"). Sky
// pass uses mx = my = 1 (ps is already in cells).
float anchoredNoise(float x, float y, float mx, float my, float cells, float key) {
  float lx = log2(cells * mx);
  float ly = log2(cells * my);
  float Lx = floor(lx);
  float Ly = floor(ly);
  float n0 = hash2(floor(x / exp2(Lx)) + 7.0 * key, floor(y / exp2(Ly)) + 13.0 * key);
  float n1 = hash2(floor(x / exp2(Lx + 1.0)) + 7.0 * key, floor(y / exp2(Ly + 1.0)) + 13.0 * key);
  return mix(n0, n1, max(fract(lx), fract(ly)));
}

// Bilinear value noise on one power-of-two level of the anchored lattice.
float vnoiseALevel(float x, float y, float Lx, float Ly, float key) {
  vec2 p = vec2(x / exp2(Lx), y / exp2(Ly));
  vec2 i = floor(p);
  vec2 u = vec2(smoothstep(0.0, 1.0, fract(p.x)), smoothstep(0.0, 1.0, fract(p.y)));
  float a = hash2(i.x + 7.0 * key, i.y + 13.0 * key);
  float b = hash2(i.x + 1.0 + 7.0 * key, i.y + 13.0 * key);
  float c = hash2(i.x + 7.0 * key, i.y + 1.0 + 13.0 * key);
  float d = hash2(i.x + 1.0 + 7.0 * key, i.y + 1.0 + 13.0 * key);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Bilinear value noise on the same anchored lattice as anchoredNoise.
float vnoiseA(float x, float y, float mx, float my, float cells, float key) {
  float lx = log2(cells * mx);
  float ly = log2(cells * my);
  float Lx = floor(lx);
  float Ly = floor(ly);
  float n0 = vnoiseALevel(x, y, Lx, Ly, key);
  float n1 = vnoiseALevel(x, y, Lx + 1.0, Ly + 1.0, key);
  return mix(n0, n1, max(fract(lx), fract(ly)));
}

struct Surf {
  int cls;      // 0 sky | 1 ground | 2 wall
  float dC;     // cell-centre linear depth (metres)
  float dPix;   // reconstructed per-pixel depth (metres)
  vec3 W;       // world position of the pixel
  vec3 nW;      // unit world-space surface normal
  float mu;     // metres of u per screen cell (stroke scale)
  float ma;     // metres of along per screen cell (stroke scale)
  float u;      // stroke coordinate across the strokes (metres)
  float along;  // stroke coordinate along the strokes (metres)
  vec3 dirW;    // sky cells only: world view direction
  vec2 ps;      // sky cells only: stereographic dome position (cells)
  bool outline; // one-sided outline: the cell inks fully
};

// Everything a sketch style computes before colouring: the five clamped
// one-cell depth taps, the sky test, the class, dPix, W, nW,
// strokeCoords + strokeScale and the one-sided outline test. For sky
// cells (cls == 0) dirW / ps are filled and the rest is zero.
Surf surfaceAt(vec2 uv) {
  vec2 p = uv * grid;
  vec2 cell = floor(p);

  // Depth taps ONE CELL apart at texel centres, CLAMPED to
  // [0.5·texel, 1 − 0.5·texel] so the bottom/edge rows get a real
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

  Surf s;
  s.cls = 0;
  s.dC = dC;
  s.dPix = dC;
  s.W = vec3(0.0);
  s.nW = vec3(0.0);
  s.mu = 0.0;
  s.ma = 0.0;
  s.u = 0.0;
  s.along = 0.0;
  s.dirW = vec3(0.0);
  s.ps = vec2(0.0);
  s.outline = false;

  if (dC >= skyThr) {
    s.dirW = normalize(mat3(viewToWorld) * viewPos(uv, 1.0, tanHalfFov, aspect));
    float K = sceneSize.y / (2.0 * atan(tanHalfFov));
    s.ps = skyCoords(s.dirW, K);
    return s;
  }

  // Surface class by NORMAL: up = |dot(n, viewUp)| — 1 for a floor/roof,
  // 2 for a wall, independent of camera pitch.
  vec3 n = viewNormal(uvL, uvR, uvU, uvD, dL, dR, dU, dD, tanHalfFov, aspect);
  float up = abs(dot(n, viewUp));
  s.cls = (up > UP_K) ? 1 : 2;

  // Per-pixel depth from the one-cell taps (gradient zeroed on a 35 %
  // jump), then world position and normal.
  vec2 o = p - (cell + 0.5);
  float gX = 0.5 * (dR - dL);
  float gY = 0.5 * (dU - dD);
  if (abs(dR - dC) > 0.35 * dC || abs(dL - dC) > 0.35 * dC) gX = 0.0;
  if (abs(dU - dC) > 0.35 * dC || abs(dD - dC) > 0.35 * dC) gY = 0.0;
  s.dPix = dC + gX * o.x + gY * o.y;
  s.W = (viewToWorld * vec4(viewPos(uv, s.dPix, tanHalfFov, aspect), 1.0)).xyz;
  s.nW = normalize(mat3(viewToWorld) * n);

  vec2 sc = strokeCoords(s.W, s.nW, s.dPix, up);
  s.u = sc.x;
  s.along = sc.y;
  vec2 scL = strokeCoords((viewToWorld * vec4(viewPos(uvL, dL, tanHalfFov, aspect), 1.0)).xyz, s.nW, dL, up);
  vec2 scR = strokeCoords((viewToWorld * vec4(viewPos(uvR, dR, tanHalfFov, aspect), 1.0)).xyz, s.nW, dR, up);
  vec2 scU = strokeCoords((viewToWorld * vec4(viewPos(uvU, dU, tanHalfFov, aspect), 1.0)).xyz, s.nW, dU, up);
  vec2 scD = strokeCoords((viewToWorld * vec4(viewPos(uvD, dD, tanHalfFov, aspect), 1.0)).xyz, s.nW, dD, up);
  vec2 scale = strokeScale(scL, scR, scU, scD, up);
  s.mu = scale.x;
  s.ma = scale.y;

  // One-sided outline: a depth discontinuity (sky disagreement or an
  // inverse-depth second difference) whose nearer side this cell is.
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
  s.outline = (jump || crease) && nearSide;
  return s;
}

// Paper tooth in [0.80, 1.20]: ≈ 2 px, world-anchored on surfaces,
// dome-anchored on sky (§4.11 "anchored tooth").
float toothOf(Surf s) {
  if (s.cls == 0) {
    return 0.80 + 0.40 * anchoredNoise(s.ps.x, s.ps.y, 1.0, 1.0, 0.67, 1.0);
  }
  return 0.80 + 0.40 * anchoredNoise(s.u, s.along, s.mu, s.ma, 0.67, 1.0);
}

// Granulation blotches in [0, 1]; sky uses s.ps with scale 1.
float blotchA(Surf s) {
  if (s.cls == 0) {
    return 0.5 * vnoiseA(s.ps.x, s.ps.y, 1.0, 1.0, 6.0, 2.0)
         + 0.5 * vnoiseA(s.ps.x, s.ps.y, 1.0, 1.0, 17.0, 3.0);
  }
  return 0.5 * vnoiseA(s.u, s.along, s.mu, s.ma, 6.0, 2.0)
       + 0.5 * vnoiseA(s.u, s.along, s.mu, s.ma, 17.0, 3.0);
}

// Surface backruns: smoothstep(0.60, 0.90, vnoiseA(..., 40, 4)).
// Sky clouds:      smoothstep(0.55, 0.80, vnoiseA(ps, 1, 1, 30, 5)).
float bloomA(Surf s) {
  if (s.cls == 0) {
    return smoothstep(0.55, 0.80, vnoiseA(s.ps.x, s.ps.y, 1.0, 1.0, 30.0, 5.0));
  }
  return smoothstep(0.60, 0.90, vnoiseA(s.u, s.along, s.mu, s.ma, 40.0, 4.0));
}
`;
