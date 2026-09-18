/**
 * `crayon` render style (docs/architecture.md §4.11, wave 18 "sketch
 * family", "crayon" — coloured pencil, `T-0141`): the `pencil` shader
 * with colour. The graphite pencil strokes of `pencil` (soft wide cores
 * `hw = mu·(0.45 + 0.25·tone)`, AA `± 0.6·mu`, 45° cross-hatch in the
 * tone-0.45..0.6 band) are kept exactly, but the ink takes the hue of
 * the object under it: strokes mix from graphite toward `tint·0.60` by
 * `0.85·satF`, the paper wash is a per-tone coloured wash
 * (`crayonWash`), and the sky is a faint blue wash at day and a faint
 * violet at night. Cell 2×2, sub 1×1, `targetCap` 960×540,
 * `needsDepth: true`, `groundGrid: false`.
 *
 * The world-anchored stroke machinery is the shared chunk `./strokes.ts`:
 * `fragment: STROKE_GLSL + CRAYON_FRAGMENT`, and `main()` starts with
 * `Surf s = surfaceAt(vUv);`. The paper grain `g = toothOf(s)` is the
 * chunk's world-anchored (surfaces) / dome-anchored (sky) tooth
 * (§4.11 "anchored tooth"); colour formulas are unchanged. `pencil`
 * strokes per spec:
 * primary `nestedStrokeInk(s.u, s.along, tone2, s.mu, s.ma, 0.45, 0.25,
 * 0.60)`, secondary the same family rotated 45° in stroke space
 * (`u2 = (u + along)/√2`, `along2 = (along − u)/√2`, `mu2 = ma2 =
 * (mu + ma)/2`) gated by `smoothstep(0.45, 0.6, tone2)`,
 * `ink = max(·) · (0.65 + 0.30·tone2)`; outline `mix(out, G, 0.7)`.
 * This file keeps only the colours (`PAPER_P`, `G`, sky wash/hair
 * colours), the pure mirrors `crayonStroke` / `crayonWash`, the fragment
 * `main()` and `STYLES`.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { STROKE_GLSL } from './strokes';

/** GLSL `mix(a, b, t) = a + (b − a)·t`. */
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The white paper (shared with `pencil`, §4.11 `PAPER_P`). `[r, g, b]` in
 * `[0, 1]`.
 */
export const PAPER_P: readonly [number, number, number] = [0.97, 0.96, 0.93];

/**
 * The graphite dark: crayon strokes for grey things, the outline colour
 * and the night-sky hair ink (§4.11 `G`).
 */
export const G: readonly [number, number, number] = [0.22, 0.22, 0.25];

/**
 * Coloured-pencil stroke colour for a full-brightness tint (§4.11
 * `crayon` `crayonStroke`): `mix(G, tint·0.60, 0.85·satF)` — graphite for
 * grey things, the object's own hue for saturated things.
 */
export function crayonStroke(
  tint: readonly [number, number, number],
  satF: number,
): readonly [number, number, number] {
  const f = 0.85 * satF;
  return [
    mix(G[0], tint[0] * 0.6, f),
    mix(G[1], tint[1] * 0.6, f),
    mix(G[2], tint[2] * 0.6, f),
  ];
}

/**
 * Coloured-paper wash strength for (depth-faded) tone (§4.11 `crayon`
 * `crayonWash`): `0.45·satF·tone^0.7 + 0.20·(1−satF)·tone` — the pigment
 * washes in with tone, faster for saturated colours, and stays 0 on bare
 * paper (tone 0).
 */
export function crayonWash(tone: number, satF: number): number {
  return 0.45 * satF * Math.pow(tone, 0.7) + 0.2 * (1 - satF) * tone;
}

/**
 * §4.11 "crayon" fragment (the half after the shared `STROKE_GLSL`
 * chunk, docs/styles/strokes.md). `main()` starts with `Surf s =
 * surfaceAt(vUv)` and then takes `tone`, `tint`, `satF` exactly as
 * scribble, `tone2 = tone·depthFade(s.dC)`. The pencil strokes
 * (primary + 45° cross-hatch, widths `0.45, 0.25, 0.60`,
 * `ink = max(·)·(0.65 + 0.30·tone2)`) are mixed in `crayonStroke` over a
 * coloured paper wash `crayonWash·g`; the sky is a faint blue day wash /
 * violet night wash with pencil hair strokes. `daylight` is the only
 * style uniform; `viewUp`, `tanHalfFov` and `viewToWorld` come from the
 * prelude and are never redeclared.
 */
