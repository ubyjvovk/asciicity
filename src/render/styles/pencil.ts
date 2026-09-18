/**
 * `pencil` render style (docs/architecture.md §4.11, wave 18 "sketch
 * family"): a graphite pencil sketch on warm paper — a smudged tone
 * *wash* whose strength follows the 2×2-px paper tooth `g`, world-anchored
 * strokes from the shared chunk with pencil's wider, softer widths
 * (`hw = mu·(0.45 + 0.25·tone)`, edge `± 0.60·mu`), a 45°-rotated
 * cross-hatch family that fades in for `tone2 > 0.45`, soft one-sided
 * graphite outlines (never solid black) and a pencilled sky — darker
 * toward the zenith by day, an even grey by night, with sparse hair
 * strokes. Cell 3×3, sub 1×1, `needsDepth: true`, `groundGrid: false`.
 *
 * Built on the shared chunk (`./strokes.ts`, T-0139): the fragment is
 * `STROKE_GLSL + PENCIL_FRAGMENT` and `main()` starts with
 * `Surf s = surfaceAt(vUv);`, then `tone` as scribble and
 * `tone2 = tone · depthFade(s.dC)` (the common block's `tint`/`satF` are
 * unused — pencil is graphite, the one ink of the style, and GLSL ES 1.0
 * has no `void` expression to keep them). The paper grain `g` (screen
 * space — the paper does not move with the world) is defined in this
 * fragment; `vnoise`/`blotch` are not needed for `pencil` (only its
 * coloured siblings use washes) and are not defined here. `daylight` is
 * the only style uniform, seeded in `makeUniforms` and refreshed in
 * `update`; prelude uniforms are never redeclared.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { STROKE_GLSL } from './strokes';

/** The warm white paper the graphite sits on (§4.11 `PAPER_P`). `[r, g, b]` in `[0, 1]`. */
export const PAPER_P: readonly [number, number, number] = [0.97, 0.96, 0.93];

/** The graphite (§4.11 `G`) — the one ink of the pencil style. */
export const G: readonly [number, number, number] = [0.22, 0.22, 0.25];

/**
 * Smudged tone wash in `[0, 0.55]` (§4.11 `pencilWash`):
 * `tone · 0.55 · g` — the tooth `g ∈ [0.80, 1.20]` lets the paper show
 * through the wash, so tone 0 is bare paper and the wash is never solid.
 */
export function pencilWash(tone: number, g: number): number {
  return tone * 0.55 * g;
}

/**
 * 45°-rotated cross-hatch stroke space (§4.11 `crossCoords`): the same
 * world-anchored family turned 45° in stroke space,
 * `u2 = (u + along)/√2`, `along2 = (along − u)/√2`, with one shared scale
 * `mu2 = ma2 = (mu + ma)/2`. Orthogonal: `u2² + along2² = u² + along²`.
 */
export function crossCoords(
  u: number,
  along: number,
  mu: number,
  ma: number,
): { u: number; along: number; mu: number; ma: number } {
  const m = (mu + ma) / 2;
  return {
    u: (u + along) / Math.SQRT2,
    along: (along - u) / Math.SQRT2,
    mu: m,
    ma: m,
  };
}

/**
 * §4.11 wave-18 "pencil" fragment (the half after the shared `STROKE_GLSL`
 * chunk, docs/styles/strokes.md). The scene sample is per cell
 * (`cell = floor(vUv · grid)`); everything about the surface comes from
 * `Surf s = surfaceAt(vUv)`. The paper grain
 * `g = 0.80 + 0.40·hash2(floor(p.x/2), floor(p.y/2))` is SCREEN space —
 * the paper is the screen and does not move with the world. Sky cells
 * paint `mix(PAPER_P, G, wash·g)` with `wash = daylight ≥ 0.5 ?
 * mix(0.04, 0.28, clamp(s.dirW.y, 0, 1)) : 0.45` plus
 * `hairInk(s.ps, 0.5)·0.35` hair. Surface cells paint
 * `mix(mix(PAPER_P, G, pencilWash(tone2, g)), G, ink)` with
 * `ink = max(primary, secondary)·(0.65 + 0.30·tone2)`; the cross-hatch
 * `secondary` gates on `smoothstep(0.45, 0.6, tone2)`. Outlines mix to
 * graphite at 0.7 — soft, never solid black. `daylight` is the only style
 * uniform; `viewUp`, `tanHalfFov` and `viewToWorld` come from the prelude.
 */
