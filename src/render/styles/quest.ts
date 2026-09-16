/**
 * `quest` render style (docs/architecture.md §4.11, wave 16, T-0124): the
 * 1993–98 SVGA-era fantasy look (Heroes of Might & Magic II, Baldur's Gate,
 * Diablo) — 640-wide, 256-colour, hand-painted. Cell 3×3, sub 1×1,
 * `needsDepth: true`. Every pixel lands on one of **12 painter's ramps of
 * 20 hue-shifted shades** (cool dark end → warm light end), a one-step
 * ordered dither between adjacent shades, soft dark outlines at depth
 * discontinuities, a subtle vignette, and a banded painted sky driven by
 * `StyleContext.daylight`. Pure helpers (`QUEST_RAMP_ENDS`,
 * `buildQuestRamps`, `QUEST_RAMPS`, `bayer8`, `rampFor`, `shadeIndex`,
 * `questSky`, `questVignette`) mirror the shader term for term and are
 * unit-tested in node.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';

/** Parse `RRGGBB` into a normalised `[r, g, b]` in `[0, 1]`. */
function hex(rrggbb: string): readonly [number, number, number] {
  const n = parseInt(rrggbb, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** `mix(a, b, t) = a + (b − a)·t`, the GLSL lerp the §4.11 ramps use. */
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** GLSL `smoothstep(edge0, edge1, x)`: clamped, Hermite-smoothed 0→1. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The 12 painter's ramps in §4.11 order, `{ name, dark, light }` with the
 * `RRGGBB` hex endpoints (the dark end is cooler, the light end warmer).
 * Shade `i` of ramp `r` is `mix(dark, light, (i / 19)^1.15)`.
 */
export const QUEST_RAMP_ENDS: readonly { name: string; dark: string; light: string }[] = [
  { name: 'stone', dark: '14161E', light: 'F4F2EC' },
  { name: 'marble', dark: '2A241E', light: 'FFF8E8' },
  { name: 'earth', dark: '1E1408', light: 'E0B888' },
  { name: 'wood', dark: '2A1206', light: 'FFC078' },
  { name: 'straw', dark: '2E2008', light: 'FFF0A0' },
  { name: 'forest', dark: '061A0E', light: 'A8E080' },
  { name: 'grass', dark: '0E2408', light: 'D8F080' },
  { name: 'sea', dark: '06181E', light: 'A0F0E8' },
  { name: 'sky', dark: '0C1E48', light: 'D8F0FF' },
  { name: 'night', dark: '06081C', light: '8090E0' },
  { name: 'crimson', dark: '2A0608', light: 'FFA090' },
  { name: 'violet', dark: '180C2A', light: 'E0B8FF' },
];

/**
 * Build the full 12 × 20 ramp table from {@link QUEST_RAMP_ENDS}: shade `i`
 * of ramp `r` is `mix(dark, light, (i / 19)^1.15)` — the slightly heavy
 * mid-tone curve of §4.11. Each entry is a normalised `[r, g, b]`.
 */
export function buildQuestRamps(): readonly (readonly (readonly [number, number, number])[])[] {
  const ramps: (readonly (readonly [number, number, number])[])[] = [];
  for (const { dark, light } of QUEST_RAMP_ENDS) {
    const d = hex(dark);
    const l = hex(light);
    const shades: (readonly [number, number, number])[] = [];
    for (let i = 0; i < 20; i++) {
      const f = Math.pow(i / 19, 1.15);
      shades.push([mix(d[0], l[0], f), mix(d[1], l[1], f), mix(d[2], l[2], f)]);
    }
    ramps.push(shades);
  }
  return ramps;
}

/** The 12 × 20 ramp table (§4.11); `QUEST_RAMPS[ramp][shade]` is a normalised RGB. */
export const QUEST_RAMPS = buildQuestRamps();

/** Hue at full brightness of a ramp colour (`c / max(bright(c), 0.02)`). */
function tintOf(c: readonly [number, number, number]): readonly [number, number, number] {
  const b = Math.max(c[0], c[1], c[2]);
  return [c[0] / Math.max(b, 0.02), c[1] / Math.max(b, 0.02), c[2] / Math.max(b, 0.02)];
}

/**
 * The selection tint of ramp `r`: `tintOf` of the ramp's **dark end**
 * (shade 0) — the ramp's purest, coolest signature hue. Used by
 * {@link rampFor} and, term for term, by the shader's `rampTint[11]`
 * uniform. NOTE: the ticket's acceptance test cases pin the selection to
 * the dark-end tint, not the "shade 14" of the §4.11 prose — flagged in the
 * Worker report.
 */
function rampTintOf(r: number): readonly [number, number, number] {
  return tintOf(QUEST_RAMPS[r][0]);
}

/**
 * Bayer8 threshold at cell `(x, y)` (integer, non-negative; wraps mod 8),
 * from the recursive construction `M8[y][x] = M4[y>>1][x>>1] +
 * 16·M2[y&1][x&1]` with `M2 = [[0, 2], [3, 1]]`. Returns one of 64 distinct
 * values `(0.5/64, 1.5/64, …, 63.5/64)`, strictly inside `(0, 1)`. The
 * shader computes the same value inline from `M2`.
 */
export function bayer8(x: number, y: number): number {
  const M2: readonly (readonly number[])[] = [
    [0, 2],
    [3, 1],
  ];
  const m4at = (cx: number, cy: number): number =>
    M2[cy >> 1][cx >> 1] + 4 * M2[cy & 1][cx & 1];
  const bx = ((Math.floor(x) % 8) + 8) % 8;
  const by = ((Math.floor(y) % 8) + 8) % 8;
  return (m4at(bx >> 1, by >> 1) + 16 * M2[by & 1][bx & 1] + 0.5) / 64;
}

/**
 * Ramp index (0–11) for a full-brightness tint: `0` (stone) when the tint's
 * chroma `max − min < 0.12`, else the nearest of ramps 1–11 by **squared
 * RGB** distance between `tint` and each ramp's selection tint
 * ({@link rampTintOf}); ties break to the lower index.
 */
export function rampFor(tint: readonly [number, number, number]): number {
  const [r, g, b] = tint;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  if (sat < 0.12) return 0;
  let bestR = 1;
  let bestDist = Infinity;
  for (let rr = 1; rr <= 11; rr++) {
    const [tr, tg, tb] = rampTintOf(rr);
    const dr = r - tr;
    const dg = g - tg;
    const db = b - tb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestR = rr;
    }
  }
  return bestR;
}

/**
 * Shade index (0–19) for a shaped brightness `v` and dither offset `d`:
 * `clamp(floor(v · 20 + d), 0, 19)` — the one-step ordered dither of §4.11.
 */
export function shadeIndex(v: number, d: number): number {
  return Math.min(19, Math.max(0, Math.floor(v * 20 + d)));
}

/**
 * Pre-dither sky ramp + shade for a daylight factor and vertical position
 * `y01` in `[0, 1]` (§4.11 "Sky cells"): `s = smoothstep(0.35, 0.95, y01)`;
 * daylight ≥ 0.66 → sky ramp 8, `round(mix(17, 8, s))`; ≥ 0.33 → violet
 * ramp 11, `round(mix(15, 6, s))`; else night ramp 9, `round(mix(9, 2, s))`.
 */
export function questSky(
  daylight: number,
  y01: number,
): { ramp: number; index: number } {
  const s = smoothstep(0.35, 0.95, y01);
  let ramp: number;
  let index: number;
  if (daylight >= 0.66) {
    ramp = 8;
    index = Math.round(mix(17, 8, s));
  } else if (daylight >= 0.33) {
    ramp = 11;
    index = Math.round(mix(15, 6, s));
  } else {
    ramp = 9;
    index = Math.round(mix(9, 2, s));
  }
  return { ramp, index };
}

/**
 * Vignette multiplier at cell position `p` (normalised `[x, y]` in
 * `[0, 1]`): `1 − 0.25 · smoothstep(0.5, 1.0, length(p − 0.5) · 1.5)` —
 * 1 dead centre, 0.75 in the corners (§4.11).
 */
export function questVignette(p: readonly [number, number]): number {
  const len = Math.hypot(p[0] - 0.5, p[1] - 0.5) * 1.5;
  return 1 - 0.25 * smoothstep(0.5, 1.0, len);
}

/**
 * §4.11 "quest" fragment. `qRamps` is the 20×12 ramp `sampler2D` sampled at
 * `((i + 0.5) / 20, (ramp + 0.5) / 12)`; `rampTint[11]` holds the 11 ramp
 * selection tints ({@link rampTintOf}, mirroring {@link rampFor} term for
 * term); `daylight` is the `StyleContext.daylight` uniform. `bayer8` is
 * computed inline from `M2` exactly as {@link bayer8}. The outline block is
 * the `edges` test term for term with `isEdge`, except the four neighbour
 * samples sit one *sub-sample* apart (`stepUv = 1.0 / sceneSize`, matching
 * `edges.ts`), making the dark outlines one pixel thick. Sky cells paint
 * the banded painted sky from `daylight`, with the same one-step dither.
 */
const QUEST_FRAGMENT = `
uniform vec3 rampTint[11];
uniform float daylight;
uniform sampler2D qRamps;
const float QUEST_EDGE_K = 0.02;
const float QUEST_SKY_FRAC = 0.98;
float bayer2(float x, float y) {
  float a = step(0.5, x);
  float b = step(0.5, y);
  return mix(mix(0.0, 3.0, b), mix(2.0, 1.0, b), a);
}
float bayer8(float x, float y) {
  float x8 = mod(x, 8.0);
  float y8 = mod(y, 8.0);
  float xHi = floor(x8 * 0.5);
  float yHi = floor(y8 * 0.5);
  float xLo = mod(x8, 2.0);
  float yLo = mod(y8, 2.0);
  float m4 = bayer2(floor(xHi * 0.5), floor(yHi * 0.5)) + 4.0 * bayer2(mod(xHi, 2.0), mod(yHi, 2.0));
  return (m4 + 16.0 * bayer2(xLo, yLo) + 0.5) / 64.0;
}
void main() {
  vec2 cell = floor(vUv * grid);
  vec2 p = vUv;
  vec3 c = pow(clamp(sampleSub(cell, 0.0, 0.0), 0.0, 1.0), vec3(gamma));

  // Vignette then shaped brightness: v = bright(c) * vig.
  float vig = 1.0 - 0.25 * smoothstep(0.5, 1.0, length(p - 0.5) * 1.5);
  float v = bright(c) * vig;

  // Ramp selection: stone below the chroma floor, else nearest ramp 1..11.
  vec3 t = tintOf(c);
  float sat = max(max(t.r, t.g), t.b) - min(min(t.r, t.g), t.b);
  int ramp = 0;
  if (sat >= 0.12) {
    float bestDist = 1e9;
    int bestR = 1;
    for (int r = 1; r < 12; r++) {
      vec3 dd = t - rampTint[r - 1];
      float dist = dot(dd, dd);
      if (dist < bestDist) { bestDist = dist; bestR = r; }
    }
    ramp = bestR;
  }

  // One-step ordered dither into a shade.
  float d = bayer8(cell.x, cell.y) - 0.5;
  int i = clamp(int(floor(v * 20.0 + d)), 0, 19);

  // Outline: the edges rule with one-sub-sample-apart samples (1 px ink).
  vec2 centreUv = (cell + 0.5) / grid;
  vec2 stepUv = 1.0 / sceneSize;
  float dC = linearDepth(centreUv);
  float dL = linearDepth(centreUv + vec2(-stepUv.x, 0.0));
  float dR = linearDepth(centreUv + vec2( stepUv.x, 0.0));
  float dU = linearDepth(centreUv + vec2(0.0,  stepUv.y));
  float dD = linearDepth(centreUv + vec2(0.0, -stepUv.y));
  float skyThr = QUEST_SKY_FRAC * cameraFar;
  bool cSky = dC >= skyThr;
  bool edge = false;
  if (cSky != (dL >= skyThr)) edge = true;
  if (cSky != (dR >= skyThr)) edge = true;
  if (cSky != (dU >= skyThr)) edge = true;
  if (cSky != (dD >= skyThr)) edge = true;
  if (!edge && !cSky) {
    float wC = 1.0 / dC;
    float wL = 1.0 / dL;
    float wR = 1.0 / dR;
    float wU = 1.0 / dU;
    float wD = 1.0 / dD;
    if (abs(wL + wR - 2.0 * wC) > QUEST_EDGE_K * wC) edge = true;
    if (abs(wU + wD - 2.0 * wC) > QUEST_EDGE_K * wC) edge = true;
  }

  // Soft dark outline: pull the shade down five steps (never below 0).
  if (edge) i = max(0, i - 5);

  // Sky cells (not edges) paint the banded painted sky from daylight.
  int outRamp = ramp;
  int outI = i;
  if (cSky && !edge) {
    float s = smoothstep(0.35, 0.95, p.y);
    if (daylight >= 0.66) {
      outRamp = 8;
      outI = int(round(mix(17.0, 8.0, s)));
    } else if (daylight >= 0.33) {
      outRamp = 11;
      outI = int(round(mix(15.0, 6.0, s)));
    } else {
      outRamp = 9;
      outI = int(round(mix(9.0, 2.0, s)));
    }
    outI = clamp(outI + int(round(d * 1.0)), 0, 19);
  }

  vec2 rampUv = vec2((float(outI) + 0.5) / 20.0, (float(outRamp) + 0.5) / 12.0);
  gl_FragColor = vec4(texture2D(qRamps, rampUv).rgb, 1.0);
}
`;

/** Ramp table as a 20×12 RGB texture (no canvas needed), one ramp per row. */
function makeRampTexture(): THREE.DataTexture {
  const width = 20;
  const height = 12;
  const data = new Uint8Array(width * height * 4);
  for (let ramp = 0; ramp < height; ramp++) {
    for (let i = 0; i < width; i++) {
      const [r, g, b] = QUEST_RAMPS[ramp][i];
      const off = (ramp * width + i) * 4;
      data[off] = Math.round(r * 255);
      data[off + 1] = Math.round(g * 255);
      data[off + 2] = Math.round(b * 255);
      data[off + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * SVGA-era fantasy look — 12 painter's ramps × 20 shades, one-step ordered
 * dither, soft dark outlines, vignette, banded painted sky. Cell 3×3,
 * sub 1×1, depth. `R` cycles, `?render=quest`.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'quest',
    label: 'QUEST',
    cellW: 3,
    cellH: 3,
    subX: 1,
    subY: 1,
    needsDepth: true,
    fragment: QUEST_FRAGMENT,
    makeUniforms(ctx: StyleContext): Record<string, THREE.IUniform> {
      const rampTints: THREE.Vector3[] = [];
      for (let r = 1; r <= 11; r++) {
        const [tr, tg, tb] = rampTintOf(r);
        rampTints.push(new THREE.Vector3(tr, tg, tb));
      }
      return {
        qRamps: { value: makeRampTexture() },
        rampTint: { value: rampTints },
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
    dispose(uniforms: Record<string, THREE.IUniform>): void {
      const tex = uniforms.qRamps.value;
      if (tex instanceof THREE.DataTexture) tex.dispose();
    },
  },
];
