/**
 * `scribble` render style (docs/architecture.md §4.11, wave 17 T-0134, v2
 * T-0136, v3 T-0137, v4 T-0138; shared machinery extracted in T-0139): a
 * coloured-ink scribble sketch on white paper — tone carried by stroke
 * *density*, long wobbly pen strokes that follow the surface (vertical
 * world-lines on walls, constant-depth on the ground, short hair strokes
 * on the sky dome), ink coloured by the object under it, one-sided pencil
 * outlines, far buildings sketched lighter. Cell 3×3, sub 1×1,
 * `needsDepth: true`, `groundGrid: false`.
 *
 * Since T-0139 the world-anchored stroke machinery lives in the shared
 * chunk `./strokes.ts`: the fragment is `STROKE_GLSL + SCRIBBLE_FRAGMENT`,
 * and `main()` starts with `Surf s = surfaceAt(vUv);` (taps, sky test,
 * class, `dPix`, `W`, `nW`, `u`/`along`, `mu`/`ma`, one-sided outline),
 * then colours: `nestedStrokeInk(s.u, s.along, tone2, s.mu, s.ma, 0.30,
 * 0.20, 0.15)` — its v4 core `hw = mu·(0.30 + 0.20·tone)` with edge
 * `± 0.15·mu` — and the sky hair via `hairInk(s.ps, skyDensity(daylight))`.
 * This file keeps only the colours (`PAPER`, `INK`, `SKY_INK`),
 * `skyDensity`, the pure mirrors `surfaceClass` / `surfaceOutline` /
 * `inkColour` / `washColour`, the fragment `main()` and `STYLES`.
 */
import * as THREE from 'three';
import type { RenderStyle, StyleContext } from '../style';
import { isEdge } from './edges';
import { isNearSide } from './quest';
import { STROKE_GLSL, UP_K } from './strokes';

/** GLSL `mix(a, b, t) = a + (b − a)·t`. */
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** GLSL `smoothstep(edge0, edge1, x)`: clamped, Hermite-smoothed 0→1. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The white paper ground of the sketch (§4.11). `[r, g, b]` in `[0, 1]`.
 */
export const PAPER: readonly [number, number, number] = [0.98, 0.97, 0.94];

/** The neutral pen ink (§4.11); surfaces mix toward this for grey things. */
export const INK: readonly [number, number, number] = [0.12, 0.1, 0.12];

/** The sky hair-stroke ink (§4.11), a dim violet-grey. */
export const SKY_INK: readonly [number, number, number] = [0.15, 0.14, 0.18];

/** Sky-hair density (§4.11 v4 `skyDensity`): `mix(0.75, 0.45, daylight)`. */
export function skyDensity(daylight: number): number {
  return mix(0.75, 0.45, daylight);
}

/**
 * Surface class of a cell (§4.11 v2): `0` sky | `1` ground | `2` wall.
 * Sky if `dC ≥ 0.98·far`, else ground when `up > UP_K` (`up = |dot(n,
 * viewUp)|`), wall otherwise.
 */
export function surfaceClass(dC: number, far: number, up: number): 0 | 1 | 2 {
  if (dC >= 0.98 * far) return 0;
  return up > UP_K ? 1 : 2;
}

/**
 * One-sided outline gate (§4.11): true when the cell is a depth
 * discontinuity (`isEdge`, term for term) AND the nearer side of it
 * (`isNearSide` for at least one of the four neighbours `[dL, dR, dU, dD]`).
 * Such cells are fully inked in the surface ink colour; sky cells never
 * carry an outline.
 */
export function surfaceOutline(
  dC: number,
  neighbours: readonly [number, number, number, number],
  far: number,
): boolean {
  if (!isEdge(dC, neighbours, far)) return false;
  const skyThr = 0.98 * far;
  return (
    isNearSide(dC, neighbours[0], skyThr) ||
    isNearSide(dC, neighbours[1], skyThr) ||
    isNearSide(dC, neighbours[2], skyThr) ||
    isNearSide(dC, neighbours[3], skyThr)
  );
}

/**
 * Surface ink colour for a full-brightness tint (§4.11 v2 `inkColour`):
 * `mix(INK, tint · 0.50, 0.85·satF)` where
 * `satF = smoothstep(0.10, 0.45, sat)` — grey things get neutral black ink,
 * red things red ink.
 */
export function inkColour(tint: readonly [number, number, number]): readonly [number, number, number] {
  const sat = Math.max(tint[0], tint[1], tint[2]) - Math.min(tint[0], tint[1], tint[2]);
  const satF = smoothstep(0.1, 0.45, sat);
  return [
    mix(INK[0], tint[0] * 0.5, 0.85 * satF),
    mix(INK[1], tint[1] * 0.5, 0.85 * satF),
    mix(INK[2], tint[2] * 0.5, 0.85 * satF),
  ];
}

