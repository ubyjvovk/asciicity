/**
 * `watercolor` render style (docs/architecture.md §4.11, wave 18 "sketch
 * family", "watercolor" — `T-0143`): wet washes on bright paper. There are
 * no strokes at all — tone is carried by *pigment density* in a
 * transparent wash: more pigment in the shade, granulation blotches in
 * screen space, the edge of a wash darkening where the pigment pools
 * (one-sided outline → `col · 0.55`), and lights left white (a lit window
 * reads as paper because its tone ≈ 0). Saturated things take the
 * object's own hue (`pig = mix(1, tint, 0.8·satF)`); grey things get a
 * neutral slate wash. The sky is a plain granulated blue by day and deep
 * indigo at night. Cell 3×3, sub 1×1, `needsDepth: true`,
 * `groundGrid: false`.
 *
 * The world-anchored surface machinery is the shared chunk `./strokes.ts`:
 * `fragment: STROKE_GLSL + WATERCOLOR_FRAGMENT`, and `main()` starts with
 * `Surf s = surfaceAt(vUv);` — watercolor uses it only for the sky test,
 * `dirW` (zenith gradient in the sky) and the outline flag. The wave-18
 * common block's `vnoise`/`blotch` (2-D screen-space value noise for the
 * granulation) are not in `strokes.ts` yet (it only has 1-D `vnoise1`), so
 * both live in this fragment; their TS mirrors are here too. `daylight`
 * is the only style uniform, seeded in `makeUniforms` and refreshed by
 * `update`; prelude uniforms are never redeclared.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { STROKE_GLSL, hash2 } from './strokes';

/** GLSL `mix(a, b, t) = a + (b − a)·t`. */
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The bright paper of the watercolour (screen — it does not move with the
 * world). `[r, g, b]` in `[0, 1]`.
 */
export const PAPER_W: readonly [number, number, number] = [0.99, 0.98, 0.95];

/**
 * The neutral slate the wash mixes toward for grey things (satF < 0.5,
 * §4.11 `watercolor`). `[r, g, b]` in `[0, 1]`.
 */
export const GREY_WASH: readonly [number, number, number] = [0.35, 0.36, 0.42];

/**
 * 2-D value noise in `[0, 1]` (the wave-18 common block `vnoise`, which
 * `strokes.ts` does not provide yet — it only has 1-D `vnoise1`): the
 * bilinear (smoothstep-fade) blend of `hash2` at the four corners of
 * `floor(q)`. Screen space, so the granulation is anchored to the screen,
 * not the world.
 */
export function vnoise(x: number, y: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return mix(
    mix(hash2(i, j), hash2(i + 1, j), sx),
    mix(hash2(i, j + 1), hash2(i + 1, j + 1), sx),
    sy,
  );
}

/**
 * Granulation blotches (the wave-18 common block `blotch`, `q` in
 * screen-space cells): `0.5·vnoise(q/6) + 0.5·vnoise(q/17)` — two octaves
 * of value noise, in `[0, 1]` (so `gran = 0.85 + 0.30·blotch` sits in
 * `[0.85, 1.15]`).
 */
export function blotch(x: number, y: number): number {
  return 0.5 * vnoise(x / 6, y / 6) + 0.5 * vnoise(x / 17, y / 17);
}

/**
 * Transparent pigment for a full-brightness tint (§4.11 `watercolor`
 * `pigmentOf`): `mix(1, tint, 0.8·satF)` — white where there is no
 * colour, the object's own hue (a shade off pure) where there is.
 */
export function pigmentOf(
  tint: readonly [number, number, number],
  satF: number,
): readonly [number, number, number] {
  const f = 0.8 * satF;
  return [
    mix(1, tint[0], f),
    mix(1, tint[1], f),
    mix(1, tint[2], f),
  ];
}

/**
 * Wash pigment density for (depth-faded) tone (§4.11 `watercolor`
 * `washDensity`): `0.35 + 0.65·tone^0.6` — more pigment in the shade; a
 * floor of 0.35 keeps even the lightest wash slightly tinted.
 */
export function washDensity(tone: number): number {
  return 0.35 + 0.65 * Math.pow(tone, 0.6);
}

/**
 * Clamped paper→pigment mix factor of the wash (§4.11 `watercolor`
 * `col` term): `dens·gran·(0.3 + 0.7·satF) + 0.25·tone2·(1−satF)` —
 * saturated pigment is laid on full, grey pigment only at 30 %, plus a
 * small flat grey-darkening with tone. Monotone in `tone2`; minimal (
 * `0.35·gran·(0.3 + 0.7·satF)`) at tone 0, where the paper still reads
 * as paper.
 */
export function washStrength(tone2: number, satF: number, gran: number): number {
  const dens = washDensity(tone2);
  return Math.min(
    1,
    Math.max(0, dens * gran * (0.3 + 0.7 * satF) + 0.25 * tone2 * (1 - satF)),
  );
}

/**
 * The full surface wash colour (§4.11 `watercolor` `col`, before the
 * pooled edge): `mix(PAPER_W, pig, washStrength(tone2, satF, gran))`,
 * then — grey things only (satF < 0.5) — `mix` toward `GREY_WASH` by
 * `tone2·0.6`.
 */
