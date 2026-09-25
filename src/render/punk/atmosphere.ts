/**
 * Cyberpunk atmosphere (wave 20b): analytic height fog, fog-weighted wide
 * light halos, horizon light pollution and drifting ground mist over the
 * upstream distance fog. T-0157. The pure maths live in `fogmath.ts` (same
 * constants + closed forms); the TSL graph here mirrors them.
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Atmosphere".
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  convertToTexture,
  float,
  getViewPosition,
  length,
  max,
  mix,
  screenUV,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { H, MIST_H, MIST_MAX, RHO0_BASE } from './fogmath';
import { fbm2Node } from './noise';

/** Look-driven fog uniforms (set by `pipeline.applyLook` from `look.ts`). */
export interface FogUniforms {
  fogEnabled: UniformNode<'float', number>;
  fogNear: UniformNode<'float', number>;
  fogFar: UniformNode<'float', number>;
  fogColor: UniformNode<'vec3', THREE.Vector3>;
  fogAmount: UniformNode<'float', number>;
  fogBloomSuppress: UniformNode<'float', number>;
}

/** Everything the atmosphere may read. All texture nodes sample the scene pass at `screenUV`. */
export interface AtmosphereInputs {
  /** Scene colour (+ SSR), linear HDR. */
  beauty: Node<'vec4'>;
  /** Bloom + lens flare of the emissive layer (already blurred). */
  bloom: Node<'vec4'>;
  /** The raw emissive MRT attachment (texture node) — source for wider halos. */
  emissive: Node<'vec4'>;
  /** View-space z of the scene pass (negative in front of the camera). */
  viewZ: Node<'float'>;
  /** Linear depth 0 (near) … 1 (far plane / sky). */
  linearDepth: Node<'float'>;
  /** Raw depth-buffer value (for `getViewPosition`). */
  depth: Node<'float'>;
  /** Camera world matrix (uniform, refreshed every frame by the pipeline). */
  cameraWorld: UniformNode<'mat4', THREE.Matrix4>;
  /** Camera projection-inverse (uniform, refreshed every frame by the pipeline). */
  projectionInverse: UniformNode<'mat4', THREE.Matrix4>;
  fog: FogUniforms;
}

/** The atmosphere's output and its per-frame hook. */
export interface Atmosphere {
  /** Fogged beauty with the bloom composited in (linear HDR, pre-grade). */
  rgb: Node<'vec3'>;
  /** Per-frame hook (animated mist etc.). */
  update(camera: THREE.PerspectiveCamera, timeS: number): void;
  /** Flat numeric stats for `__asciicity.punk.stats()` (prefix `atmosphere.`). */
  stats(): Record<string, number>;
}

/** Eye height above the ground reference (`y0 = camera.y − EYE_HEIGHT`). */
const EYE_HEIGHT = 1.7;

/** Wide-halo Gaussian radius in ¼-res texels (≈ 3 % of screen height). */
const HALO_SIGMA = 2;

/** Ground-mist value-noise frequency (≈ 12 m features). */
const MIST_SCALE = 0.08;

/** Ground-mist horizontal drift (m/s). */
const MIST_DRIFT = 0.3;

/** Horizon light-pollution band: taps around the horizon row, fade at 30°. */
const HORIZON_TAPS = 5;
const HORIZON_STEP = 0.002;

/** Small-`delta` threshold below which the height fog uses its horizontal limit. */
const DELTA_EPS = 1e-3;

/** Build the atmosphere node graph. */
export function createAtmosphere(i: AtmosphereInputs): Atmosphere {
  const u = i.fog;
  const camY = uniform(0);
  const timeS = uniform(0);

  // World-space reconstruction of every pixel (for height fog + mist).
  const viewPos = getViewPosition(screenUV, i.depth, i.projectionInverse);
  const worldPos = i.cameraWorld.mul(vec4(viewPos, 1));
  const pY = worldPos.y;
  const dist = length(viewPos);
  const y0 = camY.sub(float(EYE_HEIGHT));

  // Analytic height-fog transmittance along the view ray (mirrors fogmath).
  const rho0 = u.fogAmount.mul(float(RHO0_BASE));
  const delta = pY.sub(camY).div(float(H));
  // (1 − exp(−delta)) / delta, with the horizontal limit for |delta| → 0.
  const avg = mix(
    float(1),
    float(1).sub(delta.negate().exp()).div(delta),
    step(float(DELTA_EPS), delta.abs()),
  );
  const base = camY.sub(y0).negate().div(float(H)).exp();
  const tau = rho0.mul(dist).mul(base).mul(avg);
  const heightFog = float(1).sub(tau.negate().exp());

  // Wide halo of the emissive layer at ¼ resolution (cheap, one blur).
  const wideHalo = convertToTexture(gaussianBlur(i.emissive, float(HALO_SIGMA), 4, { resolutionScale: 0.25 }));

  // Distance + sky + height fog combined by max(), then gated as before.
  const viewDistance = i.viewZ.negate();
  const lookDist = smoothstep(u.fogNear, u.fogFar, viewDistance);
  const skyFog = smoothstep(float(0.98), float(1.0), i.linearDepth);
  const fogAmountNode = max(max(lookDist, heightFog), skyFog);
  const fogBlend = fogAmountNode.mul(u.fogEnabled);
  const fogAmt = fogBlend.mul(u.fogAmount);

  // Ray's world up-component: fade the horizon glow to 0 at 30° above it.
  const rayUp = pY.sub(camY).div(dist);
  const skyFade = float(1).sub(smoothstep(float(0), float(0.5), rayUp));

  const rgb = Fn(() => {
    const fogged = mix(i.beauty.rgb, u.fogColor, fogAmt);

    // Fog-weighted wide halo: more fog → wider, brighter glow.
    const haloAdd = wideHalo.rgb.mul(float(0.25).add(fogAmt));

    // Horizon light pollution: mean blurred emissive along the horizon row.
    const glowSum = vec3(0).toVar();
    for (let k = -2; k <= 2; k++) {
      const uv = vec2(screenUV.x, float(0.5).add(float(k * HORIZON_STEP)));
      glowSum.addAssign(wideHalo.sample(uv).rgb);
    }
    const horizonGlow = glowSum.div(float(HORIZON_TAPS)).mul(skyFade).mul(step(float(0.98), i.linearDepth));

    // Drifting low ground mist (2-octave value noise, opacity ≤ MIST_MAX).
    const mistBand = float(1).sub(smoothstep(float(0), float(MIST_H), pY.sub(y0)));
    const mistNoise = fbm2Node(
      worldPos.xz.mul(float(MIST_SCALE)).add(vec2(timeS.mul(float(MIST_DRIFT)), float(0))),
    );
    const mist = mistBand.mul(mistNoise).mul(float(MIST_MAX)).mul(u.fogEnabled);

    return fogged
      .add(i.bloom.rgb.mul(float(1).sub(fogBlend.mul(u.fogBloomSuppress))))
      .add(haloAdd)
      .add(horizonGlow)
      .add(u.fogColor.mul(mist));
  })();

  let lastCamY = 0;
  return {
    rgb,
    update: (camera: THREE.PerspectiveCamera, timeS_: number) => {
      lastCamY = camera.position.y;
      camY.value = camera.position.y;
      timeS.value = timeS_;
    },
    stats: () => ({
      h: H,
      rho0Base: RHO0_BASE,
      mistH: MIST_H,
      mistMax: MIST_MAX,
      camY: lastCamY,
    }),
  };
}
