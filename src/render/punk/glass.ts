/**
 * Rain on the lens (wave 20): drops slide down the screen with trails,
 * refracting the frame behind them.
 *
 * LICENCE — derivative work: a TSL port by ektogamat/threejs-conference
 * (`src/tsl/rainGlass.js`, MIT) of rocksdanister/rain
 * (https://github.com/rocksdanister/rain), itself after Martijn Steinrucken
 * (BigWings) "Heartfelt". rocksdanister/rain is licensed CC BY-NC-SA 3.0
 * Unported, whose ShareAlike term permits later versions with the same
 * elements; this adaptation is distributed, like the whole project, under
 * CC BY-NC-SA 4.0 (see LICENSE). Keep this credit when reusing it.
 *
 * Changes from the upstream port: the base image is the sharp frame (the
 * intro version blurred everything behind the glass); only the drops show
 * the blurred, refracted frame.
 */
import {
  Fn,
  abs,
  convertToTexture,
  dot,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  pow,
  screenCoordinate,
  screenSize,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import type { Node } from 'three/webgpu';

const N13 = Fn(([p]: [Node<'float'>]) => {
  const p3 = fract(vec3(p, p, p).mul(vec3(0.1031, 0.11369, 0.13787))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(19.19)));
  return fract(vec3(p3.x.add(p3.y).mul(p3.z), p3.x.add(p3.z).mul(p3.y), p3.y.add(p3.z).mul(p3.x)));
});

const N = Fn(([t]: [Node<'float'>]) => fract(sin(t.mul(12345.564)).mul(7658.76)));

const Saw = Fn(([b, t]: [Node<'float'>, Node<'float'>]) =>
  smoothstep(float(0), b, t).mul(smoothstep(float(1), b, t)),
);

const MovingDropLayer = Fn(([uvIn, t, size]: [Node<'vec2'>, Node<'float'>, Node<'float'>]) => {
  const UV = uvIn;
  const uvv = uvIn.toVar();
  const movingTime = t.mul(0.15);
  uvv.y.addAssign(movingTime.mul(0.75));
  const a = vec2(4, 2);
  const grid = a.mul(2);
  const id0 = floor(uvv.mul(grid));
  uvv.y.addAssign(N(id0.x));
  const id = floor(uvv.mul(grid));
  const n = N13(id.x.mul(35.2).add(id.y.mul(2376.1)));
  const st = fract(uvv.mul(grid)).sub(vec2(0.5, 0));
  const x0 = n.x.sub(0.5);
  const yWiggle = UV.y.mul(10);
  const wiggle = sin(yWiggle.add(sin(yWiggle)));
  const x = x0.add(wiggle.mul(float(0.5).sub(abs(x0))).mul(n.z.sub(0.5))).mul(0.7);
  const ti = fract(movingTime.add(n.z));
  const yDrop = Saw(float(0.85), ti).sub(0.5).mul(0.9).add(0.5);
  const p = vec2(x, yDrop);
  const d = length(st.sub(p).mul(a.yx));
  const mainDrop = pow(smoothstep(float(0.9).mul(size), float(0), d), float(2));
  const r = sqrt(smoothstep(float(1), yDrop, st.y));
  const cd = abs(st.x.sub(x));
  const trail = smoothstep(float(0.23).mul(r).mul(size), float(0.15).mul(r).mul(r).mul(size), cd)
    .mul(smoothstep(float(-0.02).mul(size), float(0.02).mul(size), st.y.sub(yDrop)))
    .mul(r)
    .mul(r);
  const trailFront = smoothstep(float(-0.02).mul(size), float(0.02).mul(size), st.y.sub(yDrop));
  const dropletY = fract(UV.y.mul(10)).add(st.y.sub(0.5));
  const dd = length(st.sub(vec2(x, dropletY)));
  const droplets = smoothstep(float(0.4).mul(size), float(0), dd);
  const m = mainDrop.add(droplets.mul(r).mul(trailFront));
  const edge = float(1).sub(d).mul(0.5);
  return vec2(m.add(trail.mul(0.35)), edge);
});