export function watercolorWash(
  tint: readonly [number, number, number],
  satF: number,
  tone2: number,
  gran: number,
): readonly [number, number, number] {
  const pig = pigmentOf(tint, satF);
  const f = washStrength(tone2, satF, gran);
  const col: [number, number, number] = [
    mix(PAPER_W[0], pig[0], f),
    mix(PAPER_W[1], pig[1], f),
    mix(PAPER_W[2], pig[2], f),
  ];
  if (satF < 0.5) {
    const gg = tone2 * 0.6;
    return [
      mix(col[0], GREY_WASH[0], gg),
      mix(col[1], GREY_WASH[1], gg),
      mix(col[2], GREY_WASH[2], gg),
    ];
  }
  return col;
}

/**
 * §4.11 "watercolor" fragment (the half after the shared `STROKE_GLSL`
 * chunk, docs/styles/strokes.md). `main()` starts with `Surf s =
 * surfaceAt(vUv)` and then takes `tone`, `tint`, `satF` exactly as
 * scribble, `tone2 = tone·depthFade(s.dC)`. The granulation
 * `gran = 0.85 + 0.30·blotch(p)` (p in screen-space cells) is the new
 * term; `vnoise`/`blotch` are defined here because `strokes.ts` does not
 * carry them yet. Sky: plain granulated washes (day a zenith-gradient
 * blue via `s.dirW`, night deep indigo) — no hair strokes. Surface:
 * `pig = mix(1, tint, 0.8·satF)`, `dens = 0.35 + 0.65·tone2^0.6`,
 * `col = mix(PAPER_W, pig, clamp(dens·gran·(0.3 + 0.7·satF) +
 * 0.25·tone2·(1−satF), 0, 1))`, grey mix for satF < 0.5, and the pooled
 * edge `col · 0.55` on `s.outline`. `daylight` is the only style
 * uniform; `viewUp`, `tanHalfFov` and `viewToWorld` come from the
 * prelude and are never redeclared.
 */
const WATERCOLOR_FRAGMENT = `
uniform float daylight;
const vec3 PAPER_W = vec3(0.99, 0.98, 0.95);
const vec3 GREY_WASH = vec3(0.35, 0.36, 0.42);

// 2-D value noise for the washes (strokes.ts only has 1-D vnoise1):
// bilinear blend of hash2 at the four corners of floor(q), screen space.
float vnoise(vec2 q) {
  vec2 i = floor(q);
  vec2 f = q - i;
  f = f * f * (3.0 - 2.0 * f);
  float a = hash2(i.x, i.y);
  float b = hash2(i.x + 1.0, i.y);
  float c = hash2(i.x, i.y + 1.0);
  float d = hash2(i.x + 1.0, i.y + 1.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Granulation blotches: two octaves of value noise, in [0.5, 1].
float blotch(vec2 q) {
  return 0.5 * vnoise(q / 6.0) + 0.5 * vnoise(q / 17.0);
}

void main() {
  vec2 p = vUv * grid;
  float gran = 0.85 + 0.30 * blotch(p);

  // Everything about the surface: watercolor only needs the sky test,
  // dirW (zenith gradient) and the outline flag.
  Surf s = surfaceAt(vUv);

  vec2 cell = floor(p);
  vec3 c = sampleSub(cell, 0.0, 0.0);
  float v = shaped(bright(c));
  float tone = 1.0 - v;
  vec3 tint = tintOf(c);
  float sat = max(max(tint.r, tint.g), tint.b) - min(min(tint.r, tint.g), tint.b);
  float satF = smoothstep(0.10, 0.45, sat);

  // Sky: a plain granulated wash — day a blue that deepens toward the
  // zenith, night deep indigo. No strokes, no hair.
  if (s.cls == 0) {
    vec3 col;
    if (daylight >= 0.5) {
      col = mix(vec3(0.86, 0.92, 1.0), vec3(0.55, 0.72, 0.95),
                clamp(s.dirW.y, 0.0, 1.0));
    } else {
      col = vec3(0.18, 0.20, 0.40);
    }
    gl_FragColor = vec4(col * gran, 1.0);
    return;
  }

  float tone2 = tone * depthFade(s.dC);

  // Transparent pigment, denser in the shade, granulated in screen space.
  vec3 pig = mix(vec3(1.0), tint, 0.8 * satF);
  float dens = 0.35 + 0.65 * pow(tone2, 0.6);
  vec3 col = mix(PAPER_W, pig,
    clamp(dens * gran * (0.3 + 0.7 * satF) + 0.25 * tone2 * (1.0 - satF),
          0.0, 1.0));

  // Grey things take a neutral slate wash instead of a hue.
  if (satF < 0.5) col = mix(col, GREY_WASH, tone2 * 0.6);

  // Pooled edge: pigment collects at the edge of a wash.
  if (s.outline) col *= 0.55;

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Watercolour — wet transparent washes: tone by pigment density, granulation
 * blotches in screen space, grey things washed neutral slate, the edge of a
 * wash darkened where pigment pools, lights left white, a plain granulated
 * blue day / indigo night sky. Cell 3×3, sub 1×1, depth. `R` cycles,
 * `?render=watercolor`.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'watercolor',
    label: 'WATERCOLOR',
    cellW: 3,
    cellH: 3,
    subX: 1,
    subY: 1,
    needsDepth: true,
    groundGrid: false,
    fragment: STROKE_GLSL + WATERCOLOR_FRAGMENT,
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
