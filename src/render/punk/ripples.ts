/**
 * Rain ripples (wave 20): a 3×3-cell field of expanding rings whose
 * derivative perturbs the normal of wet horizontal surfaces.
 *
 * Ported from ektogamat/threejs-conference `src/tsl/rainRipples.js` (MIT,
 * © 2026 Anderson Mancini and Sunag), itself after the well-known "rain
 * ripples" Shadertoy pattern (hash12 / hash22 by Dave Hoskins).
 */
import {
  Fn,
  dot,
  float,
  floor,
  fract,
  length,
  max,
  normalize,
  sin,
  smoothstep,
  sqrt,
  vec2,
  vec3,
  vec4,
  cameraViewMatrix,
  normalWorld,
  positionWorld,
} from 'three/tsl';
import type { Node } from 'three/webgpu';

const MAX_RADIUS = 1;
const CELL_COUNT = (MAX_RADIUS * 2 + 1) ** 2;

const hash12 = Fn(([p]: [Node<'vec2'>]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(19.19)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

const hash22 = Fn(([p]: [Node<'vec2'>]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(19.19)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

/**
 * Ripple normal (tangent-space xy + z) at `uv` (world xz × scale) for the
 * running time `t` (seconds × speed).
 */
export const rainRipples = Fn(([uvIn, t]: [Node<'vec2'>, Node<'float'>]) => {
  const p0 = floor(uvIn);
  const circles = vec2(0).toVar();
  // 3×3 neighbourhood, unrolled at graph-build time.
  for (let i = -MAX_RADIUS; i <= MAX_RADIUS; i++) {
    for (let j = -MAX_RADIUS; j <= MAX_RADIUS; j++) {
      const pi = p0.add(vec2(i, j));
      const p = pi.add(hash22(pi));
      const tt = fract(t.mul(0.3).add(hash12(pi)));
      const v = p.sub(uvIn);
      const d = length(v).sub(float(MAX_RADIUS + 1).mul(tt));
      const h = 0.001;
      const d1 = d.sub(h);
      const d2 = d.add(h);
      const p1 = sin(d1.mul(31)).mul(smoothstep(-0.6, -0.3, d1)).mul(smoothstep(0, -0.3, d1));
      const p2 = sin(d2.mul(31)).mul(smoothstep(-0.6, -0.3, d2)).mul(smoothstep(0, -0.3, d2));
      const fade = tt.oneMinus().mul(tt.oneMinus());
      circles.addAssign(normalize(v).mul(p2.sub(p1).div(2 * h).mul(fade).mul(0.5)));
    }
  }
  const c = circles.div(CELL_COUNT);
  return vec3(c, sqrt(max(float(1).sub(dot(c, c)), 0)));
});

/** Shared time / rain uniforms every wet material reads (owned by `WetDressing`). */
export interface WetUniforms {
  /** Seconds since the view started. */
  uTime: Node<'float'>;
  /** 1 while raining, 0 when the rain is off (fades ripples out). */
  uRain: Node<'float'>;
}

/**
 * View-space normal for a wet surface: the geometric normal plus ripple
 * rings (world xz × `scale`) on upward-facing parts only, `strength` ~0–1.5.
 * Assign to `material.normalNode`. PM-frozen: facade.ts and street.ts both use it.
 */
export function rippleNormal(u: WetUniforms, scale: number, strength: Node<'float'>): Node<'vec3'> {
  const r = rainRipples(positionWorld.xz.mul(scale), u.uTime.mul(3));
  const up = smoothstep(0.6, 0.9, normalWorld.y);
  const n = normalize(normalWorld.add(vec3(r.x, 0, r.y).mul(strength).mul(up).mul(u.uRain)));
  return normalize(cameraViewMatrix.mul(vec4(n, 0)).xyz);
}
