/**
 * `pastel` render style (docs/architecture.md §4.11, wave 18 "sketch
 * family"): soft chalk pastel on toned paper — a **stroke-free** sketch
 * family member. The scene sample is 3×3-cell **smoothed** (nine taps,
 * soft edges), the hue becomes a pastel (`chalk = mix(white, tint,
 * 0.65·satF)`) that the world/dome-anchored paper tooth `g = toothOf(s)`
 * lets bleed through, and dark chalk deepens the shadows. `surfaceAt`
 * (shared chunk, T-0139) supplies the sky test (`s.cls`), the outline
 * flag (`s.outline`), and the coordinates the chunk's `toothOf` /
 * `blotchA` read — there are no stroke calls at all. Cell
 * 3×3, sub 1×1, `needsDepth: true`, `groundGrid: false`.
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
 * §4.11 wave-18 "pastel" fragment (the half after the shared
 * `STROKE_GLSL` chunk, docs/styles/strokes.md). The smoothed sample is
 * the mean of `sampleSub` over the 3×3 CELL neighbourhood (9 taps; soft
 * edges); `v = shaped(bright(cs))`, `tint = tintOf(cs)`,
 * `satF = smoothstep(0.10, 0.45, sat)`. The paper grain `g = toothOf(s)`
 * and the sky streaks `blotchA(s)` come from the chunk (§4.11
 * "anchored tooth"). Sky cells: `mix(PAPER_S, (0.62,0.75,0.92), 0.75·g)`
 * with white streaks by day, `mix(PAPER_S, (0.18,0.18,0.35), 0.8·g)` by night.
 * Surface cells: `pastelColour(v, tint, g)`; the faint chalky outline
 * mixes to dark chalk at 0.35. `daylight` is the only style uniform;
 * `viewUp`, `tanHalfFov` and `viewToWorld` come from the prelude.
 */
const PASTEL_FRAGMENT = `
uniform float daylight;
const vec3 PAPER_S = vec3(0.93, 0.90, 0.84);
const vec3 DARK_CHALK = vec3(0.20, 0.18, 0.22);

void main() {
  vec2 p = vUv * grid;
  vec2 cell = floor(p);

  // Smoothed sample: the mean over the 3×3 CELL neighbourhood —
  // nine 1×1 taps, soft edges (sub is 1×1, so one sample per cell).
  vec3 cs = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      cs += sampleSub(cell + vec2(float(dx), float(dy)), 0.0, 0.0);
    }
  }
  cs /= 9.0;

  float v = shaped(bright(cs));
  vec3 tint = tintOf(cs);
  float sat = max(max(tint.r, tint.g), tint.b) - min(min(tint.r, tint.g), tint.b);
  float satF = smoothstep(0.10, 0.45, sat);

  // Everything about the surface: clamped taps, sky test, class, dPix,
  // W / nW, stroke coordinates + scale, one-sided outline. No stroke
  // calls — toothOf / blotchA read the Surf coords.
  Surf s = surfaceAt(vUv);

  // Paper grain: world-anchored on surfaces, dome-anchored on sky,
  // ≈ 2 px (§4.11 "anchored tooth").
  float g = toothOf(s);

  // Sky: soft pastel blue with white streaks by day; a deep chalk
  // indigo by night.
  if (s.cls == 0) {
    vec3 col;
    if (daylight >= 0.5) {
      col = mix(PAPER_S, vec3(0.62, 0.75, 0.92), 0.75 * g);
      col = mix(col, vec3(1.0), 0.5 * smoothstep(0.55, 0.75, blotchA(s)));
    } else {
      col = mix(PAPER_S, vec3(0.18, 0.18, 0.35), 0.8 * g);
    }
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  // Surface: pastel = hue + white, the tooth lets paper through, dark
  // chalk deepens the shadows.
  vec3 chalk = mix(vec3(1.0), tint, 0.65 * satF);
  vec3 col = mix(PAPER_S, chalk, 0.9 * g);
  col = mix(col, DARK_CHALK, (1.0 - v) * 0.55 * g);

  // Faint, chalky one-sided outline — never a solid line.
  if (s.outline) col = mix(col, DARK_CHALK, 0.35);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Soft chalk pastel on toned paper — 3×3-smoothed scene sample, no
 * strokes, the world/dome-anchored paper tooth letting paper through the
 * chalk, dark chalk in the shadows, a faint chalky outline, pastel-blue
 * (day) / indigo (night) sky. Cell 3×3, sub 1×1, depth.
 * `R` cycles, `?render=pastel`.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'pastel',
    label: 'PASTEL',
    cellW: 3,
    cellH: 3,
    subX: 1,
    subY: 1,
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
