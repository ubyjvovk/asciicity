/**
 * `crayon` render style (docs/architecture.md §4.11, wave 18c T-0147
 * "Pencil / crayon v2 — quick drawing"): the `pencil` shader with
 * colour. The six-rule stroke / shading block is byte-identical; only
 * the colour lines differ — `strokeCol` and wash colour
 * `mix(G, tint, satF)`. Sky is paper. Cell 2×2, sub 1×1,
 * `targetCap` 960×540, `needsDepth: true`, `groundGrid: false`.
 *
 * The world-anchored stroke machinery is the shared chunk `./strokes.ts`:
 * `fragment: STROKE_GLSL + CRAYON_FRAGMENT`. This file keeps the colours
 * (`PAPER_P`, `G`), the pure mirrors `crayonStroke` / `crayonWash`, the
 * re-exported `smudgeOf` / `wallWash` / `hatchGate` / `facadeDir` (from
 * `pencil`), the fragment `main()` and `STYLES`.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { STROKE_GLSL } from './strokes';

/**
 * Horizontal smudge, wall wash, hatch gate and facade direction
 * (§4.11 "Pencil / crayon v2"). Defined in `pencil.ts`; crayon
 * re-exports the same functions and applies the identical GLSL block.
 */
export { facadeDir, hatchGate, smudgeOf, wallWash } from './pencil';

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
 * (§4.11 `G`).
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
 * §4.11 wave-18c "Pencil / crayon v2 — quick drawing" fragment (the
 * half after the shared `STROKE_GLSL` chunk). The marked RULES GLSL
 * block is byte-identical to `pencil.ts`. After it, crayon mixes
 * `strokeCol` over wash colour `mix(G, tint, satF)` (from the 3×3
 * mean). `daylight` is the only style uniform; prelude uniforms are
 * never redeclared.
 */
const CRAYON_FRAGMENT = `
uniform float daylight;
const vec3 PAPER_P = vec3(0.97, 0.96, 0.93);
const vec3 G = vec3(0.22, 0.22, 0.25);

void main() {
  vec2 p = vUv * grid;
  vec2 cell = floor(p);

  // RULES BEGIN
  Surf s = surfaceAt(vUv);
  float g = toothOf(s);

  // 1. SKY = paper. No hair, no wash.
  if (s.cls == 0) {
    gl_FragColor = vec4(PAPER_P, 1.0);
    return;
  }

  // 3. SMOOTHED TONE: 3×3 mean of sampleSub (9 taps).
  vec3 acc = vec3(0.0);
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      acc += sampleSub(cell + vec2(float(ox), float(oy)), 0.0, 0.0);
    }
  }
  vec3 meanC = acc / 9.0;
  float toneS = (1.0 - shaped(bright(meanC))) * depthFade(s.dC);

  // 2. HORIZONTAL SURFACES: paper + smudge only (no strokes).
  float smudge = 0.30 * g * smoothstep(0.55, 0.95, toneS);

  // 4. WALLS: white + wash + hatch only in the dark; one direction per facade.
  float wash = 0.35 * g * smoothstep(0.20, 0.90, toneS);
  float ink = 0.0;
  if (s.cls == 2) {
    float sel = hash2(floor(s.nW.x * 4.0) + floor(s.nW.z * 4.0) * 9.0,
                      floor((s.W.x + s.W.z) / 40.0));
    float u1 = s.u;
    float along1 = s.along;
    float mu1 = s.mu;
    float ma1 = s.ma;
    if (sel >= 0.5) {
      u1 = (s.u + s.along) * 0.70710678;
      along1 = (s.along - s.u) * 0.70710678;
      mu1 = 0.5 * (s.mu + s.ma);
      ma1 = mu1;
    }
    float hatch = nestedStrokeInk(u1, along1, toneS, mu1, ma1, 0.45, 0.25, 0.60)
        * smoothstep(0.50, 0.75, toneS)
        * (1.0 - smoothstep(150.0, 400.0, s.dC));
    ink = hatch * (0.60 + 0.30 * toneS);
  }

  // 5. CONTRASTING EDGES: max of outlineAt over the cell and its 4 neighbours
  // (2-cell line). Silhouette against sky (any neighbour is sky) → 1.0, crease → 0.7.
  float e = outlineAt(vUv);
  e = max(e, outlineAt(vUv + vec2(-1.0, 0.0) / grid));
  e = max(e, outlineAt(vUv + vec2( 1.0, 0.0) / grid));
  e = max(e, outlineAt(vUv + vec2(0.0,  1.0) / grid));
  e = max(e, outlineAt(vUv + vec2(0.0, -1.0) / grid));
  vec2 texel = 1.0 / sceneSize;
  vec2 centreUv = (cell * sub + 0.5) * texel;
  vec2 stepUv = sub * texel;
  vec2 lo = 0.5 * texel;
  vec2 hi = 1.0 - 0.5 * texel;
  float skyThr = 0.98 * cameraFar;
  bool sil =
      linearDepth(clamp(centreUv - vec2(stepUv.x, 0.0), lo, hi)) >= skyThr ||
      linearDepth(clamp(centreUv + vec2(stepUv.x, 0.0), lo, hi)) >= skyThr ||
      linearDepth(clamp(centreUv + vec2(0.0, stepUv.y), lo, hi)) >= skyThr ||
      linearDepth(clamp(centreUv - vec2(0.0, stepUv.y), lo, hi)) >= skyThr;
  float strength = sil ? 1.0 : 0.7;
  // RULES END

  vec3 tint = tintOf(meanC);
  float sat = max(max(tint.r, tint.g), tint.b) - min(min(tint.r, tint.g), tint.b);
  float satF = smoothstep(0.10, 0.45, sat);
  vec3 washCol = mix(G, tint, satF);
  vec3 strokeCol = mix(G, tint * 0.60, 0.85 * satF);
  vec3 outc = mix(PAPER_P, washCol, s.cls == 1 ? smudge : wash);
  if (s.cls == 2) outc = mix(outc, strokeCol, ink);
  outc = mix(outc, G, strength * e);
  gl_FragColor = vec4(outc, 1.0);
}
`;

/**
 * Coloured-pencil quick-drawing — the pencil six-rule sketch in each
 * object's own hue (strokeCol / wash colour `mix(G, tint, satF)`),
 * blank paper sky, blank horizontals with a tinted shadow-pool smudge,
 * one-direction hatch in shadowed facades, graphite silhouettes. Cell
 * 2×2, sub 1×1, `targetCap` 960×540, depth. `R` cycles, `?render=crayon`.
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
