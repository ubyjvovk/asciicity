/**
 * `lowpoly` render style (docs/architecture.md §4.11, wave 15 + v2 T-0129):
 * the *Money for Nothing* '80s-CGI look — crude flat-shaded facets, big
 * square pixels, and thick black outlines where polygons meet. Cell 6×6,
 * sub 2×2, `needsDepth: true`. **v2 (T-0129)** makes it *upbeat and
 * shiny*: brighter bands, pastel hues, cool-chrome greys and a specular
 * shine band, plus a texel-centre depth sampling fix that kills the
 * full-width horizontal ink seam rows. The fragment flattens every cell to
 * one of the 8 pastel-hue × 4-band (or chrome-grey × band) combinations,
 * mixes the brightest cells toward white, and inks the cells whose depth
 * test (imported {@link isEdge}, sampled one CELL apart at texel centres)
 * fires; sky cells get a flat period sky from `StyleContext.daylight`
 * (wave 15b, T-0122). Pure helpers (`LOWPOLY_HUES`, `LOWPOLY_LUM`,
 * `LOWPOLY_INK`, `LOWPOLY_SKY`, `LOWPOLY_SHINE`, `LOWPOLY_GREY`,
 * `LOWPOLY_PASTEL`, `posterLevel`, `snapHue`, `lowpolyColour`,
 * `lowpolyPaletteSet`, `skyBand`) mirror the shader term for term;
 * unit-tested in node.
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

/** Flat-shading luminance ramp, one entry per band 0–3 (§4.11 v2). */
export const LOWPOLY_LUM: readonly [number, number, number, number] = [0.45, 0.65, 0.85, 1.0];

/** Ink colour written on outline cells (§4.11). */
export const LOWPOLY_INK: readonly [number, number, number] = [0.02, 0.02, 0.04];

/** Specular shine factor applied to the brightest cells (`v ≥ 0.92`, §4.11 v2). */
export const LOWPOLY_SHINE = 0.75;

/** Cool chrome grey used by the low-chroma branch (§4.11 v2). */
export const LOWPOLY_GREY: readonly [number, number, number] = [0.88, 0.92, 0.97];

/** Amount each saturated hue is mixed toward white to go pastel (§4.11 v2). */
export const LOWPOLY_PASTEL = 0.12;

/**
 * The three flat period-sky colours in §4.11 "Sky cells" order: night
 * navy `#1A2060`, dusk/dawn pink `#FF6FA8`, day blue `#4FA8FF`.
 */
