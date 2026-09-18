/**
 * `pastel` render style (docs/architecture.md §4.11, wave 18 "sketch
 * family"): soft chalk pastel on toned paper — a **stroke-free** sketch
 * family member. Per pixel (T-0145) the 3×3-smoothed samples of the four
 * cells nearest to the chalk-smudged `p − 0.5` are blended bilinearly
 * (sky cells contribute their PAPER_S mix so silhouettes feather), the
 * hue becomes a pastel (`chalk = mix(white, tint, 0.65·satF)`) that the
 * world/dome-anchored paper tooth `g = toothOf(s)` lets bleed through,
 * and dark chalk deepens the shadows. A soft 2-cell outline ramp
 * replaces the binary cell outline. `surfaceAt` (shared chunk, T-0139)
 * supplies the sky test (`s.cls`) and the coordinates `toothOf` /
 * `blotchA` / the smudge jitter read; neighbour outline flags come from
 * `outlineAt`. Cell 2×2, sub 1×1, `targetCap` 960×540, `needsDepth:
 * true`, `groundGrid: false`.
 *
 * `daylight` is the only style uniform, seeded in `makeUniforms` and
 * refreshed in `update`; prelude uniforms are never redeclared.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { STROKE_GLSL } from './strokes';

/** GLSL `mix(a, b, t) = a + (b − a)·t`. */
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** GLSL `fract(x)`: fractional part, in `[0, 1)` even for negative x. */
function fract(x: number): number {
  return x - Math.floor(x);
}

/** GLSL `smoothstep(edge0, edge1, x)`: clamped, Hermite-smoothed 0→1. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** The toned pastel paper (§4.11 `PAPER_S`). `[r, g, b]` in `[0, 1]`. */
export const PAPER_S: readonly [number, number, number] = [0.93, 0.9, 0.84];

/** The dark chalk the shadows and the faint outline mix toward (§4.11). */
export const DARK_CHALK: readonly [number, number, number] = [0.2, 0.18, 0.22];

/**
 * Pastel chalk colour (§4.11 `chalkOf`): `mix(white, t, 0.65·satF)` —
 * pastel = hue + white; grey things (satF = 0) stay pure white chalk.
 */
export function chalkOf(
  tint: readonly [number, number, number],
  satF: number,
): [number, number, number] {
  return [
    mix(1, tint[0], 0.65 * satF),
    mix(1, tint[1], 0.65 * satF),
    mix(1, tint[2], 0.65 * satF),
  ];
}

/**
 * Chalk colour of a surface cell (§4.11 `pastelColour`):
 * `col = mix(PAPER_S, chalkOf(tint, satF), 0.9·g)` (the tooth lets paper
 * through), then `col = mix(col, DARK_CHALK, (1−v)·0.55·g)` (dark chalk
 * in the shadows) — `v` the shaped brightness of the smoothed sample,
 * `g` the world/dome-anchored paper tooth. `satF = smoothstep(0.10, 0.45, sat)`
 * is derived from `tint`, exactly as scribble.
 */
export function pastelColour(
  v: number,
  tint: readonly [number, number, number],
  g: number,
): [number, number, number] {
  const sat = Math.max(tint[0], tint[1], tint[2]) - Math.min(tint[0], tint[1], tint[2]);
  const satF = smoothstep(0.1, 0.45, sat);
  const chalk = chalkOf(tint, satF);
  const col: [number, number, number] = [
    mix(PAPER_S[0], chalk[0], 0.9 * g),
    mix(PAPER_S[1], chalk[1], 0.9 * g),
    mix(PAPER_S[2], chalk[2], 0.9 * g),
  ];
  return [
    mix(col[0], DARK_CHALK[0], (1 - v) * 0.55 * g),
    mix(col[1], DARK_CHALK[1], (1 - v) * 0.55 * g),
    mix(col[2], DARK_CHALK[2], (1 - v) * 0.55 * g),
  ];
}

/**
 * Bilinear weights of the four cells nearest to `p − 0.5` (§4.11 T-0145):
 * `[w00, w10, w01, w11]`, summing to 1. At a cell centre (`p − 0.5`
 * integer) this is `[1, 0, 0, 0]`; at a cell corner,
 * `[0.25, 0.25, 0.25, 0.25]`.
 */