const StaticDrops = Fn(([uvIn, t, size]: [Node<'vec2'>, Node<'float'>, Node<'float'>]) => {
  const uv40 = uvIn.mul(40);
  const id = floor(uv40);
  const cuv = fract(uv40).sub(0.5);
  const n = N13(id.x.mul(107.45).add(id.y.mul(3543.654)));
  const p = n.xy.sub(0.5).mul(0.7);
  const d = length(cuv.sub(p));
  const fade = Saw(float(0.025), fract(t.add(n.z)));
  return pow(smoothstep(float(0.4).mul(size), float(0), d), float(1.8)).mul(fract(n.z.mul(10))).mul(fade);
});

const Drops = Fn(
  ([uvIn, t, l0, l1, size]: [Node<'vec2'>, Node<'float'>, Node<'float'>, Node<'float'>, Node<'float'>]) => {
    const s = StaticDrops(uvIn, t, size).mul(l0);
    const m1 = MovingDropLayer(uvIn, t, size);
    const m2 = MovingDropLayer(uvIn.mul(1.85), t, size);
    const c = smoothstep(float(0.3), float(1), s.add(m1.x).add(m2.x));
    return vec2(c, max(m1.y.mul(l0), m2.y.mul(l1)));
  },
);

/** Tunables for the lens rain (live uniforms). */
export function createGlassUniforms() {
  return {
    time: uniform(0),
    speed: uniform(1),
    intensity: uniform(0.3),
    distortion: uniform(0.28),
    dropSize: uniform(0.5),
    blurRadius: uniform(2.5),
  };
}

/** Uniform bag returned by {@link createGlassUniforms}. */
export type GlassUniforms = ReturnType<typeof createGlassUniforms>;

/** Composite drops over `sceneColor` (a vec4 node). */
export function applyRainGlass(sceneColor: Node<'vec4'>, u: GlassUniforms): Node<'vec4'> {
  const sharp = convertToTexture(sceneColor);
  const blurred = convertToTexture(gaussianBlur(sceneColor, u.blurRadius, 2, { resolutionScale: 0.5 }));
  return Fn(() => {
    const UV = screenUV;
    const aspectUv = vec2(
      screenCoordinate.x.sub(screenSize.x.mul(0.5)).div(screenSize.y),
      screenSize.y.mul(0.5).sub(screenCoordinate.y).div(screenSize.y),
    );
    const t = u.time.mul(0.2).mul(u.speed);
    const amount = u.intensity;
    const size = u.dropSize;
    // Fewer static beads than the intro version: as a steady layer they read as grit.
    const staticDrops = smoothstep(float(-0.5), float(1), amount).mul(0.6);
    const layer1 = smoothstep(float(0.25), float(0.75), amount);
    const layer2 = smoothstep(float(0), float(0.5), amount);
    const c = Drops(aspectUv, t, staticDrops, layer1, size);
    const e = vec2(0.005, 0);
    const cx = Drops(aspectUv.add(e), t, staticDrops, layer1, size).x;
    const cy = Drops(aspectUv.add(e.yx), t, staticDrops, layer1, size).x;
    const n = vec2(cx.sub(c.x), c.x.sub(cy)).mul(3.5);
    const distorted = UV.add(n.mul(u.distortion).mul(size).mul(c.x.mul(0.5).add(1)));
    const refr = blurred.sample(distorted).rgb.toVar();
    const k = c.x.mul(0.1).mul(u.distortion).mul(size);
    refr.assign(vec3(refr.r.add(n.x.mul(k)), refr.g.add(n.y.mul(k)), refr.b));
    refr.mulAssign(c.x.mul(0.2).add(1));
    refr.addAssign(pow(c.y, float(2)).mul(0.25).mul(c.x.oneMinus()).mul(layer2));
    const base = sharp.sample(UV);
    return vec4(mix(base.rgb, refr, c.x.mul(0.85)), base.a);
  })();
}