export const LOWPOLY_SKY: readonly (readonly [number, number, number])[] = [
  hex('1A2060'), hex('FF6FA8'), hex('4FA8FF'),
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

/** `a + (b − a)·t` — GLSL `mix`, per channel, on `[0, 1]` triples. */
function mixc(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * Whole non-edge path of §4.11 v2 from an exposed RGB sample: clamp,
 * `level = posterLevel(shaped(bright))`, snap `tintOf(c)` to a pastel hue
 * (`mix(LOWPOLY_HUES[idx], (1, 1, 1), LOWPOLY_PASTEL)`) or the cool-chrome
 * `LOWPOLY_GREY`, multiply by `LOWPOLY_LUM[level]`, then mix toward white
 * by `LOWPOLY_SHINE` when `v ≥ 0.92` (the specular pop on the brightest
 * cells).
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
  const v = bright ** gamma;
  const lum = LOWPOLY_LUM[posterLevel(v)];
  const t: [number, number, number] = [c[0] / Math.max(bright, 0.02), c[1] / Math.max(bright, 0.02), c[2] / Math.max(bright, 0.02)];
  const idx = snapHue(t);
  const hue: readonly [number, number, number] =
    idx < 0 ? LOWPOLY_GREY : mixc(LOWPOLY_HUES[idx], [1, 1, 1], LOWPOLY_PASTEL);
  let col: [number, number, number] = [hue[0] * lum, hue[1] * lum, hue[2] * lum];
  const shine = v >= 0.92 ? LOWPOLY_SHINE : 0;
  if (shine > 0) col = mixc(col, [1, 1, 1], shine);
  return col;
}

/**
 * Every colour the style can write to a non-sky pixel — the §4.11 v2
 * expected set: `lowpolyColour` over the 9 tints (8 `LOWPOLY_HUES` + grey)
 * × 4 bands (non-shine) plus the 9 shine variants (band 3 with `v = 1`),
 * then the three `LOWPOLY_SKY` bands, `LOWPOLY_INK` and black. Built purely
 * from `lowpolyColour`/`LOWPOLY_HUES`/`LOWPOLY_LUM`/`LOWPOLY_SKY`/
 * `LOWPOLY_INK` — never by hand — so the e2e purity check and the unit
 * tests stay in lock-step with the shader. The first `LOWPOLY_HUES.length ×
 * LOWPOLY_LUM.length` entries are the 8 hue × 4 band colours in hue-major
 * order (hue attribution in the e2e depends on it).
 */
export function lowpolyPaletteSet(): readonly (readonly [number, number, number])[] {
  const set: [number, number, number][] = [];
  const GAMMA = 0.45;
  // One `v = bright^gamma` per band (0..3), all below the 0.92 shine
  // threshold, so `posterLevel` picks the band without triggering shine.
  const bandV: readonly number[] = [0.2, 0.4, 0.65, 0.85];
  const tints: readonly (readonly [number, number, number])[] = [
    ...LOWPOLY_HUES,
    [1, 1, 1], // grey template: saturation 0 → chrome-grey ramp
  ];
  for (const tint of tints) {
    const brightTint = Math.max(tint[0], tint[1], tint[2]);
    for (const v of bandV) {
      // Scale the tint so `shaped(bright)` lands exactly in the band;
      // `tintOf(c)` still returns the (normalised) hue → same snap.
      const k = v ** (1 / GAMMA) / brightTint;
      set.push(lowpolyColour([tint[0] * k, tint[1] * k, tint[2] * k], GAMMA));
    }
    // Shine variant: v = 1 (≥ 0.92) → lum 1.0 + the white shine mix.
    const kShine = 1 / brightTint;
    set.push(lowpolyColour([tint[0] * kShine, tint[1] * kShine, tint[2] * kShine], GAMMA));
  }
  for (const sky of LOWPOLY_SKY) set.push([...sky]);
  set.push([...LOWPOLY_INK]);
  set.push([0, 0, 0]);
  return set;
}

/**
 * Outline test for a lowpoly cell: the `edges` rule ({@link isEdge}) on
 * `linearDepth` samples taken one CELL apart in each cardinal — the shader
 * runs the same test with one-cell-apart samples at texel centres
 * (`stepUv = sub / sceneSize`, `centreUv = (cell·sub + 0.5) / sceneSize`).
 */
export function isLowpolyEdge(
  dC: number,
  neighbours: readonly [number, number, number, number],
  far: number,
): boolean {
  return isEdge(dC, neighbours, far);
}

/**
 * §4.11 "lowpoly" v2 fragment. `lpHues[8]` is a `vec3` array uniform filled
 * from `LOWPOLY_HUES` in `makeUniforms`; the 8-iteration nearest-hue scan
 * uses a constant-index `for` like the PICO-8 palette scan. Pastel hues
 * (`mix` toward white by `LOWPOLY_PASTEL`), a cool-chrome `LOWPOLY_GREY`
 * low-chroma branch, and a specular shine mix toward white when
 * `v ≥ 0.92` (mirrors {@link lowpolyColour} term for term). The outline
 * block is the `edges` test term for term with `isEdge` ({@link
 * isLowpolyEdge}), except the four neighbour samples sit one cell away and
 * are read at **texel centres** (`centreUv = (cell·sub + 0.5)·texel`),
 * which keeps the depth samples off the sub-2×2 texel seam and removes the
 * v1 full-width horizontal ink rows. Sky cells (wave 15b) paint
 * `lpSky[band]` with `band = daylight < 0.33 ? 0 : (daylight < 0.66 ? 1 :
 * 2)`; sky edges keep the ink.
 */
const LOWPOLY_FRAGMENT = `
uniform vec3 lpHues[8];
uniform vec3 lpSky[3];
uniform float daylight;
const float LOWPOLY_SHINE = 0.75;
const float LOWPOLY_PASTEL = 0.12;
const vec3 LOWPOLY_GREY = vec3(0.88, 0.92, 0.97);
const float LOWPOLY_EDGE_K = 0.02;
const float LOWPOLY_SKY_FRAC = 0.98;
void main() {
  vec2 cell = floor(vUv * grid);
  // 2x2 cell mean averages the window texture away — facets read flat.
  vec3 c = clamp(cellMean(cell), 0.0, 1.0);
  float v = shaped(bright(c));
  float level = min(3.0, floor(v * 4.0));
  float lum = level < 1.0 ? 0.45 : (level < 2.0 ? 0.65 : (level < 3.0 ? 0.85 : 1.0));
  vec3 t = tintOf(c);
  float sat = max(max(t.r, t.g), t.b) - min(min(t.r, t.g), t.b);
  vec3 hue = LOWPOLY_GREY;
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
    hue = mix(best, vec3(1.0), LOWPOLY_PASTEL);
  }
  vec3 col = hue * lum;
  float shine = v >= 0.92 ? LOWPOLY_SHINE : 0.0;
  col = mix(col, vec3(1.0), shine);

  // Outline: the edges rule with one-CELL-apart samples at texel centres.
  vec2 texel = 1.0 / sceneSize;
  vec2 centreUv = (cell * sub + 0.5) * texel;
  vec2 stepUv = sub * texel;
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
 * look with the v2 pastel/chrome/shine path, cell 6×6, sub 2×2, depth. `R`
 * cycles, `?render=lowpoly`.
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