const CRAYON_FRAGMENT = `
uniform float daylight;
const vec3 PAPER_P = vec3(0.97, 0.96, 0.93);
const vec3 G = vec3(0.22, 0.22, 0.25);

void main() {
  vec2 p = vUv * grid;

  // Everything before colouring: clamped taps, sky test, class, dPix,
  // W / nW, stroke coordinates + scale, one-sided outline.
  Surf s = surfaceAt(vUv);

  // Paper grain: world-anchored on surfaces, dome-anchored on sky,
  // ≈ 2 px (§4.11 "anchored tooth").
  float g = toothOf(s);

  vec2 cell = floor(p);
  vec3 c = sampleSub(cell, 0.0, 0.0);
  float v = shaped(bright(c));
  float tone = 1.0 - v;
  vec3 tint = tintOf(c);
  float sat = max(max(tint.r, tint.g), tint.b) - min(min(tint.r, tint.g), tint.b);
  float satF = smoothstep(0.10, 0.45, sat);

  // Sky: a faint washed dome with pencil hair strokes (day blue, night
  // violet; hair in soft blue by day, graphite by night).
  if (s.cls == 0) {
    float hair = hairInk(s.ps, mix(0.75, 0.45, daylight));
    vec3 col;
    if (daylight >= 0.5) {
      col = mix(PAPER_P, vec3(0.55, 0.70, 0.95),
                0.25 * g * (0.4 + 0.6 * clamp(s.dirW.y, 0.0, 1.0)));
      col = mix(col, vec3(0.35, 0.45, 0.70), hair * 0.35);
    } else {
      col = mix(PAPER_P, vec3(0.25, 0.22, 0.45), 0.60 * g);
      col = mix(col, G, hair * 0.35);
    }
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  float tone2 = tone * depthFade(s.dC);

  // Pencil strokes: soft wide core hw = mu·(0.45 + 0.25·tone), AA
  // ± 0.6·mu; 45° cross-hatch in the tone-0.45..0.6 band; darker ink in
  // the darker cells.
  float primary = nestedStrokeInk(s.u, s.along, tone2, s.mu, s.ma, 0.45, 0.25, 0.60);
  float ink = primary;
  if (tone2 > 0.45) {
    const float INV_SQRT2 = 0.70710678;
    float u2 = (s.u + s.along) * INV_SQRT2;
    float along2 = (s.along - s.u) * INV_SQRT2;
    float mu2 = 0.5 * (s.mu + s.ma);
    ink = max(primary,
              nestedStrokeInk(u2, along2, tone2, mu2, mu2, 0.45, 0.25, 0.60)
                  * smoothstep(0.45, 0.6, tone2));
  }
  ink *= (0.65 + 0.30 * tone2);

  // Coloured pencil: the strokes take the object's hue; the paper itself
  // takes a per-tone coloured wash under the grain.
  vec3 strokeCol = mix(G, tint * 0.60, 0.85 * satF);
  float wash = 0.45 * satF * pow(tone2, 0.7) + 0.20 * (1.0 - satF) * tone2;
  vec3 base = mix(PAPER_P, mix(G, tint, satF), wash * g);
  vec3 col = mix(base, strokeCol, ink);
  if (s.outline) col = mix(col, G, 0.7);
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Coloured pencil — the pencil's graphite strokes and cross-hatch in
 * each object's own hue, paper that takes a per-tone coloured wash under
 * the world/dome-anchored tooth, soft blue day sky / violet night sky with
 * pencil hair, one-sided graphite outlines. Cell 2×2, sub 1×1, `targetCap`
 * 960×540, depth. `R` cycles, `?render=crayon`.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'crayon',
    label: 'CRAYON',
    cellW: 2,
    cellH: 2,
    subX: 1,
    subY: 1,
    targetCap: { w: 960, h: 540 },
    needsDepth: true,
    groundGrid: false,
    fragment: STROKE_GLSL + CRAYON_FRAGMENT,
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
