/**
 * `lowpoly` render style (docs/architecture.md §4.11, wave 15): the
 * *Money for Nothing* '80s-CGI look — crude flat-shaded facets, big square
 * pixels, eight screaming saturated hues plus a grey ramp, and thick black
 * outlines where polygons meet. Cell 6×6, sub 2×2, `needsDepth: true`;
 * the fragment flattens every cell to one of the 8-hue × 4-band (or grey ×
 * band) combinations and inks the cells whose depth test (imported
 * {@link isEdge}, sampled one CELL apart) fires; sky cells get a flat
 * period sky from `StyleContext.daylight` (wave 15b, T-0122). Pure helpers
 * (`LOWPOLY_HUES`, `LOWPOLY_LUM`, `LOWPOLY_INK`, `LOWPOLY_SKY`,
 * `posterLevel`, `snapHue`, `lowpolyColour`, `skyBand`) mirror the shader
 * term for term; unit-tested in node.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { isEdge } from './edges';

/** Parse `RRGGBB` into a normalised `[r, g, b]` in `[0, 1]`. */
function hex(rrggbb: string): readonly [number, number, number] {
  const n = parseInt(rrggbb, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/**
 * The 8 lowpoly hues in §4.11 order (red, orange, yellow, lime, cyan,
 * blue, purple, magenta); `snapHue` ties break to the lower index.
 */
export const LOWPOLY_HUES: readonly (readonly [number, number, number])[] = [
  hex('FF3030'), hex('FF7A20'), hex('FFE040'), hex('70E040'),
  hex('30E0E0'), hex('3060FF'), hex('9040FF'), hex('FF40C0'),
];

/** Flat-shading luminance ramp, one entry per band 0–3 (§4.11). */
export const LOWPOLY_LUM: readonly [number, number, number, number] = [0.22, 0.50, 0.78, 1.0];

/** Ink colour written on outline cells (§4.11). */
export const LOWPOLY_INK: readonly [number, number, number] = [0.02, 0.02, 0.04];

/**
 * The three flat period-sky colours in §4.11 "Sky cells" order: night
 * navy `#10143C`, dusk/dawn pink `#E0508F`, day blue `#3A8CFF`.
 */
export const LOWPOLY_SKY: readonly (readonly [number, number, number])[] = [
  hex('10143C'), hex('E0508F'), hex('3A8CFF'),
];

/**
 * Period-sky band for a daylight factor in `[0, 1]`: `0` night,
 * `1` dusk/dawn, `2` day — the thresholds of §4.11 "Sky cells".
 */
export function skyBand(daylight: number): number {
  return daylight < 0.33 ? 0 : daylight < 0.66 ? 1 : 2;
}

/**
 * Shading band for a shaped brightness `v` in `[0, 1]`: `min(3, floor(v·4))`
 * — the four flat bands of §4.11.
 */
export function posterLevel(v: number): number {
  return Math.min(3, Math.floor(v * 4));
}

/**
 * Hue index for a full-brightness tint (squared-RGB nearest of
 * `LOWPOLY_HUES`, ties → lower index), or `-1` when the tint's chroma
 * `max − min` is below 0.25 (the grey ramp branch).
 */
export function snapHue(tint: readonly [number, number, number]): number {
  const [r, g, b] = tint;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  if (sat < 0.25) return -1;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < LOWPOLY_HUES.length; i++) {
    const [hr, hg, hb] = LOWPOLY_HUES[i];
    const dr = r - hr;
    const dg = g - hg;
    const db = b - hb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Whole non-edge path of §4.11 from an exposed RGB sample: clamp,
 * `level = posterLevel(shaped(bright))`, snap `tintOf(c)` to a hue (or the
 * grey ramp), and return `hue · LOWPOLY_LUM[level]`.
 */
export function lowpolyColour(
  exposed: readonly [number, number, number],
  gamma: number,
): [number, number, number] {
  const c: [number, number, number] = [
    Math.min(1, Math.max(0, exposed[0])),
    Math.min(1, Math.max(0, exposed[1])),
    Math.min(1, Math.max(0, exposed[2])),
  ];
  const bright = Math.max(c[0], c[1], c[2]);
  const lum = LOWPOLY_LUM[posterLevel(bright ** gamma)];
  const t: [number, number, number] = [c[0] / Math.max(bright, 0.02), c[1] / Math.max(bright, 0.02), c[2] / Math.max(bright, 0.02)];
  const idx = snapHue(t);
  const hue: readonly [number, number, number] = idx < 0 ? [1, 1, 1] : LOWPOLY_HUES[idx];
  return [hue[0] * lum, hue[1] * lum, hue[2] * lum];
}

/**
 * Outline test for a lowpoly cell: the `edges` rule ({@link isEdge}) on
 * `linearDepth` samples taken one CELL apart in each cardinal — the shader
 * runs the same test with `stepUv = 1.0 / grid`.
 */
export function isLowpolyEdge(
  dC: number,
  neighbours: readonly [number, number, number, number],
  far: number,
): boolean {
  return isEdge(dC, neighbours, far);
}

/**
 * §4.11 "lowpoly" fragment. `lpHues[8]` is a `vec3` array uniform filled
 * from `LOWPOLY_HUES` in `makeUniforms`; the 8-iteration nearest-hue scan
 * uses a constant-index `for` like the PICO-8 palette scan. The outline
 * block is the `edges` test term for term with `isEdge` ({@link
 * isLowpolyEdge}), except the four neighbour samples sit one cell away
 * (`stepUv = 1.0 / grid`), making the ink lines one cell (6 px) thick.
 * Sky cells (wave 15b) paint `lpSky[band]` with `band = daylight < 0.33 ?
 * 0 : (daylight < 0.66 ? 1 : 2)`; sky edges keep the ink.
 */
const LOWPOLY_FRAGMENT = `
uniform vec3 lpHues[8];
uniform vec3 lpSky[3];
uniform float daylight;
const float LOWPOLY_EDGE_K = 0.02;
const float LOWPOLY_SKY_FRAC = 0.98;
void main() {
  vec2 cell = floor(vUv * grid);
  // 2x2 cell mean averages the window texture away — facets read flat.
  vec3 c = clamp(cellMean(cell), 0.0, 1.0);
  float v = shaped(bright(c));
  float level = min(3.0, floor(v * 4.0));
  float lum = level < 1.0 ? 0.22 : (level < 2.0 ? 0.50 : (level < 3.0 ? 0.78 : 1.0));
  vec3 t = tintOf(c);
  float sat = max(max(t.r, t.g), t.b) - min(min(t.r, t.g), t.b);
  vec3 hue = vec3(1.0);
  if (sat >= 0.25) {
    // Prime with lpHues[0]; the remaining 7 entries are the real candidates.
    vec3 dInit = t - lpHues[0];
    float bestDist = dot(dInit, dInit);
    vec3 best = lpHues[0];
    for (int i = 1; i < 8; i++) {
      vec3 d = t - lpHues[i];
      float dist = dot(d, d);
      if (dist < bestDist) {
        bestDist = dist;
        best = lpHues[i];
      }
    }
    hue = best;
  }
  vec3 col = hue * lum;

  // Outline: the edges rule with one-CELL-apart samples (6 px thick ink).
  vec2 centreUv = (cell + 0.5) / grid;
  vec2 stepUv = 1.0 / grid;
  float dC = linearDepth(centreUv);
  float dL = linearDepth(centreUv + vec2(-stepUv.x, 0.0));
  float dR = linearDepth(centreUv + vec2( stepUv.x, 0.0));
  float dU = linearDepth(centreUv + vec2(0.0,  stepUv.y));
  float dD = linearDepth(centreUv + vec2(0.0, -stepUv.y));
  float skyThr = LOWPOLY_SKY_FRAC * cameraFar;
  bool cSky = dC >= skyThr;
  bool edge = false;

  // Sky rule, term for term with isEdge.
  if (cSky != (dL >= skyThr)) edge = true;
  if (cSky != (dR >= skyThr)) edge = true;
  if (cSky != (dU >= skyThr)) edge = true;
  if (cSky != (dD >= skyThr)) edge = true;

  // Inverse-depth second difference over non-sky samples.
  if (!edge && !cSky) {
    float wC = 1.0 / dC;
    float wL = 1.0 / dL;
    float wR = 1.0 / dR;
    float wU = 1.0 / dU;
    float wD = 1.0 / dD;
    if (abs(wL + wR - 2.0 * wC) > LOWPOLY_EDGE_K * wC) edge = true;
    if (abs(wU + wD - 2.0 * wC) > LOWPOLY_EDGE_K * wC) edge = true;
  }

  // Period sky (T-0122): flat band by daylight; edges keep the ink.
  vec3 outCol;
  if (edge) {
    outCol = vec3(0.02, 0.02, 0.04);
  } else if (cSky) {
    int band = daylight < 0.33 ? 0 : (daylight < 0.66 ? 1 : 2);
    outCol = lpSky[band];
  } else {
    outCol = col;
  }
  gl_FragColor = vec4(outCol, 1.0);
}
`;

/**
 * '80s-CGI flat-facet + ink-outline + flat period sky (from `ctx.daylight`)
 * look, cell 6×6, sub 2×2, depth. `R` cycles, `?render=lowpoly`.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'lowpoly',
    label: 'LOWPOLY',
    cellW: 6,
    cellH: 6,
    subX: 2,
    subY: 2,
    needsDepth: true,
    fragment: LOWPOLY_FRAGMENT,
    makeUniforms(ctx: StyleContext): Record<string, THREE.IUniform> {
      const lpHues = LOWPOLY_HUES.map(([r, g, b]) => new THREE.Vector3(r, g, b));
      const lpSky = LOWPOLY_SKY.map(([r, g, b]) => new THREE.Vector3(r, g, b));
      return {
        lpHues: { value: lpHues },
        lpSky: { value: lpSky },
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
