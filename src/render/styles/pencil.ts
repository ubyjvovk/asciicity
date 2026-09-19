/**
 * `pencil` render style (docs/architecture.md §4.11, wave 18c T-0147
 * "Pencil / crayon v2 — quick drawing"): a graphite sketch on warm
 * paper — blank sky, blank horizontals with a shadow-pool smudge,
 * smoothed 3×3 tone, hatch only in dark wall facets (one stroke
 * direction per facade), strong silhouettes. Cell 2×2, sub 1×1,
 * `targetCap` 960×540, `needsDepth: true`, `groundGrid: false`.
 *
 * Built on the shared chunk (`./strokes.ts`): `fragment: STROKE_GLSL +
 * PENCIL_FRAGMENT`. The stroke / shading GLSL block (wrapped in the
 * RULES markers) is byte-identical in `crayon.ts` — only the colour
 * lines after it differ. `daylight` is the only style uniform; prelude
 * uniforms are never redeclared.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { STROKE_GLSL, hash2 } from './strokes';

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
 * 45°-rotated stroke space (§4.11 `crossCoords`): the same
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

/** GLSL `smoothstep(edge0, edge1, x)`: clamped, Hermite-smoothed 0→1. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Horizontal-surface shadow pool (§4.11 v2 `smudgeOf`): `0.30 · g · smoothstep(0.55, 0.95, toneS)`. */
export function smudgeOf(toneS: number, g: number): number {
  return 0.3 * g * smoothstep(0.55, 0.95, toneS);
}

/** Wall tone wash (§4.11 v2 `wallWash`): `0.35 · g · smoothstep(0.20, 0.90, toneS)`. */
export function wallWash(toneS: number, g: number): number {
  return 0.35 * g * smoothstep(0.2, 0.9, toneS);
}

/** Hatch-in-shadow × distance gate (§4.11 v2 `hatchGate`): `smoothstep(0.50, 0.75, toneS) · (1 − smoothstep(150, 400, dC))`. */
export function hatchGate(toneS: number, dC: number): number {
  return smoothstep(0.5, 0.75, toneS) * (1 - smoothstep(150, 400, dC));
}

/** One stroke direction per facade (§4.11 v2 `facadeDir`): `0` vertical family, `1` 45° family. */
export function facadeDir(
  nW: readonly [number, number, number],
  W: readonly [number, number, number],
): 0 | 1 {
  const sel = hash2(
    Math.floor(nW[0] * 4) + Math.floor(nW[2] * 4) * 9,
    Math.floor((W[0] + W[2]) / 40),
  );
  return sel < 0.5 ? 0 : 1;
}

/**
 * §4.11 wave-18c "Pencil / crayon v2 — quick drawing" fragment (the
 * half after the shared `STROKE_GLSL` chunk). `main()` starts with
 * `Surf s = surfaceAt(vUv)` and `g = toothOf(s)`. The six rules live
 * in the marked RULES GLSL block (byte-identical in `crayon.ts`): sky
 * is paper; horizontals are paper + smudge; tone is the 3×3-smoothed
 * `toneS`; walls wash + one-direction hatch in shadow; contrasting
 * 2-cell outlines (silhouette 1.0 / crease 0.7). Pencil then mixes
 * toward graphite `G`. `daylight` is the only style uniform; prelude
 * uniforms are never redeclared.
 */
const PENCIL_FRAGMENT = `
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

  vec3 washCol = G;
  vec3 strokeCol = G;
  vec3 outc = mix(PAPER_P, washCol, s.cls == 1 ? smudge : wash);
  if (s.cls == 2) outc = mix(outc, strokeCol, ink);
  outc = mix(outc, G, strength * e);
  gl_FragColor = vec4(outc, 1.0);
}
`;

/**
 * Graphite quick-drawing on warm paper — blank sky, blank horizontals
 * with a shadow-pool smudge, smoothed tone, one-direction hatch in
 * shadowed facades, strong silhouettes. Cell 2×2, sub 1×1,
 * `targetCap` 960×540, depth. `R` cycles, `?render=pencil`.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'pencil',
    label: 'PENCIL',
    cellW: 2,
    cellH: 2,
    subX: 1,
    subY: 1,
    targetCap: { w: 960, h: 540 },
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