export function bilinearWeights(p: readonly [number, number]): [number, number, number, number] {
  const fx = fract(p[0] - 0.5);
  const fy = fract(p[1] - 0.5);
  return [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
}

/**
 * Soft 2-cell outline ramp (§4.11 T-0145):
 * `0.35 · smoothstep(0.15, 0.85, e)`. Zero at `e = 0`, `0.35` at
 * `e = 1`, monotone.
 */
export function softEdge(e: number): number {
  return 0.35 * smoothstep(0.15, 0.85, e);
}

/**
 * §4.11 wave-18 "pastel" fragment (the half after the shared
 * `STROKE_GLSL` chunk, docs/styles/strokes.md), T-0145 soft edges. The
 * sample is per PIXEL: 3×3-mean of the four cells nearest to the chalk-
 * smudged `pj − 0.5`, blended bilinearly with `fract(pj − 0.5)` (36
 * taps); sky cells contribute their PAPER_S mix so silhouettes feather.
 * `v = shaped(bright(cs))`, `tint = tintOf(cs)`,
 * `satF = smoothstep(0.10, 0.45, sat)`. The paper grain `g = toothOf(s)`
 * and the sky streaks `blotchA(s)` come from the chunk (§4.11
 * "anchored tooth"). Sky cells: `mix(PAPER_S, (0.62,0.75,0.92), 0.75·g)`
 * with white streaks by day, `mix(PAPER_S, (0.18,0.18,0.35), 0.8·g)` by night.
 * Surface cells: `pastelColour(v, tint, g)`. Outline is a soft 2-cell
 * ramp of the four cells' `outlineAt` flags, not a binary cell outline.
 * `daylight` is the only style uniform; `viewUp`, `tanHalfFov` and
 * `viewToWorld` come from the prelude.
 */
const PASTEL_FRAGMENT = `
uniform float daylight;
const vec3 PAPER_S = vec3(0.93, 0.90, 0.84);
const vec3 DARK_CHALK = vec3(0.20, 0.18, 0.22);

// Sample of a surface cell; sky cells contribute the PAPER_S mix
// (day blue / night indigo, no streaks) so building/sky borders feather.
vec3 sampleOrSky(vec2 cell, float g) {
  vec2 centreUv = (cell * sub + 0.5) / sceneSize;
  if (linearDepth(centreUv) >= 0.98 * cameraFar) {
    if (daylight >= 0.5) {
      return mix(PAPER_S, vec3(0.62, 0.75, 0.92), 0.75 * g);
    }
    return mix(PAPER_S, vec3(0.18, 0.18, 0.35), 0.8 * g);
  }
  return sampleSub(cell, 0.0, 0.0);
}

void main() {
  vec2 p = vUv * grid;

  // Centre cell: class / u / along / ps (and the tooth coords). No
  // stroke calls — toothOf / blotchA / the smudge jitter read Surf.
  Surf s = surfaceAt(vUv);
  float g = toothOf(s);

  // Chalk smudge: jitter the sample position from anchoredNoise
  // (surfaces: u/along; sky: ps with mx = my = 1).
  vec2 n2;
  if (s.cls == 0) {
    n2 = vec2(anchoredNoise(s.ps.x, s.ps.y, 1.0, 1.0, 1.5, 6.0),
              anchoredNoise(s.ps.x, s.ps.y, 1.0, 1.0, 1.5, 7.0));
  } else {
    n2 = vec2(anchoredNoise(s.u, s.along, s.mu, s.ma, 1.5, 6.0),
              anchoredNoise(s.u, s.along, s.mu, s.ma, 1.5, 7.0));
  }
  vec2 pj = p + 1.2 * (n2 - 0.5);

  // Four cells nearest to pj − 0.5, bilinear with fract(pj − 0.5).
  vec2 q = pj - 0.5;
  vec2 i0 = floor(q);
  vec2 fr = fract(q);
  float w00 = (1.0 - fr.x) * (1.0 - fr.y);
  float w10 = fr.x * (1.0 - fr.y);
  float w01 = (1.0 - fr.x) * fr.y;
  float w11 = fr.x * fr.y;

  vec3 col;
  if (s.cls == 0) {
    // Sky: colour formulas unchanged.
    if (daylight >= 0.5) {
      col = mix(PAPER_S, vec3(0.62, 0.75, 0.92), 0.75 * g);
      col = mix(col, vec3(1.0), 0.5 * smoothstep(0.55, 0.75, blotchA(s)));
    } else {
      col = mix(PAPER_S, vec3(0.18, 0.18, 0.35), 0.8 * g);
    }
  } else {
    // Per-pixel bilinear of the four nearest cells (sky → PAPER_S mix).
    vec3 cs = w00 * sampleOrSky(i0, g)
            + w10 * sampleOrSky(i0 + vec2(1.0, 0.0), g)
            + w01 * sampleOrSky(i0 + vec2(0.0, 1.0), g)
            + w11 * sampleOrSky(i0 + vec2(1.0, 1.0), g);
    float v = shaped(bright(cs));
    vec3 tint = tintOf(cs);
    float sat = max(max(tint.r, tint.g), tint.b) - min(min(tint.r, tint.g), tint.b);
    float satF = smoothstep(0.10, 0.45, sat);
    vec3 chalk = mix(vec3(1.0), tint, 0.65 * satF);
    col = mix(PAPER_S, chalk, 0.9 * g);
    col = mix(col, DARK_CHALK, (1.0 - v) * 0.55 * g);
  }

  // Soft 2-cell edge ramp: bilinear blend of the four cells' outlineAt
  // flags (same weights as the colour sample).
  float e = w00 * outlineAt((i0 + vec2(0.5, 0.5)) / grid)
          + w10 * outlineAt((i0 + vec2(1.5, 0.5)) / grid)
          + w01 * outlineAt((i0 + vec2(0.5, 1.5)) / grid)
          + w11 * outlineAt((i0 + vec2(1.5, 1.5)) / grid);
  col = mix(col, DARK_CHALK, 0.35 * smoothstep(0.15, 0.85, e));

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Soft chalk pastel on toned paper — per-pixel bilinear of four cell
 * samples with chalk-smudge jitter, no strokes, the world/dome-anchored
 * paper tooth letting paper through the chalk, dark chalk in the
 * shadows, a soft 2-cell outline ramp, pastel-blue (day) / indigo
 * (night) sky. Cell 2×2, sub 1×1, `targetCap` 960×540, depth.
 * `R` cycles, `?render=pastel`.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'pastel',
    label: 'PASTEL',
    cellW: 2,
    cellH: 2,
    subX: 1,
    subY: 1,
    targetCap: { w: 960, h: 540 },
    needsDepth: true,
    groundGrid: false,
    fragment: STROKE_GLSL + PASTEL_FRAGMENT,
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