/**
 * Pale flat wash colour under the strokes (§4.11 v2 `washColour`):
 * `mix(PAPER, tint, 0.14·satF·min(1, tone·1.5))` — a light tint so most of
 * the paper stays white.
 */
export function washColour(
  tint: readonly [number, number, number],
  tone: number,
): readonly [number, number, number] {
  const sat = Math.max(tint[0], tint[1], tint[2]) - Math.min(tint[0], tint[1], tint[2]);
  const satF = smoothstep(0.1, 0.45, sat);
  const f = 0.14 * satF * Math.min(1, tone * 1.5);
  return [mix(PAPER[0], tint[0], f), mix(PAPER[1], tint[1], f), mix(PAPER[2], tint[2], f)];
}

/**
 * §4.11 "scribble" v4 fragment (the half after the shared `STROKE_GLSL`
 * chunk, docs/styles/strokes.md). The scene sample and the colours are per
 * cell (`cell = floor(vUv · grid)`); everything about the surface (taps,
 * sky test, class, `dPix`, `W`, `nW`, stroke coordinates/scale, one-sided
 * outline) comes from `Surf s = surfaceAt(vUv)`. Strokes are
 * `nestedStrokeInk(s.u, s.along, tone2, s.mu, s.ma, 0.30, 0.20, 0.15)` —
 * the v4 core `hw = mu·(0.30 + 0.20·tone)` with edge `± 0.15·mu`. Sky
 * cells paint `hairInk(s.ps, skyDensity(daylight))` in `SKY_INK` at 0.85.
 * `daylight` is the only style uniform; `viewUp`, `tanHalfFov` and
 * `viewToWorld` come from the prelude and are never redeclared.
 */
const SCRIBBLE_FRAGMENT = `
uniform float daylight;
const vec3 PAPER = vec3(0.98, 0.97, 0.94);
const vec3 INK = vec3(0.12, 0.10, 0.12);
const vec3 SKY_INK = vec3(0.15, 0.14, 0.18);

void main() {
  vec2 p = vUv * grid;
  vec2 cell = floor(p);

  vec3 c = sampleSub(cell, 0.0, 0.0);
  float v = shaped(bright(c));
  float tone = 1.0 - v;
  vec3 tint = tintOf(c);
  float sat = max(max(tint.r, tint.g), tint.b) - min(min(tint.r, tint.g), tint.b);
  float satF = smoothstep(0.10, 0.45, sat);

  // Everything before colouring: clamped taps, sky test, class, dPix,
  // W / nW, stroke coordinates + scale, one-sided outline.
  Surf s = surfaceAt(vUv);

  // Sky: short hair strokes on the dome (v4) whose density falls with
  // daylight.
  if (s.cls == 0) {
    float hair = hairInk(s.ps, mix(0.75, 0.45, daylight));
    gl_FragColor = vec4(mix(PAPER, SKY_INK, hair * 0.85), 1.0);
    return;
  }

  float tone2 = tone * depthFade(s.dC);

  // World-anchored nested-LOD strokes (v3/v4) with scribble's v4 widths:
  // hw = mu·(0.30 + 0.20·tone), edge ± 0.15·mu.
  float ink = nestedStrokeInk(s.u, s.along, tone2, s.mu, s.ma, 0.30, 0.20, 0.15);

  // One-sided pencil outline inks the whole cell.
  if (s.outline) ink = 1.0;

  vec3 inkCol = mix(INK, tint * 0.50, 0.85 * satF);
  vec3 washCol = mix(PAPER, tint, 0.14 * satF * min(1.0, tone2 * 1.5));
  gl_FragColor = vec4(mix(washCol, inkCol, ink), 1.0);
}
`;

/**
 * Coloured-ink scribble sketch on white paper — tone by stroke density,
 * world-anchored nested-LOD pen strokes (v3) scaled by the screen gradient
 * of `u`, following the surface (classed by view-space normal, v2),
 * per-pixel wall depth and world-metre value-noise wobble/lifts (v4),
 * stereographic sky-dome hair, one-sided pencil outlines, far buildings
 * sketched lighter. Cell 3×3, sub 1×1, depth. `R` cycles, `?render=scribble`.
 */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'scribble',
    label: 'SCRIBBLE',
    cellW: 3,
    cellH: 3,
    subX: 1,
    subY: 1,
    needsDepth: true,
    groundGrid: false,
    fragment: STROKE_GLSL + SCRIBBLE_FRAGMENT,
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