const PENCIL_FRAGMENT = `
uniform float daylight;
const vec3 PAPER_P = vec3(0.97, 0.96, 0.93);
const vec3 G = vec3(0.22, 0.22, 0.25);

void main() {
  vec2 p = vUv * grid;
  vec2 cell = floor(p);

  vec3 c = sampleSub(cell, 0.0, 0.0);
  float v = shaped(bright(c));
  float tone = 1.0 - v;
  // (The common block's tint / satF are computed exactly as scribble but
  // unused here — pencil is graphite, the one ink of the style; GLSL ES
  // 1.0 has no way to mark them used, so they are not declared.)

  // Everything before colouring: clamped taps, sky test, class, dPix,
  // W / nW, stroke coordinates + scale, one-sided outline.
  Surf s = surfaceAt(vUv);

  float tone2 = tone * depthFade(s.dC);

  // Paper grain: the paper is the SCREEN — it does not move with the
  // world. Per 2×2-px tooth, in [0.80, 1.20].
  float g = 0.80 + 0.40 * hash2(floor(p.x / 2.0), floor(p.y / 2.0));

  // Sky: pencilled sky — darker toward the zenith by day, an even grey
  // by night, with sparse hair strokes.
  if (s.cls == 0) {
    float wash = (daylight >= 0.5)
        ? mix(0.04, 0.28, clamp(s.dirW.y, 0.0, 1.0))
        : 0.45;
    vec3 outc = mix(PAPER_P, G, wash * g);
    outc = mix(outc, G, hairInk(s.ps, 0.5) * 0.35);
    gl_FragColor = vec4(outc, 1.0);
    return;
  }

  // Smudged tone wash under the strokes, modulated by the tooth.
  float washS = tone2 * 0.55 * g;
  vec3 base = mix(PAPER_P, G, washS);

  // Primary strokes: the shared world-anchored family with pencil's
  // wider, softer widths — hw = mu·(0.45 + 0.25·tone), edge ± 0.60·mu.
  float primary = nestedStrokeInk(s.u, s.along, tone2, s.mu, s.ma, 0.45, 0.25, 0.60);

  // Cross-hatch in the shade: the same family rotated 45° in stroke
  // space (u2 = (u+along)/√2, along2 = (along−u)/√2, mu2 = ma2 = (mu+ma)/2),
  // fading in past tone2 = 0.45.
  float u2 = (s.u + s.along) * 0.70710678;
  float along2 = (s.along - s.u) * 0.70710678;
  float mu2 = 0.5 * (s.mu + s.ma);
  float secondary = nestedStrokeInk(u2, along2, tone2, mu2, mu2, 0.45, 0.25, 0.60)
      * smoothstep(0.45, 0.60, tone2);

  float ink = max(primary, secondary) * (0.65 + 0.30 * tone2);

  vec3 outc = mix(base, G, ink);

  // Soft one-sided graphite outline — never solid black.
  if (s.outline) outc = mix(outc, G, 0.7);

  gl_FragColor = vec4(outc, 1.0);
}
`;

/**
 * Graphite pencil sketch on warm paper — smudged tone wash modulated by
 * the screen-space paper tooth, world-anchored nested-LOD strokes with
 * wider softer pencil widths, a 45° cross-hatch family in the shade,
 * soft graphite outlines and a zenith-darkened (day) / even grey (night)
 * pencilled sky with sparse hair. Cell 3×3, sub 1×1, depth.
 * `R` cycles, `?render=pencil`.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'pencil',
    label: 'PENCIL',
    cellW: 3,
    cellH: 3,
    subX: 1,
    subY: 1,
    needsDepth: true,
    groundGrid: false,
    fragment: STROKE_GLSL + PENCIL_FRAGMENT,
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
